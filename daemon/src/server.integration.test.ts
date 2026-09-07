import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connect, type Socket } from "node:net";
import type { Event } from "@whale-cal/shared/protocol";
import { CalendarStore } from "./store";
import { DaemonServer } from "./server";
import { createHandler } from "./handler";

let root: string | null = null;
let server: DaemonServer | null = null;
let socket: Socket | null = null;
afterEach(async () => {
  socket?.destroy(); socket = null;
  await server?.stop(); server = null;
  delete process.env.CAL_DISABLE_FILE_LOG;
  if (root) rmSync(root, { recursive: true, force: true }); root = null;
});

test("JSON-lines clients query schema and state, mutate, and receive canonical broadcasts", async () => {
  process.env.CAL_DISABLE_FILE_LOG = "1";
  root = mkdtempSync(join(tmpdir(), "whale-cal-server-"));
  const path = join(root, "cald.sock");
  const store = new CalendarStore(join(root, "calendar.json"));
  let handler: ReturnType<typeof createHandler> | null = null;
  server = new DaemonServer(path, (client, command) => handler?.(client, command));
  handler = createHandler(server, store);
  await server.start();

  socket = connect(path);
  const events: Event[] = [];
  let buffer = "";
  const complete = new Promise<void>((resolve, reject) => {
    socket!.once("error", reject);
    socket!.on("data", chunk => {
      buffer += chunk.toString();
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const event = JSON.parse(buffer.slice(0, newline)) as Event;
        buffer = buffer.slice(newline + 1);
        events.push(event);
        if (event.type === "schema") {
          expect(event.protocolVersion).toBe(1);
          expect((event.schema as { $id?: string }).$id).toContain("cal-ipc-v1");
          socket!.write(JSON.stringify({ type: "bootstrap" }) + "\n");
        }
        if (event.type === "bootstrap") {
          socket!.write(JSON.stringify({
            type: "create_event", reqId: "create-1",
            event: { calendarId: event.database.calendars[0]!.id, title: "Protocol test", startDate: "2026-08-31" },
          }) + "\n");
        }
        if (event.type === "event_created") {
          socket!.write(JSON.stringify({ type: "complete_event", reqId: "done-1", id: event.event.id, completed: true }) + "\n");
        }
        if (event.type === "event_updated") {
          expect(event.event.completed).toBe(true);
          socket!.write(JSON.stringify({
            type: "list_events", reqId: "list-1", from: "2026-08-31", to: "2026-08-31", query: "protocol",
          }) + "\n");
        }
        if (event.type === "events_list") resolve();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    socket!.once("connect", () => { socket!.write(JSON.stringify({ type: "get_schema", reqId: "schema-1" }) + "\n"); resolve(); });
    socket!.once("error", reject);
  });
  await Promise.race([complete, Bun.sleep(2_000).then(() => { throw new Error("protocol timeout"); })]);
  expect(events.map(event => event.type)).toEqual(["schema", "bootstrap", "event_created", "event_updated", "events_list"]);
  const listed = events.find(event => event.type === "events_list");
  expect(listed?.type === "events_list" && listed.occurrences[0]?.event.title).toBe("Protocol test");
  expect(store.snapshot().events[0]?.title).toBe("Protocol test");
  expect(store.snapshot().events[0]?.completed).toBe(true);
});
