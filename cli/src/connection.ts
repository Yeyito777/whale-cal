import { connect, type Socket } from "node:net";
import { socketPath } from "@whale-cal/shared/paths";
import type { Command, Event } from "@whale-cal/shared/protocol";

const RESPONSE_TYPES: Partial<Record<Command["type"], Event["type"]>> = {
  probe: "pong",
  get_schema: "schema",
  bootstrap: "bootstrap",
  list_calendars: "calendars_list",
  list_events: "events_list",
  get_event: "event_details",
  create_event: "event_created",
  update_event: "event_updated",
  delete_event: "event_deleted",
  create_calendar: "calendar_created",
  update_calendar: "calendar_updated",
  delete_calendar: "calendar_deleted",
};

export class CalConnectionError extends Error {}

function hasRequestId(value: object): value is { reqId: string } {
  return "reqId" in value && typeof (value as { reqId?: unknown }).reqId === "string";
}

function requestPayload(command: Command | Record<string, unknown>, payload: string, timeoutMs = 5_000): Promise<Event> {
  return new Promise((resolve, reject) => {
    let socket: Socket | null = null;
    let buffer = "";
    let settled = false;
    const requestId = hasRequestId(command) ? command.reqId : undefined;
    const expected = typeof command.type === "string"
      ? RESPONSE_TYPES[command.type as Command["type"]]
      : undefined;

    const finish = (error?: Error, event?: Event): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      if (error) reject(error);
      else resolve(event!);
    };

    const timer = setTimeout(() => finish(new CalConnectionError(`cald did not respond within ${timeoutMs}ms.`)), timeoutMs);
    socket = connect(socketPath());
    socket.setNoDelay(true);
    socket.once("connect", () => socket!.write(payload));
    socket.on("data", chunk => {
      buffer += chunk.toString("utf8");
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let event: Event;
        try { event = JSON.parse(line) as Event; }
        catch { finish(new CalConnectionError("cald returned malformed JSON.")); return; }
        const eventRequestId = "reqId" in event ? event.reqId : undefined;
        if (event.type === "error" && (!requestId || !event.reqId || event.reqId === requestId)) {
          finish(new CalConnectionError(event.message));
          return;
        }
        if (requestId && eventRequestId !== requestId) continue;
        if (expected && event.type !== expected) continue;
        finish(undefined, event);
        return;
      }
    });
    socket.once("error", error => {
      const suffix = (error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ECONNREFUSED"
        ? " Is cald running? Start it with `bun run daemon` from the Whale Cal project."
        : "";
      finish(new CalConnectionError(`Cannot connect to cald at ${socketPath()}: ${error.message}.${suffix}`));
    });
    socket.once("close", () => {
      if (!settled) finish(new CalConnectionError("cald closed the connection before replying."));
    });
  });
}

/** Perform one typed request over cald's newline-delimited JSON Unix-socket protocol. */
export function request(command: Command | Record<string, unknown>, timeoutMs = 5_000): Promise<Event> {
  return requestPayload(command, JSON.stringify(command) + "\n", timeoutMs);
}

/** Forward a validated single-line JSON command without rewriting its UTF-8 text. */
export function requestRaw(source: string, command: Record<string, unknown>, timeoutMs = 5_000): Promise<Event> {
  return requestPayload(command, source.endsWith("\n") ? source : source + "\n", timeoutMs);
}
