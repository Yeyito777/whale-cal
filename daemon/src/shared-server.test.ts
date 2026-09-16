import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { CalendarStore } from "./store";
import { Auth } from "./auth";
import { CalendarHttpServer } from "./http-server";
import { DaemonServer } from "./server";
import { createHandler } from "./handler";
import { DaemonClient } from "../../tui/src/client";
import type { Event } from "@whale-cal/shared/protocol";
import type { CalendarDatabase } from "@whale-cal/shared/types";
import { Database } from "bun:sqlite";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cal-shared-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new CalendarStore(join(root, "calendar.sqlite"));
  cleanups.push(() => store.persistence.close());
  const auth = new Auth(store.persistence.sql);
  const alice = auth.createUser("Alice"), bob = auth.createUser("Bob");
  const ac = store.transaction(alice.id, () => store.createCalendar("Personal"));
  const bc = store.transaction(bob.id, () => store.createCalendar("Personal"));
  const a = auth.issueToken(alice.id, "test"), b = auth.issueToken(bob.id, "test"), admin = auth.issueToken("local", "admin-test");
  let handler: ReturnType<typeof createHandler>;
  const hub = new DaemonServer(join(root, "cald.sock"), (client, command) => handler(client, command), true);
  handler = createHandler(hub, store);
  await hub.start(); cleanups.push(() => hub.stop());
  const http = new CalendarHttpServer(store, hub);
  http.start(0); cleanups.push(() => http.stop());
  const url = `http://127.0.0.1:${http.port}`;
  const send = async (token: string, value: unknown) => {
    const response = await fetch(url + "/v1/commands", {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const call = (token: string, command: Record<string, unknown>) => send(token, { reqId: randomUUID(), ...command });
  return { root, store, auth, alice, bob, ac, bc, a, b, admin, hub, url, send, call };
}

test("HTTP authenticates, reads every detail, and enforces ownership on every write", async () => {
  const f = await fixture();
  expect((await f.call("", { type: "bootstrap" })).status).toBe(401);
  const created = await f.call(f.a.token, { type: "create_event", event: { title: "Private-ish", startDate: "2026-09-16", notes: "Shared notes", location: "Home" } });
  expect(created.status).toBe(200);
  expect(created.body.event.calendarId).toBe(f.ac.id);
  const event = created.body.event;
  const read = await f.call(f.b.token, { type: "get_event", id: event.id });
  expect(read.body.event).toMatchObject({ notes: "Shared notes", location: "Home" });
  for (const command of [
    { type: "create_event", event: { title: "Bad", startDate: "2026-09-16", calendarId: f.ac.id } },
    { type: "update_event", id: event.id, patch: { title: "Bad" } },
    { type: "delete_event", id: event.id }, { type: "complete_event", id: event.id, completed: true },
    { type: "update_calendar", id: f.ac.id, patch: { name: "Bad" } }, { type: "delete_calendar", id: f.ac.id },
    { type: "restart_daemon" }, { type: "create_user", name: "Bad" },
    { type: "create_token", userId: f.alice.id, label: "Bad" },
    { type: "revoke_token", tokenId: f.a.tokenId },
    { type: "list_tokens" }, { type: "assign_owner", target: "calendar", id: f.ac.id, userId: f.bob.id },
  ]) expect((await f.call(f.b.token, command)).status).toBe(403);
  expect((await f.call(f.a.token, { type: "update_event", id: event.id, patch: { calendarId: f.bc.id } })).status).toBe(403);
  expect((await f.call(f.a.token, { type: "complete_event", id: event.id, completed: true })).status).toBe(200);
  expect((await f.call(f.a.token, { type: "delete_event", id: event.id })).status).toBe(200);
  const group = await f.call(f.a.token, { type: "create_group", name: "School" });
  for (const command of [
    { type: "update_group", id: group.body.group.id, name: "Bad" },
    { type: "delete_group", id: group.body.group.id },
    { type: "create_calendar", name: "Bad", groupId: group.body.group.id },
    { type: "update_calendar", id: f.bc.id, patch: { groupId: group.body.group.id } },
  ]) expect((await f.call(f.b.token, command)).status).toBe(403);
});

test("strict validation, optimistic conflicts, durable idempotency, and token revocation", async () => {
  const f = await fixture();
  for (const malformed of [null, 4, "probe", [], {}, { type: "probe", reqId: "x", userId: f.alice.id },
    { type: "create_calendar", reqId: "x", name: "Bad", ownerUserId: f.bob.id }]) {
    expect((await f.send(f.a.token, malformed)).status).toBe(400);
  }
  const command = { type: "create_event", reqId: "replay", ifRevision: f.store.revision, event: { title: "Once", startDate: "2026-09-16" } };
  const first = await f.send(f.a.token, command);
  const retry = await f.send(f.a.token, command);
  expect(retry.body).toEqual(first.body);
  expect(f.store.snapshot().events).toHaveLength(1);
  expect((await f.send(f.a.token, { ...command, event: { ...command.event, title: "Different" } })).status).toBe(409);
  expect((await f.call(f.a.token, { type: "update_event", id: first.body.event.id, ifRevision: 0, patch: { notes: "Stale" } })).status).toBe(409);
  const remove = { type: "delete_event", reqId: "remove", id: first.body.event.id };
  expect((await f.send(f.a.token, remove)).status).toBe(200);
  expect((await f.send(f.a.token, remove)).status).toBe(200);
  // Tokens are stored hashed, never included in snapshots or deduplication records.
  const secrets = JSON.stringify(f.store.persistence.sql.query("SELECT * FROM tokens").all());
  expect(secrets.includes(f.a.token)).toBe(false);
  expect(JSON.stringify(f.store.snapshot()).includes(f.a.token)).toBe(false);
  f.auth.revokeToken(f.a.tokenId);
  expect((await f.call(f.a.token, { type: "whoami" })).status).toBe(401);
  const user = await f.call(f.admin.token, { type: "create_user", name: "Charlie" });
  expect(user.status).toBe(200);
  expect(f.store.snapshot().calendars.some(c => c.ownerUserId === user.body.user.id)).toBe(true);
});

test("token issuance is retry-safe without persisting the secret, and ownership migration is explicit", async () => {
  const f = await fixture();
  const issue = { type: "create_token", reqId: "token-retry", userId: f.alice.id, label: "AI" };
  const issued = await f.send(f.admin.token, issue);
  expect(issued.status).toBe(200);
  const count = f.auth.tokens().length;
  const retry = await f.send(f.admin.token, issue);
  expect(retry.status).toBe(409);
  expect(retry.body.message).toContain(issued.body.tokenId);
  expect(f.auth.tokens()).toHaveLength(count);
  expect(JSON.stringify(f.store.persistence.sql.query("SELECT * FROM requests").all()).includes(issued.body.token)).toBe(false);
  const group = await f.call(f.a.token, { type: "create_group", name: "Alice school" });
  await f.call(f.a.token, { type: "update_calendar", id: f.ac.id, patch: { groupId: group.body.group.id } });
  const event = await f.call(f.a.token, { type: "create_event", event: { title: "Migrated", startDate: "2026-09-16" } });
  expect((await f.call(f.admin.token, { type: "assign_owner", target: "group", id: group.body.group.id, userId: f.bob.id })).status).toBe(200);
  expect(f.store.snapshot().calendars.find(c => c.id === f.ac.id)?.ownerUserId).toBe(f.bob.id);
  expect((await f.call(f.a.token, { type: "update_event", id: event.body.event.id, patch: { title: "Denied" } })).status).toBe(403);
  expect((await f.call(f.b.token, { type: "update_event", id: event.body.event.id, patch: { title: "Allowed" } })).status).toBe(200);
});

test("SSE starts with a snapshot, publishes changes, and stops after revocation", async () => {
  const f = await fixture(), abort = new AbortController();
  cleanups.push(() => abort.abort());
  const response = await fetch(f.url + "/v1/changes", { headers: { Authorization: `Bearer ${f.b.token}` }, signal: abort.signal });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  expect(first).toContain('"type":"bootstrap"');
  await f.call(f.a.token, { type: "create_event", event: { title: "Live", startDate: "2026-09-16" } });
  const change = new TextDecoder().decode((await reader.read()).value);
  expect(change).toContain('"type":"event_created"');
  expect(change).toContain('"reqId":"broadcast:');
  f.auth.revokeToken(f.b.tokenId);
  await f.call(f.a.token, { type: "create_event", event: { title: "No leak", startDate: "2026-09-16" } });
  expect((await reader.read()).done).toBe(true);
});

test("token-authenticated Unix socket denies anonymous reads and accepts authenticated requests", async () => {
  const f = await fixture();
  const socket = connect(join(f.root, "cald.sock"));
  cleanups.push(() => { socket.destroy(); });
  const events: Event[] = [];
  let buffer = "";
  socket.on("data", chunk => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) { events.push(JSON.parse(buffer.slice(0, newline))); buffer = buffer.slice(newline + 1); }
  });
  await new Promise<void>(resolve => socket.once("connect", resolve));
  socket.write(JSON.stringify({ type: "bootstrap" }) + "\n");
  await waitFor(() => events.length === 1);
  expect(events[0]).toMatchObject({ type: "error", code: "unauthorized" });
  socket.write(JSON.stringify({ type: "authenticate", reqId: "auth", token: f.a.token }) + "\n");
  socket.write(JSON.stringify({ type: "whoami", reqId: "who" }) + "\n");
  await waitFor(() => events.length === 3);
  expect(events[2]).toMatchObject({ type: "identity", user: { id: f.alice.id } });
});

