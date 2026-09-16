import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import { hostname } from "node:os";
import type { Readable, Writable } from "node:stream";
import { existsSync } from "node:fs";
import { isWindows, socketPath } from "@whale-cal/shared/paths";
import type { Command, Event } from "@whale-cal/shared/protocol";
import type { CalendarPatch, EventDraft, EventPatch } from "@whale-cal/shared/types";
import { spawnSshProxy, validateSshAlias, type SshProcess } from "./ssh-transport";
import { connectionProfile, type ConnectionProfile } from "@whale-cal/shared/connections";
import { httpWire } from "./http-transport";

export interface RouteEvent {
  type: "route_status";
  mode: "local" | "remote";
  state: "connected" | "switching" | "failed";
  alias?: string;
  switched: boolean;
  retained?: boolean;
  message: string;
}

export type ClientEvent = Event | RouteEvent;

interface Wire {
  input: Writable;
  output: Readable;
  diagnostics?: Readable;
  emitter: { on(event: string, listener: (...args: any[]) => void): unknown; off(event: string, listener: (...args: any[]) => void): unknown };
  close(): void;
  label: string;
}

interface ProbedWire { wire: Wire; buffered: string; stderr: string }

function localWire(path: string): Promise<Wire> {
  return new Promise((resolve, reject) => {
    if (!isWindows && !existsSync(path)) { reject(new Error(`cald socket not found at ${path}`)); return; }
    const socket: Socket = connect(path);
    let settled = false;
    socket.once("connect", () => {
      settled = true;
      socket.setNoDelay(true);
      resolve({ input: socket, output: socket, emitter: socket, close: () => socket.destroy(), label: path });
    });
    socket.once("error", error => { if (!settled) reject(new Error(`cannot connect to cald: ${error.message}`)); });
  });
}

function sshWire(alias: string): Promise<Wire> {
  return new Promise((resolve, reject) => {
    let process: SshProcess;
    try { process = spawnSshProxy(alias); }
    catch (error) { reject(error); return; }
    let settled = false;
    process.once("spawn", () => {
      settled = true;
      resolve({
        input: process.stdin, output: process.stdout, diagnostics: process.stderr, emitter: process,
        close: () => { try { process.stdin.end(); } catch {} try { process.kill(); } catch {} }, label: alias,
      });
    });
    process.once("error", error => { if (!settled) reject(error); });
  });
}

async function probe(wirePromise: Promise<Wire>, timeoutMs = 15_000, token?: string): Promise<ProbedWire> {
  const wire = await wirePromise;
  const reqId = `probe_${randomUUID()}`;
  return new Promise((resolve, reject) => {
    let buffer = "", stderr = "", done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      wire.output.off("data", onData);
      wire.diagnostics?.off("data", onDiagnostic);
      wire.emitter.off("close", onClose);
      wire.emitter.off("error", onError);
      if (error) { wire.close(); reject(error); }
      else { wire.output.pause(); resolve({ wire, buffered: buffer, stderr }); }
    };
    const onDiagnostic = (chunk: Buffer | string) => {
      stderr = (stderr + chunk.toString()).slice(-8192);
    };
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try {
          const value = JSON.parse(line) as Event;
          if (value.type === "error") { finish(new Error(value.message)); return; }
          if (value.type === "pong" && value.reqId === reqId) { finish(); return; }
        } catch { finish(new Error("daemon proxy returned non-protocol output")); return; }
      }
    };
    const suffix = () => stderr.trim() ? `: ${stderr.trim()}` : "";
    const onClose = () => finish(new Error(`connection closed before cald replied${suffix()}`));
    const onError = (error: Error) => finish(new Error(`${error.message}${suffix()}`));
    const timer = setTimeout(() => finish(new Error(`timed out waiting for cald${suffix()}`)), timeoutMs);
    wire.output.on("data", onData);
    wire.diagnostics?.on("data", onDiagnostic);
    wire.emitter.on("close", onClose);
    wire.emitter.on("error", onError);
    if (token) wire.input.write(JSON.stringify({ type: "authenticate", reqId: `${reqId}_auth`, token }) + "\n");
    wire.input.write(JSON.stringify({ type: "probe", reqId }) + "\n");
  });
}

