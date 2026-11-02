import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { emptyDatabase } from "./state";
import { DaemonClient, probeSsh, type ClientEvent } from "./client";
import type { SshConnector, SshProcess } from "./ssh-transport";

class FakeProcess extends EventEmitter implements SshProcess {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;

  kill(): boolean {
    if (this.killed) return false;
    this.killed = true;
    queueMicrotask(() => this.emit("close", 0, null));
    return true;
  }
}

/** A `cald proxy` that answers bootstrap and probe commands in order. */
function respondingProxy(): FakeProcess {
  const child = new FakeProcess();
  let input = "";
  child.stdin.on("data", chunk => {
    input += chunk.toString("utf8");
    const lines = input.split("\n");
    input = lines.pop()!;
    for (const line of lines.filter(Boolean)) {
      const command = JSON.parse(line);
      if (command.type === "bootstrap") child.stdout.write(`${JSON.stringify({ type: "bootstrap", database: { ...emptyDatabase(), revision: 7 } })}\n`);
      if (command.type === "probe") child.stdout.write(`${JSON.stringify({ type: "pong", reqId: command.reqId })}\n`);
    }
  });
  return child;
}

const never = () => new AbortController().signal;

describe("SSH probe fallback to a fresh connection", () => {
  test("without a pong in time, a fresh probe races the first and the winner is kept", async () => {
    const stuck = new FakeProcess(), fresh = respondingProxy();
    let used = 0;
    const result = await probeSsh("whale", {
      spawn: () => stuck,
      fallback: (_alias, primary) => primary === stuck ? { afterMs: 5, spawn: () => fresh, onUsed: () => { used++; } } : null,
    }, never());
    expect(result.wire.label).toBe("whale");
    expect(stuck.killed).toBe(true);
    expect(fresh.killed).toBe(false);
    expect(used).toBe(1);
    result.wire.close();
  });

  test("an answer in time never starts the fallback", async () => {
    const healthy = respondingProxy();
    let spawned = 0;
    const result = await probeSsh("whale", {
      spawn: () => healthy,
      fallback: () => ({ afterMs: 1_000, spawn: () => { spawned++; return new FakeProcess(); } }),
    }, never());
    expect(spawned).toBe(0);
    // The preamble's bootstrap was answered ahead of the pong and kept for the client.
    expect(JSON.parse(result.buffered.trim())).toMatchObject({ type: "bootstrap", database: { revision: 7 } });
    result.wire.close();
  });

  test("a first probe that fails starts the fallback at once; both failing reports the fresh one's error", async () => {
    const broken = new FakeProcess(), alsoBroken = new FakeProcess();
    const probe = probeSsh("whale", { spawn: () => broken, fallback: () => ({ afterMs: 60_000, spawn: () => alsoBroken }) }, never());
    broken.emit("close", 255, null);
    await Bun.sleep(1);
    alsoBroken.stderr.write("Could not resolve hostname whale");
    await Bun.sleep(1);
    alsoBroken.emit("close", 255, null);
    await expect(probe).rejects.toThrow("Could not resolve hostname whale");
  });

  test("cancelling stops both probes and starts no other", async () => {
    const first = new FakeProcess(), second = new FakeProcess();
    let spawned = 0;
    const abort = new AbortController();
    const probe = probeSsh("whale", {
      spawn: () => first,
      fallback: () => ({ afterMs: 1, spawn: () => { spawned++; return second; } }),
    }, abort.signal);
    await Bun.sleep(5);
    abort.abort("switch cancelled");
    await expect(probe).rejects.toThrow("switch cancelled");
    expect(first.killed).toBe(true);
    expect(second.killed).toBe(true);
    expect(spawned).toBe(1);
  });
});

describe("SSH route switches", () => {
  function client(connector: SshConnector) {
    const events: ClientEvent[] = [];
    return { events, client: new DaemonClient(event => events.push(event), "/nonexistent/cald.sock", connector) };
  }
  const routeStates = (events: ClientEvent[]) => events.map(event => event.type === "route_status" ? `${event.state}${event.switched ? ":switched" : ""}` : event.type);

  test("report switching, then the switched route ahead of the data its probe already fetched", async () => {
    const proxy = respondingProxy();
    const { events, client: daemon } = client({ spawn: () => proxy });
    await daemon.switchSsh("whale");
    expect(routeStates(events)).toEqual(["switching", "connected:switched", "bootstrap"]);
    expect(events[0]).toMatchObject({ message: "Connecting to remote Whale Cal daemon through SSH alias whale…" });
    expect(daemon.remoteAlias).toBe("whale");
    expect(daemon.connected).toBe(true);
    daemon.disconnect();
  });

  test("cancelling a pending switch abandons its connection and keeps the route", async () => {
    const stuck = new FakeProcess();
    const { events, client: daemon } = client({ spawn: () => stuck });
    const switching = daemon.switchSsh("whale");
    expect(daemon.switchPending).toBe(true);
    await daemon.useLocal();
    await switching;
    expect(routeStates(events)).toEqual(["switching", "cancelled"]);
    expect(events[1]).toMatchObject({ mode: "local", message: "SSH switch to whale cancelled." });
    expect(stuck.killed).toBe(true);
    expect(daemon.remoteAlias).toBeNull();
    expect(daemon.switchPending).toBe(false);
  });

  test("a failed switch says why", async () => {
    const broken = new FakeProcess();
    const { events, client: daemon } = client({ spawn: () => broken });
    const switching = daemon.switchSsh("whale");
    broken.stderr.write("Permission denied (publickey).");
    await Bun.sleep(1);
    broken.emit("close", 255, null);
    await switching;
    expect(routeStates(events)).toEqual(["switching", "failed"]);
    expect(events[1]).toMatchObject({ message: "Could not connect through SSH alias whale: connection closed before cald replied: Permission denied (publickey)." });
  });
});