test("real CLI and TUI client use HTTP, preserve source selection, and do not need a local daemon", async () => {
  const f = await fixture();
  const run = async (...args: string[]) => {
    const process = Bun.spawn([Bun.which("bun")!, resolve(import.meta.dir, "../../cli/src/main.ts"), ...args], {
      env: { ...globalThis.process.env, CAL_PROFILE: "", CAL_CONFIG_DIR: f.root, CAL_SERVER_URL: f.url, CAL_TOKEN: f.a.token, CAL_TOKEN_FILE: "" },
      stdout: "pipe", stderr: "pipe",
    });
    const code = await process.exited;
    return { code, out: await new Response(process.stdout).text(), err: await new Response(process.stderr).text() };
  };
  const result = await run("event", "create", "--title", "CLI", "--date", "2026-09-16", "--json");
  expect(result.code).toBe(0);
  expect(JSON.parse(result.out).calendarId).toBe(f.ac.id);
  const received: Event[] = [];
  const client = new DaemonClient(event => { if (event.type !== "route_status") received.push(event); }, "/nonexistent", { name: "test", url: f.url, token: f.b.token });
  cleanups.push(() => client.disconnect());
  await client.connect();
  await waitFor(() => received.some(e => e.type === "bootstrap"));
  const id = client.createEvent({ title: "TUI", startDate: "2026-09-16" });
  await waitFor(() => received.some(e => e.type === "event_created" && e.reqId === id));
  expect(f.store.snapshot().events.find(e => e.title === "TUI")?.calendarId).toBe(f.bc.id);
  client.disconnect();
  client.createEvent({ title: "Do not queue", startDate: "2026-09-16" });
  await client.connect();
  expect(f.store.snapshot().events.some(e => e.title === "Do not queue")).toBe(false);
});