export class DaemonClient {
  private wire: Wire | null = null;
  private buffer = "";
  private generation = 0;
  private pending: Command[] = [];
  private reconnecting = false;
  private alias: string | null = null;
  private switchInProgress = false;
  private disconnectHandler: (() => void) | null = null;
  private profile: ConnectionProfile;
  private revision = -1;
  private readonly localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  constructor(private readonly handler: (event: ClientEvent) => void, private readonly path = socketPath(), profile?: ConnectionProfile) {
    this.profile = profile ?? (path !== socketPath() ? { name: "local", socket: path } : connectionProfile());
  }

  get connected(): boolean { return !!this.wire; }
  get remoteAlias(): string | null { return this.alias ?? (this.profile.url ? `http:${this.profile.name}` : null); }

  onDisconnect(handler: () => void): void { this.disconnectHandler = handler; }

  async connect(): Promise<void> {
    if (this.reconnecting || this.wire) return;
    this.reconnecting = true;
    try {
      const target = this.alias ? sshWire(this.alias) : this.profile.url ? httpWire(this.profile) : localWire(this.profile.socket ?? this.path);
      const result = await probe(target, 15_000, this.alias || this.profile.url ? undefined : this.profile.token);
      this.adopt(result, false);
    } finally { this.reconnecting = false; }
  }

