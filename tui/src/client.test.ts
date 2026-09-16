import { describe, expect, test } from "bun:test";
import { DaemonClient } from "./client";

describe("daemon client lifecycle", () => {
  test("an explicit local socket overrides the ambient default profile", () => {
    const client = new DaemonClient(() => {}, "/tmp/explicit-calendar-test.sock");
    expect((client as any).profile).toEqual({ name: "local", socket: "/tmp/explicit-calendar-test.sock" });
  });
  test("a late HTTP snapshot cannot roll back a newer live revision", () => {
    const received: any[] = [];
    const client = new DaemonClient(event => received.push(event));
    const internal = client as any;
    internal.consume(JSON.stringify({ type: "bootstrap", database: { version: 1, revision: 4, calendars: [], events: [] } }) + "\n");
    internal.consume(JSON.stringify({ type: "event_deleted", reqId: "broadcast:5", id: "e", revision: 5 }) + "\n");
    internal.consume(JSON.stringify({ type: "bootstrap", database: { version: 1, revision: 4, calendars: [], events: [] } }) + "\n");
    expect(received).toHaveLength(2);
    expect(internal.revision).toBe(5);
  });

  test("sends restart only to the currently connected route and never queues it", () => {
    const client = new DaemonClient(() => {});
    const internal = client as any;
    const writes: string[] = [];

    expect(client.restartDaemon()).toBe(false);
    expect(internal.pending).toEqual([]);

    internal.wire = { input: { write: (value: string) => writes.push(value) } };
    expect(client.restartDaemon()).toBe(true);
    expect(JSON.parse(writes[0]!)).toMatchObject({ type: "restart_daemon", reqId: expect.any(String) });

    internal.wire = null;
    expect(client.restartDaemon()).toBe(false);
    expect(internal.pending).toEqual([]);
  });
});
