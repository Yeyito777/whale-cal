import { createServer, type Server, type Socket } from "node:net";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { isWindows } from "@whale-cal/shared/paths";
import type { Command, Event } from "@whale-cal/shared/protocol";
import { log } from "./log";

export interface ClientConnection {
  id: number;
  socket: Socket;
  buffer: string;
}

export type CommandHandler = (client: ClientConnection, command: Command) => void | Promise<void>;

export class DaemonServer {
  private server: Server | null = null;
  private clients = new Map<number, ClientConnection>();
  private nextId = 0;

  constructor(private readonly path: string, private readonly handler: CommandHandler) {}

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
      try { chmodSync(this.path, 0o600); } catch { /* permissions are best effort */ }
    }
    log("info", `server: listening on ${this.path}`);
  }

  async stop(): Promise<void> {
    for (const client of this.clients.values()) client.socket.destroy();
    this.clients.clear();
    if (this.server) await new Promise<void>(resolve => this.server!.close(() => resolve()));
    this.server = null;
    if (!isWindows && existsSync(this.path)) {
      try { unlinkSync(this.path); } catch { /* best effort */ }
    }
  }

  private accept(socket: Socket): void {
    const id = ++this.nextId;
    const client: ClientConnection = { id, socket, buffer: "" };
    this.clients.set(id, client);
    socket.setNoDelay(true);
    socket.on("data", chunk => this.data(client, chunk));
    socket.on("close", () => this.clients.delete(id));
    socket.on("error", error => log("warn", `server: client ${id}: ${error.message}`));
  }

  private data(client: ClientConnection, chunk: Buffer | string): void {
    client.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
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
    if (!client.socket.destroyed) client.socket.write(JSON.stringify(event) + "\n");
  }

  broadcast(event: Event): void {
    for (const client of this.clients.values()) this.send(client, event);
  }
}
