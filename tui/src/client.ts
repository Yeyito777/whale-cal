import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import { hostname } from "node:os";
import type { Readable, Writable } from "node:stream";
import { existsSync } from "node:fs";
import { isWindows, socketPath } from "@whale-cal/shared/paths";
import type { Command, Event } from "@whale-cal/shared/protocol";
import type { Calendar, EventDraft, EventPatch } from "@whale-cal/shared/types";
import { spawnSshProxy, validateSshAlias, type SshProcess } from "./ssh-transport";

export interface RouteEvent {
  type: "route_status";
  mode: "local" | "remote";
  state: "connected" | "switching" | "failed";
  alias?: string;
  switched: boolean;
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

async function probe(wirePromise: Promise<Wire>, timeoutMs = 15_000): Promise<ProbedWire> {
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

  constructor(private readonly handler: (event: ClientEvent) => void, private readonly path = socketPath()) {}

  get connected(): boolean { return !!this.wire; }
  get remoteAlias(): string | null { return this.alias; }

  onDisconnect(handler: () => void): void { this.disconnectHandler = handler; }

  async connect(): Promise<void> {
    if (this.reconnecting || this.wire) return;
    this.reconnecting = true;
    try {
      const target = this.alias ? sshWire(this.alias) : localWire(this.path);
      const result = await probe(target);
      this.adopt(result, false);
    } finally { this.reconnecting = false; }
  }

  private adopt(probed: ProbedWire, switched: boolean): void {
    const old = this.wire;
    const wire = probed.wire;
    const generation = ++this.generation;
    this.wire = wire;
    this.buffer = "";
    const onData = (chunk: Buffer | string) => {
      if (this.wire !== wire || generation !== this.generation) return;
      this.consume(chunk.toString());
    };
    const onClose = () => {
      if (this.wire !== wire || generation !== this.generation) return;
      this.wire = null;
      const label = this.alias ? `SSH alias ${this.alias}` : `local ${hostname()}`;
      this.handler({ type: "route_status", mode: this.alias ? "remote" : "local", state: "failed", ...(this.alias ? { alias: this.alias } : {}), switched: false, message: `Connection to ${label} was lost.` });
      this.disconnectHandler?.();
    };
    wire.output.on("data", onData);
    wire.emitter.on("close", onClose);
    wire.emitter.on("error", onClose);
    if (probed.buffered) this.consume(probed.buffered);
    wire.output.resume();
    this.status(switched);
    this.write({ type: "bootstrap" });
    for (const command of this.pending.splice(0)) this.write(command);
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
        if (event.type !== "daemon_shutdown") this.handler(event);
      } catch { this.handler({ type: "error", message: "Daemon sent invalid JSON." }); }
    }
  }

  private write(command: Command): void {
    if (!this.wire) { if (command.type !== "bootstrap" && command.type !== "probe") this.pending.push(command); return; }
    try { this.wire.input.write(JSON.stringify(command) + "\n"); }
    catch { this.pending.push(command); }
  }

  private status(switched: boolean): void {
    this.handler({
      type: "route_status", mode: this.alias ? "remote" : "local", state: "connected",
      ...(this.alias ? { alias: this.alias } : {}), switched,
      message: this.alias
        ? `Connected daemon: SSH alias ${this.alias} (remote calendar).`
        : `Connected daemon: local ${hostname()} (socket ${this.path}).`,
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
    if (!this.alias) { this.status(false); return; }
    this.switchInProgress = true;
    try {
      const result = await probe(localWire(this.path), 3_000);
      this.alias = null;
      this.adopt(result, true);
    } catch (cause) { this.routeError(`Could not return to the local daemon: ${cause instanceof Error ? cause.message : String(cause)}`); }
    finally { this.switchInProgress = false; }
  }

  private routeError(message: string): void {
    this.handler({ type: "route_status", mode: this.alias ? "remote" : "local", state: "failed", ...(this.alias ? { alias: this.alias } : {}), switched: false, message });
  }

  createEvent(event: EventDraft): string { const reqId = randomUUID(); this.write({ type: "create_event", reqId, event }); return reqId; }
  updateEvent(id: string, patch: EventPatch): string { const reqId = randomUUID(); this.write({ type: "update_event", reqId, id, patch }); return reqId; }
  completeEvent(id: string, completed: boolean, occurrenceDate: string): string { const reqId = randomUUID(); this.write({ type: "complete_event", reqId, id, completed, occurrenceDate }); return reqId; }
  deleteEvent(id: string): string { const reqId = randomUUID(); this.write({ type: "delete_event", reqId, id }); return reqId; }
  createCalendar(name: string, color?: string): string { const reqId = randomUUID(); this.write({ type: "create_calendar", reqId, name, ...(color ? { color } : {}) }); return reqId; }
  updateCalendar(id: string, patch: Partial<Pick<Calendar, "name" | "color" | "visible">>): string { const reqId = randomUUID(); this.write({ type: "update_calendar", reqId, id, patch }); return reqId; }
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