  private adopt(probed: ProbedWire, switched: boolean): void {
    const old = this.wire;
    const wire = probed.wire;
    const generation = ++this.generation;
    this.wire = wire;
    this.revision = -1;
    this.buffer = "";
    const onData = (chunk: Buffer | string) => {
      if (this.wire !== wire || generation !== this.generation) return;
      this.consume(chunk.toString());
    };
    const onClose = () => {
      if (this.wire !== wire || generation !== this.generation) return;
      this.wire = null;
      const label = this.remoteAlias ?? `local ${hostname()}`;
      this.handler({ type: "route_status", mode: this.remoteAlias ? "remote" : "local", state: "failed", ...(this.remoteAlias ? { alias: this.remoteAlias } : {}), switched: false, message: `Connection to ${label} was lost.` });
      this.disconnectHandler?.();
    };
    wire.output.on("data", onData);
    wire.emitter.on("close", onClose);
    wire.emitter.on("error", onClose);
    if (probed.buffered) this.consume(probed.buffered);
    wire.output.resume();
    this.status(switched);
    this.write({ type: "bootstrap" });
    this.write({ type: "whoami", reqId: randomUUID() });
    this.pending = []; // Never move queued writes across routes or reconnects.
    if (old && old !== wire) old.close();
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const event = JSON.parse(line) as Event;
        if (event.type === "bootstrap") {
          // HTTP replies and SSE use separate channels. An older snapshot may
          // arrive after a newer live mutation; never roll the view backwards.
          if (event.database.revision < this.revision) continue;
          this.revision = event.database.revision;
          process.env.TZ = event.database.timeZone ?? this.localTimeZone;
        }
        else if ("revision" in event) this.revision = Math.max(this.revision, event.revision);
        if (event.type !== "daemon_shutdown") this.handler(event);
      } catch { this.handler({ type: "error", message: "Daemon sent invalid JSON." }); }
    }
  }

  private write(command: Command): void {
    const mutation = /^(create|update|delete|complete)_/.test(command.type);
    if (!this.wire || (mutation && (this.switchInProgress || this.revision < 0))) {
      this.handler({ type: "error", ...("reqId" in command ? { reqId: command.reqId } : {}), message: "Not connected or switching servers. Edit was not queued." });
      return;
    }
    const payload = mutation && this.revision >= 0 ? { ...command, ifRevision: this.revision } : command;
    try { this.wire.input.write(JSON.stringify(payload) + "\n"); }
    catch {
      this.handler({ type: "error", ...("reqId" in command ? { reqId: command.reqId } : {}), message: "Write status unknown. Refresh before retrying; edit was not queued." });
    }
  }

  private status(switched: boolean): void {
    this.handler({
      type: "route_status", mode: this.remoteAlias ? "remote" : "local", state: "connected",
      ...(this.remoteAlias ? { alias: this.remoteAlias } : {}), switched,
      message: this.remoteAlias
        ? `Connected calendar: ${this.remoteAlias}.`
        : `Connected daemon: local ${hostname()} (socket ${this.profile.socket ?? this.path}).`,
    });
  }

  routeStatus(): void { this.status(false); }

  async switchSsh(alias: string): Promise<void> {
    const error = validateSshAlias(alias);
    if (error) { this.routeError(error); return; }
    if (this.switchInProgress) { this.routeError("A route switch is already in progress."); return; }
    if (alias === this.alias) { this.status(false); return; }
    this.switchInProgress = true;
    this.handler({ type: "route_status", mode: this.alias ? "remote" : "local", state: "switching", ...(this.alias ? { alias: this.alias } : {}), switched: false, message: `Connecting through SSH alias ${alias}…` });
    try {
      const result = await probe(sshWire(alias));
      this.alias = alias;
      this.adopt(result, true);
    } catch (cause) { this.routeError(`Could not connect through ${alias}: ${cause instanceof Error ? cause.message : String(cause)}`); }
    finally { this.switchInProgress = false; }
  }

  async useLocal(): Promise<void> {
    if (this.switchInProgress) { this.routeError("A route switch is already in progress."); return; }
    if (!this.alias && !this.profile.url) { this.status(false); return; }
    this.switchInProgress = true;
    try {
      const profile = connectionProfile("local");
      const result = await probe(localWire(profile.socket ?? this.path), 3_000, profile.token);
      this.alias = null;
      this.profile = profile;
      this.adopt(result, true);
    } catch (cause) { this.routeError(`Could not return to the local daemon: ${cause instanceof Error ? cause.message : String(cause)}`); }
    finally { this.switchInProgress = false; }
  }

  async switchProfile(name: string): Promise<void> {
    if (this.switchInProgress) { this.routeError("A route switch is already in progress."); return; }
    this.switchInProgress = true;
    try {
      const profile = connectionProfile(name);
      const result = await probe(profile.url ? httpWire(profile) : localWire(profile.socket ?? this.path), 15_000, profile.url ? undefined : profile.token);
      this.alias = null; this.profile = profile;
      this.adopt(result, true);
    } catch (error) { this.routeError(error instanceof Error ? error.message : String(error)); }
    finally { this.switchInProgress = false; }
  }

  private routeError(message: string): void {
    this.handler({ type: "route_status", mode: this.remoteAlias ? "remote" : "local", state: "failed",
      ...(this.remoteAlias ? { alias: this.remoteAlias } : {}), switched: false, retained: this.connected, message });
  }

  createEvent(event: EventDraft): string { const reqId = randomUUID(); this.write({ type: "create_event", reqId, event }); return reqId; }
  updateEvent(id: string, patch: EventPatch): string { const reqId = randomUUID(); this.write({ type: "update_event", reqId, id, patch }); return reqId; }
  completeEvent(id: string, completed: boolean, occurrenceDate: string): string { const reqId = randomUUID(); this.write({ type: "complete_event", reqId, id, completed, occurrenceDate }); return reqId; }
  deleteEvent(id: string): string { const reqId = randomUUID(); this.write({ type: "delete_event", reqId, id }); return reqId; }
  createCalendar(name: string, color?: string): string { const reqId = randomUUID(); this.write({ type: "create_calendar", reqId, name, ...(color ? { color } : {}) }); return reqId; }
  updateCalendar(id: string, patch: Omit<CalendarPatch, "visible">): string { const reqId = randomUUID(); this.write({ type: "update_calendar", reqId, id, patch }); return reqId; }
  createGroup(name: string): string { const reqId = randomUUID(); this.write({ type: "create_group", reqId, name }); return reqId; }
  updateGroup(id: string, name: string): string { const reqId = randomUUID(); this.write({ type: "update_group", reqId, id, name }); return reqId; }
  deleteGroup(id: string): string { const reqId = randomUUID(); this.write({ type: "delete_group", reqId, id }); return reqId; }
  bootstrap(): void { this.write({ type: "bootstrap" }); }

  /** Send an at-most-once restart request to the daemon behind the current route. */
  restartDaemon(): boolean {
    if (!this.wire) return false;
    try {
      this.wire.input.write(JSON.stringify({ type: "restart_daemon", reqId: randomUUID() }) + "\n");
      return true;
    } catch {
      return false;
    }
  }

  disconnect(): void {
    this.generation++;
    const wire = this.wire;
    this.wire = null;
    wire?.close();
  }
}
