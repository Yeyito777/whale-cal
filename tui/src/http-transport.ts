import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { consumeChanges, httpRequest, type ConnectionProfile } from "@whale-cal/shared/connections";
import type { Command } from "@whale-cal/shared/protocol";

/** Adapts HTTP request/reply + SSE to the TUI's existing JSON-lines wire. */
export function httpWire(profile: ConnectionProfile) {
  return new Promise<{
    input: PassThrough; output: PassThrough; emitter: EventEmitter; close(): void; label: string;
  }>((resolve, reject) => {
    const input = new PassThrough(), output = new PassThrough(), emitter = new EventEmitter();
    const controller = new AbortController();
    let buffer = "", closed = false;
    let pending = Promise.resolve();
    const close = () => {
      if (closed) return;
      closed = true; controller.abort(); input.destroy(); output.destroy(); emitter.emit("close");
    };
    const readyTimer = setTimeout(() => { reject(new Error("Calendar live connection timed out.")); close(); }, 10_000);
    input.on("data", chunk => {
      buffer += chunk.toString();
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const command = JSON.parse(buffer.slice(0, newline)) as Command;
        buffer = buffer.slice(newline + 1);
        pending = pending.then(async () => {
          if (closed) return;
          const event = await httpRequest(profile, command);
          if (!closed) output.write(JSON.stringify(event) + "\n");
        }).catch(() => {
          // A failed response is NOT proof that a write failed. Never replay it.
          if (!closed) output.write(JSON.stringify({
            type: "error", ...("reqId" in command ? { reqId: command.reqId } : {}),
            message: "Connection lost; write status may be unknown. Refresh before retrying.",
          }) + "\n");
          close();
        });
      }
    });
    void consumeChanges(profile, controller.signal, event => {
      if (!closed) output.write(JSON.stringify(event) + "\n");
    }, () => {
      clearTimeout(readyTimer);
      resolve({ input, output, emitter, close, label: profile.url! });
    }).catch(error => reject(error)).finally(() => { clearTimeout(readyTimer); close(); });
  });
}