test("JSON migration is lossless, non-destructive and fail-closed; SQLite rolls back failed commands", () => {
  const root = mkdtempSync(join(tmpdir(), "cal-migration-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const original: CalendarDatabase = {
    version: 1, revision: 42,
    calendars: [{ id: "c", name: "Old", color: "#112233", visible: false, createdAt: "old", updatedAt: "old", groupId: "g" }],
    groups: [{ id: "g", name: "Group", createdAt: "old", updatedAt: "old" }],
    events: [{ id: "e", calendarId: "c", title: "Quiz", kind: "deadline", startDate: "2026-09-16", endDate: "2026-09-16",
      recurrence: { frequency: "weekly", interval: 1 }, completedDates: ["2026-09-16"], notes: "Keep", createdAt: "old", updatedAt: "old" }],
  };
  const path = join(root, "calendar.json"), source = JSON.stringify(original);
  writeFileSync(path, source);
  const store = new CalendarStore(path);
  cleanups.push(() => store.persistence.close());
  expect(store.snapshot().events).toEqual(original.events);
  expect(store.snapshot().calendars[0]).toMatchObject({ ...original.calendars[0], ownerUserId: "local" });
  expect(readFileSync(path, "utf8")).toBe(source);
  expect(readFileSync(join(root, "calendar.sqlite")).subarray(0, 15).toString()).toBe("SQLite format 3");
  const before = store.snapshot();
  expect(() => store.transaction("local", () => { store.deleteEvent("e"); throw new Error("rollback"); })).toThrow("rollback");
  expect(store.snapshot()).toEqual(before);
  const reopened = new CalendarStore(path);
  expect(reopened.snapshot()).toEqual(before); reopened.persistence.close();
  const badPath = join(root, "bad.json");
  writeFileSync(badPath, "{broken");
  expect(() => new CalendarStore(badPath)).toThrow();
  expect(readFileSync(badPath, "utf8")).toBe("{broken");
});

test("unsupported SQLite schema is rejected without modifications", () => {
  const root = mkdtempSync(join(tmpdir(), "cal-future-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "calendar.sqlite");
  const db = new Database(path, { create: true });
  db.exec("CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT); INSERT INTO metadata VALUES ('schema', '999');");
  db.close();
  const before = readFileSync(path);
  expect(() => new CalendarStore(path)).toThrow("Unsupported");
  expect(readFileSync(path)).toEqual(before);
  const malformed = join(root, "malformed.sqlite");
  const bad = new Database(malformed, { create: true });
  bad.exec("CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT); INSERT INTO metadata VALUES ('schema', '1'); CREATE TABLE users(wrong TEXT);");
  bad.close();
  const badBefore = readFileSync(malformed);
  expect(() => new CalendarStore(malformed)).toThrow("Incompatible");
  expect(readFileSync(malformed)).toEqual(badBefore);
});

test("auth-required daemon remains discoverable and a second startup cannot unlink its live socket", async () => {
  const root = mkdtempSync(join(tmpdir(), "cal-auth-start-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, CAL_CONFIG_DIR: root, CAL_SOCKET_AUTH: "required", CAL_HTTP_PORT: "", CAL_PROFILE: "", CAL_SERVER_URL: "" };
  const main = resolve(import.meta.dir, "main.ts");
  const daemon = Bun.spawn([process.execPath, main], { env, stdout: "ignore", stderr: "pipe" });
  cleanups.push(async () => { daemon.kill(); await daemon.exited; });
  const status = async () => {
    const p = Bun.spawn([process.execPath, main, "status"], { env, stdout: "ignore", stderr: "ignore" });
    return await p.exited;
  };
  const deadline = Date.now() + 3000;
  while (await status() !== 0) { if (Date.now() > deadline) throw new Error("Daemon never became ready."); await Bun.sleep(20); }
  const pid = readFileSync(join(root, "runtime/cald.pid"), "utf8");
  const duplicate = Bun.spawn([process.execPath, main], { env, stdout: "ignore", stderr: "ignore" });
  expect(await duplicate.exited).toBe(1);
  expect(await status()).toBe(0);
  expect(readFileSync(join(root, "runtime/cald.pid"), "utf8")).toBe(pid);
});

test("failed TUI route switch retains the previous working connection and profile", async () => {
  const f = await fixture();
  const events: any[] = [];
  const client = new DaemonClient(event => events.push(event), "/nonexistent", { name: "Alice", url: f.url, token: f.a.token });
  cleanups.push(() => client.disconnect());
  await client.connect();
  await waitFor(() => events.some(e => e.type === "bootstrap"));
  await client.switchProfile("a-profile-that-does-not-exist");
  expect(client.connected).toBe(true);
  expect(client.remoteAlias).toBe("http:Alice");
  expect(events.at(-1)).toMatchObject({ type: "route_status", state: "failed", retained: true, mode: "remote", alias: "http:Alice" });
  const id = client.createEvent({ title: "Still Alice", startDate: "2026-09-16" });
  await waitFor(() => events.some(e => e.type === "event_created" && e.reqId === id));
});

test("named profiles share credentials and routing across CLI and remote-default integration", async () => {
  const f = await fixture();
  writeFileSync(join(f.root, "alice.token"), f.a.token, { mode: 0o600 });
  writeFileSync(join(f.root, "bob.token"), f.b.token, { mode: 0o600 });
  writeFileSync(join(f.root, "connections.json"), JSON.stringify({
    defaultProfile: "bob",
    profiles: {
      local: { socket: "cald.sock", tokenFile: "alice.token" },
      bob: { url: f.url, tokenFile: "bob.token" },
    },
  }));
  const env = { ...process.env, CAL_CONFIG_DIR: f.root, CAL_PROFILE: "", CAL_SERVER_URL: "", CAL_TOKEN: "", CAL_TOKEN_FILE: "" };
  const run = async (profile: string) => {
    const p = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../cli/src/main.ts"), "--profile", profile, "whoami"], {
      env, stdout: "pipe", stderr: "pipe",
    });
    return { code: await p.exited, out: await new Response(p.stdout).text() };
  };
  const remote = await run("bob");
  expect(remote.code).toBe(0); expect(JSON.parse(remote.out).id).toBe(f.bob.id);
  const local = await run("local");
  expect(local.code).toBe(0); expect(JSON.parse(local.out).id).toBe(f.alice.id);
  expect((await run("unknown")).code).toBe(1);
  const wrapper = Bun.spawn(["bash", resolve(import.meta.dir, "../../integrations/exocortex/bin/cald-supervisor")], {
    env: { ...env, WHALE_CAL_ROOT: resolve(import.meta.dir, "../.."), BUN_BIN: process.execPath },
    stdout: "pipe", stderr: "pipe",
  });
  expect(await wrapper.exited).toBe(0);
  expect(existsSync(join(f.root, "runtime/cald.pid"))).toBe(false);
});

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!condition()) { if (Date.now() > deadline) throw new Error("Timed out"); await Bun.sleep(10); }
}
