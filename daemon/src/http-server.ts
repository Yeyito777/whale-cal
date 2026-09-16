import type { Server } from "bun";
import type { Command, Event } from "@whale-cal/shared/protocol";
import { Auth } from "./auth";
import { createHandler, type HandlerLifecycle } from "./handler";
import type { DaemonServer } from "./server";
import type { CalendarStore } from "./store";

export class CalendarHttpServer {
  private server: Server<undefined> | null = null;
  private streams = new Set<() => void>();

  constructor(private readonly store: CalendarStore, private readonly hub: DaemonServer, private readonly lifecycle: HandlerLifecycle = {}) {}

  start(port: number, hostname = "127.0.0.1"): void {
    const auth = new Auth(this.store.persistence.sql);
    this.server = Bun.serve({
      hostname, port, maxRequestBodySize: 1_048_576, idleTimeout: 60,
      fetch: async request => {
        const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
        const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
        // No browser cookie auth or permissive CORS. Native clients use explicit bearer tokens.
        if (request.headers.has("Origin")) return json({ type: "error", message: "Browser origins are not enabled." }, 403);
        const token = request.headers.get("Authorization")?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1] ?? "";
        try { auth.authenticate(token); }
        catch { return json({ type: "error", code: "unauthorized", message: "Authentication required." }, 401); }
        const path = new URL(request.url).pathname;
        if (path === "/v1/commands" && request.method === "POST") {
          if (!request.headers.get("Content-Type")?.startsWith("application/json")) {
            return json({ type: "error", message: "Content-Type must be application/json." }, 415);
          }
          let command: Command;
          try { command = await request.json(); }
          catch { return json({ type: "error", message: "Invalid JSON or request too large." }, 400); }
          if (command?.type === "authenticate") return json({ type: "error", message: "Use the Authorization header." }, 400);
          let reply: Event | undefined;
          const handle = createHandler({
            send: (_client, event) => { reply = event; },
            broadcast: event => this.hub.broadcast(event),
          }, this.store, this.lifecycle);
          handle({ id: 0, buffer: "", token, trustedLocal: false }, command);
          const status = reply?.type !== "error" ? 200
            : reply.code === "unauthorized" ? 401 : reply.code === "forbidden" ? 403 : reply.code === "conflict" ? 409 : 400;
          return json(reply, status);
        }
        if (path === "/v1/changes" && request.method === "GET") {
          if (this.streams.size >= 100) return json({ type: "error", message: "Too many live connections." }, 503);
          let cleanup = () => {};
          const stream = new ReadableStream<Uint8Array>({
            start: controller => {
              let closed = false;
              const send = (event: Event) => {
                if (closed) return;
                try {
                  auth.authenticate(token);
                  if ((controller.desiredSize ?? 0) < -32) { cleanup(); return; }
                  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
                } catch { cleanup(); }
              };
              const heartbeat = setInterval(() => {
                try {
                  auth.authenticate(token);
                  if ((controller.desiredSize ?? 0) < -32) { cleanup(); return; }
                  controller.enqueue(new TextEncoder().encode(": heartbeat\n\n"));
                } catch { cleanup(); }
              }, 15_000);
              cleanup = () => {
                if (closed) return;
                closed = true;
                clearInterval(heartbeat);
                this.hub.subscribers.delete(send);
                this.streams.delete(cleanup);
                request.signal.removeEventListener("abort", cleanup);
                try { controller.close(); } catch {}
              };
              this.streams.add(cleanup);
              this.hub.subscribers.add(send);
              request.signal.addEventListener("abort", cleanup, { once: true });
              // Every reconnect starts from a current snapshot, not an incomplete replay.
              send({ type: "bootstrap", database: this.store.snapshot() });
              if (request.signal.aborted) cleanup();
            },
            cancel: () => cleanup(),
          });
          return new Response(stream, { headers: { ...headers, "Content-Type": "text/event-stream", "X-Accel-Buffering": "no" } });
        }
        return json({ type: "error", message: "Not found." }, 404);
      },
      error: () => Response.json({ type: "error", message: "Request failed." }, { status: 500 }),
    });
  }

  get port(): number { return this.server!.port!; }
  stop(): void { for (const close of this.streams) close(); this.server?.stop(true); this.server = null; }
}
