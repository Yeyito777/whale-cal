import { describe, expect, test } from "bun:test";
import { DaemonClient } from "./client";

describe("daemon client lifecycle", () => {
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
