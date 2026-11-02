import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import { hostname } from "node:os";
import type { Readable, Writable } from "node:stream";
import { existsSync } from "node:fs";
import { isWindows, socketPath } from "@whale-cal/shared/paths";
import type { Command, Event } from "@whale-cal/shared/protocol";
import type { CalendarPatch, EventDraft, EventPatch } from "@whale-cal/shared/types";
import { spawnSshProxy, validateSshAlias, type SshConnector, type SshProcess } from "./ssh-transport";

export interface RouteEvent {
  type: "route_status";
  mode: "local" | "remote";
  /** `cancelled`: a pending SSH switch was abandoned and the route is unchanged. */
  state: "connected" | "switching" | "failed" | "cancelled";
  alias?: string;
  switched: boolean;
  /** A connection (re)established by connect(), not an answer to a route request. */
  silent?: boolean;
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

const PROBE_TIMEOUT_MS = 15_000;
/** Sent ahead of the probe in one write: cald answers it first, so a connection opens with its data. */
const PROBE_PREAMBLE: Command[] = [{ type: "bootstrap" }];

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

function localWire(path: string): Promise<Wire> {
  return new Promise((resolve, reject) => {
    if (!isWindows && !existsSync(path)) { reject(new Error(`cald socket not found at ${path}`)); return; }
    const socket: Socket = connect(path);
    let settled = false;
    socket.once("connect", () => {
      settled = true;
      socket.setNoDelay(true);
      // Decode across chunk boundaries: a multibyte character can straddle two.
      socket.setEncoding("utf8");
      resolve({ input: socket, output: socket, emitter: socket, close: () => socket.destroy(), label: path });
    });
    socket.once("error", error => { if (!settled) reject(new Error(`cannot connect to cald: ${error.message}`)); });
  });
}

/** Built in the tick that spawned `process`, so the probe hears a spawn failure. */
function sshWire(process: SshProcess, alias: string): Wire {
  process.stdout.setEncoding("utf8");
  process.stderr.setEncoding("utf8");
  // A broken pipe also closes the process, which the probe and adopt() report.
  process.stdin.on("error", () => {});
  return {
    input: process.stdin, output: process.stdout, diagnostics: process.stderr, emitter: process,
    close: () => { try { process.stdin.end(); } catch {} try { process.kill(); } catch {} }, label: alias,
  };
}

/**
 * Verify that `wire` reaches cald. Lines answered ahead of the pong (the
 * preamble's bootstrap) are kept, in order, for the adopting client.
 */
function probe(wire: Wire, timeoutMs = PROBE_TIMEOUT_MS, signal?: AbortSignal): Promise<ProbedWire> {
  const reqId = `probe_${randomUUID()}`;
  return new Promise((resolve, reject) => {
    let buffer = "", retained = "", stderr = "", done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      wire.output.off("data", onData);
      wire.diagnostics?.off("data", onDiagnostic);
      wire.emitter.off("close", onClose);
      wire.emitter.off("error", onError);
      if (error) { wire.close(); reject(error); }
      else { wire.output.pause(); resolve({ wire, buffered: retained + buffer, stderr }); }
    };
    const onDiagnostic = (chunk: Buffer | string) => {
      stderr = (stderr + chunk.toString()).slice(-8192);
    };
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const raw = buffer.slice(0, newline + 1);
        const line = raw.trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let value: Event;
        try { value = JSON.parse(line) as Event; }
        catch { finish(new Error("daemon proxy returned non-protocol output")); return; }
        if (value.type === "pong" && value.reqId === reqId) { finish(); return; }
        retained += raw;
      }
    };
    const suffix = () => stderr.trim() ? `: ${stderr.trim()}` : "";
    const onClose = () => finish(new Error(`connection closed before cald replied${suffix()}`));
    const onError = (error: Error) => finish(new Error(`${error.message}${suffix()}`));
    const onAbort = () => finish(new Error(String(signal?.reason ?? "cancelled")));
    const timer = setTimeout(() => finish(new Error(`timed out waiting for cald${suffix()}`)), timeoutMs);
    wire.output.on("data", onData);
    wire.diagnostics?.on("data", onDiagnostic);
    wire.emitter.on("close", onClose);
    wire.emitter.on("error", onError);
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener("abort", onAbort, { once: true });
    try { wire.input.write([...PROBE_PREAMBLE, { type: "probe", reqId }].map(command => JSON.stringify(command) + "\n").join("")); }
    catch (error) { finish(new Error(`cannot write to cald: ${errorMessage(error)}${suffix()}`)); }
  });
}

/**
 * Probe cald through SSH. A session riding an existing shared master is
 * hedged with a fresh connection (see ssh-mux.ts): the first to answer wins
 * and the other is closed.
 */
