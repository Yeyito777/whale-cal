import { createServer, type Server, type Socket } from "node:net";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { isWindows } from "@whale-cal/shared/paths";
import type { Command, Event } from "@whale-cal/shared/protocol";
import { log } from "./log";
import type { Principal } from "./auth";

export interface ClientConnection {
  id: number;
  socket?: Socket;
  buffer: string;
  principal?: Principal;
  token?: string;
  trustedLocal?: boolean;
}

export type CommandHandler = (client: ClientConnection, command: Command) => void | Promise<void>;

export class DaemonServer {
  private server: Server | null = null;
  private clients = new Map<number, ClientConnection>();
  private nextId = 0;
  readonly subscribers = new Set<(event: Event) => void>();
  private credentialCheck: (client: ClientConnection) => boolean = () => true;

  setCredentialCheck(check: (client: ClientConnection) => boolean): void { this.credentialCheck = check; }

  constructor(private readonly path: string, private readonly handler: CommandHandler, private readonly shared = false) {}

  async start(): Promise<void> {
    if (!isWindows && existsSync(this.path)) {
      try { unlinkSync(this.path); } catch (error) { throw new Error(`Cannot remove stale daemon socket: ${error}`); }
    }
    await new Promise<void>((resolve, reject) => {
      this.server = createServer(socket => this.accept(socket));
      this.server.once("error", reject);
      this.server.listen(this.path, resolve);
    });
    if (!isWindows) {
      chmodSync(this.path, 0o600);
    }
    log("info", `server: listening on ${this.path}`);
  }

  async stop(): Promise<void> {
    for (const client of this.clients.values()) client.socket?.destroy();
    this.clients.clear();
    if (this.server) await new Promise<void>(resolve => this.server!.close(() => resolve()));
    this.server = null;
    if (!isWindows && existsSync(this.path)) {
      try { unlinkSync(this.path); } catch { /* best effort */ }
    }
  }

  private accept(socket: Socket): void {
    const id = ++this.nextId;
    const client: ClientConnection = { id, socket, buffer: "", trustedLocal: !this.shared };
    this.clients.set(id, client);
    socket.setNoDelay(true);
    socket.on("data", chunk => this.data(client, chunk));
    socket.on("close", () => this.clients.delete(id));
    socket.on("error", error => log("warn", `server: client ${id}: ${error.message}`));
  }

  private data(client: ClientConnection, chunk: Buffer | string): void {
    client.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (Buffer.byteLength(client.buffer) > 1_048_576) { client.socket?.destroy(); return; }
    let newline: number;
    while ((newline = client.buffer.indexOf("\n")) !== -1) {
      const line = client.buffer.slice(0, newline).trim();
      client.buffer = client.buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const value: unknown = JSON.parse(line);
        if (!value || typeof value !== "object" || typeof (value as { type?: unknown }).type !== "string") {
          this.send(client, { type: "error", message: "Invalid command." });
          continue;
        }
        Promise.resolve(this.handler(client, value as Command)).catch(error => {
          log("error", `handler: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
          this.send(client, { type: "error", message: "Daemon command failed." });
        });
      } catch {
        this.send(client, { type: "error", message: "Invalid JSON." });
      }
    }
  }

  send(client: ClientConnection, event: Event): void {
    if (client.socket && !client.socket.destroyed) {
      if (client.socket.writableLength > 2_097_152) { client.socket.destroy(); return; }
      client.socket.write(JSON.stringify(event) + "\n");
    }
  }

  broadcast(event: Event, exclude?: ClientConnection): void {
    this.authorizeSubscribers(this.credentialCheck);
    // Broadcasts must not impersonate a request reply on another user's socket.
    // Request IDs are deduplicated per user, so different users may reuse them.
    const wireEvent: Event = "reqId" in event
      ? { ...event, reqId: `broadcast:${"revision" in event ? event.revision : event.type}` } : event;
    for (const client of this.clients.values()) {
      if (client !== exclude && (client.trustedLocal || client.principal)) this.send(client, wireEvent);
    }
    for (const subscriber of this.subscribers) subscriber(wireEvent);
  }

  /** Recheck long-lived socket credentials, including revocation, before publishing. */
  authorizeSubscribers(check: (client: ClientConnection) => boolean): void {
    for (const client of this.clients.values()) {
      if (!check(client)) { client.socket?.destroy(); this.clients.delete(client.id); }
    }
  }
}
