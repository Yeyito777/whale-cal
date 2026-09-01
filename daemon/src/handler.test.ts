import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event } from "@whale-cal/shared/protocol";
import { createHandler } from "./handler";
import type { ClientConnection } from "./server";
import { DaemonServer } from "./server";
import { CalendarStore } from "./store";

let root: string | null = null;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

describe("daemon lifecycle commands", () => {
  test("acknowledges repeated restart requests but invokes its owner only once", async () => {
    root = mkdtempSync(join(tmpdir(), "whale-cal-restart-"));
    const sent: Event[] = [];
    const server = { send: (_client: ClientConnection, event: Event) => { sent.push(event); } } as unknown as DaemonServer;
    const store = new CalendarStore(join(root, "calendar.json"));
    let restarts = 0;
    let resolveRestart!: () => void;
    const restarted = new Promise<void>(resolve => { resolveRestart = resolve; });
    const handle = createHandler(server, store, { requestRestart: () => { restarts++; resolveRestart(); } });
    const client = {} as ClientConnection;

    handle(client, { type: "restart_daemon", reqId: "restart-1" });
    handle(client, { type: "restart_daemon", reqId: "restart-2" });

    expect(sent).toEqual([
      { type: "ack", reqId: "restart-1" },
      { type: "ack", reqId: "restart-2" },
    ]);
    expect(restarts).toBe(0);
    await restarted;
    expect(restarts).toBe(1);
  });

  test("rejects restart when the daemon has no supervising lifecycle", () => {
    root = mkdtempSync(join(tmpdir(), "whale-cal-restart-"));
    const sent: Event[] = [];
    const server = { send: (_client: ClientConnection, event: Event) => { sent.push(event); } } as unknown as DaemonServer;
    const handle = createHandler(server, new CalendarStore(join(root, "calendar.json")));

    handle({} as ClientConnection, { type: "restart_daemon", reqId: "restart-unsupported" });

    expect(sent).toEqual([{ type: "error", reqId: "restart-unsupported", message: "This daemon instance cannot restart itself." }]);
  });
});