export async function probeSsh(alias: string, connector: SshConnector, signal: AbortSignal, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbedWire> {
  const primaryAbort = new AbortController();
  const primaryProcess = connector.spawn(alias);
  const primary = probe(sshWire(primaryProcess, alias), timeoutMs, AbortSignal.any([signal, primaryAbort.signal]));
  const fallback = connector.fallback?.(alias, primaryProcess) ?? null;
  if (!fallback) return primary;
  return new Promise((resolve, reject) => {
    const secondaryAbort = new AbortController();
    let secondary: Promise<ProbedWire> | null = null;
    let settled = false, primaryFailed = false, secondaryFailed = false;
    const win = (result: ProbedWire, usedFallback: boolean) => {
      if (settled) { result.wire.close(); return; }
      settled = true;
      clearTimeout(timer);
      (usedFallback ? primaryAbort : secondaryAbort).abort("another SSH connection answered first");
      if (usedFallback) fallback.onUsed?.();
      resolve(result);
    };
    const fail = (error: unknown) => {
      if (settled || !primaryFailed || (secondary && !secondaryFailed)) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const startSecondary = () => {
      if (secondary || settled || signal.aborted) return;
      clearTimeout(timer);
      try {
        const process = fallback.spawn(alias);
        secondary = probe(sshWire(process, alias), timeoutMs, AbortSignal.any([signal, secondaryAbort.signal]));
      } catch (error) { secondary = Promise.reject(error); }
      // The fresh connection's failure explains itself best (DNS, auth, network).
      secondary.then(result => win(result, true), error => { secondaryFailed = true; fail(error); });
    };
    primary.then(result => win(result, false), error => {
      primaryFailed = true;
      startSecondary();
      fail(error);
    });
    const timer = setTimeout(startSecondary, fallback.afterMs);
  });
}

export class DaemonClient {
  private wire: Wire | null = null;
  private buffer = "";
  private generation = 0;
  private pending: Command[] = [];
  private reconnecting = false;
  private alias: string | null = null;
  /** The SSH switch in progress; aborting it cancels its probes. */
  private switching: { alias: string; abort: AbortController } | null = null;
  private returningLocal = false;
  private disconnectHandler: (() => void) | null = null;

  constructor(
    private readonly handler: (event: ClientEvent) => void,
    private readonly path = socketPath(),
    private readonly ssh: SshConnector = { spawn: alias => spawnSshProxy(alias) },
  ) {}

  get connected(): boolean { return !!this.wire; }
  get remoteAlias(): string | null { return this.alias; }
  get switchPending(): boolean { return !!this.switching; }

  onDisconnect(handler: () => void): void { this.disconnectHandler = handler; }

  /** Connect the current route, or reconnect it after a loss. */
  async connect(): Promise<void> {
    if (this.reconnecting || this.wire) return;
    this.reconnecting = true;
    const alias = this.alias;
    try {
      const result = alias ? await probeSsh(alias, this.ssh, new AbortController().signal) : await probe(await localWire(this.path));
      // A route switch finished first: it owns the connection now.
      if (this.wire || this.alias !== alias) { result.wire.close(); return; }
      this.adopt(result, false, true);
    } finally { this.reconnecting = false; }
  }

  private route(): Pick<RouteEvent, "mode" | "alias"> {
    return this.alias ? { mode: "remote", alias: this.alias } : { mode: "local" };
  }

  private adopt(probed: ProbedWire, switched: boolean, silent = false): void {
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
      this.handler({ type: "route_status", ...this.route(), state: "failed", switched: false, message: `Connection to ${label} was lost.` });
      this.disconnectHandler?.();
    };
    wire.output.on("data", onData);
    wire.emitter.on("close", onClose);
    wire.emitter.on("error", onClose);
    // The route's status precedes its data, which the probe's preamble already fetched.
    this.status(switched, silent);
    if (probed.buffered) this.consume(probed.buffered);
    wire.output.resume();
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

  private status(switched: boolean, silent = false): void {
    this.handler({
      type: "route_status", ...this.route(), state: "connected", switched, ...(silent ? { silent } : {}),
      message: this.alias
        ? `Connected daemon: SSH alias ${this.alias} (remote calendar).`
        : `Connected daemon: local ${hostname()} (socket ${this.path}).`,
    });
  }

  routeStatus(): void { this.status(false); }

  async switchSsh(alias: string): Promise<void> {
    const error = validateSshAlias(alias);
    if (error) { this.routeError(error); return; }
    if (this.switching) { this.routeError(`Already switching to SSH alias ${this.switching.alias}.`); return; }
    if (this.returningLocal) { this.routeError("Already returning to the local daemon."); return; }
    if (alias === this.alias && this.wire) { this.status(false); return; }
    const switching = { alias, abort: new AbortController() };
    this.switching = switching;
    this.handler({ type: "route_status", ...this.route(), state: "switching", switched: false, message: `Connecting to remote Whale Cal daemon through SSH alias ${alias}…` });
    try {
      const result = await probeSsh(alias, this.ssh, switching.abort.signal);
      if (this.switching !== switching) { result.wire.close(); return; }
      this.switching = null;
      this.alias = alias;
      this.adopt(result, true);
    } catch (cause) {
      // A cancelled switch has already reported itself.
      if (this.switching !== switching) return;
      this.switching = null;
      this.routeError(`Could not connect through SSH alias ${alias}: ${errorMessage(cause)}`);
    }
  }

  /** `/ssh cancel` and Esc: abandon a pending SSH switch, or else return to the local daemon. */
  async useLocal(): Promise<void> {
    if (this.switching) {
      const { alias, abort } = this.switching;
      this.switching = null;
      abort.abort(`SSH switch to ${alias} cancelled.`);
      this.handler({ type: "route_status", ...this.route(), state: "cancelled", switched: false, message: `SSH switch to ${alias} cancelled.` });
      return;
    }
    if (this.returningLocal) { this.routeError("Already returning to the local daemon."); return; }
    if (!this.alias && this.wire) { this.status(false); return; }
    this.returningLocal = true;
    try {
      const result = await probe(await localWire(this.path), 3_000);
      this.alias = null;
      this.adopt(result, true);
    } catch (cause) { this.routeError(`Could not return to the local daemon: ${errorMessage(cause)}`); }
    finally { this.returningLocal = false; }
  }

  private routeError(message: string): void {
    this.handler({ type: "route_status", ...this.route(), state: "failed", switched: false, message });
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
