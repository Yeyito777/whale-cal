import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CalendarStore } from "../../daemon/src/store";
import { DaemonServer } from "../../daemon/src/server";
import { createHandler } from "../../daemon/src/handler";

test("external CLI organizes calendars through real daemon IPC and never deletes their items", async () => {
  const root = mkdtempSync(join(tmpdir(), "cal-groups-cli-")); mkdirSync(join(root, "runtime"));
  const store = new CalendarStore(join(root, "data/calendar.json"));
  const task = store.createEvent({ title: "Keep me", startDate: "2026-09-14" });
  let handler: ReturnType<typeof createHandler>;
  const oldLog = process.env.CAL_DISABLE_FILE_LOG; process.env.CAL_DISABLE_FILE_LOG = "1";
  const server = new DaemonServer(join(root, "runtime/cald.sock"), (client, command) => handler(client, command));
  handler = createHandler(server, store);
  const run = async (...args: string[]) => {
    const p = Bun.spawn([process.execPath, resolve(import.meta.dir, "main.ts"), ...args], { env: { ...process.env, CAL_CONFIG_DIR: root }, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { out, err, code };
  };
  const json = async (...args: string[]) => { const r = await run(...args, "--json"); expect(r.err).toBe(""); expect(r.code).toBe(0); return JSON.parse(r.out); };
  try {
    await server.start();
    expect(await json("groups")).toEqual([]);
    const group = await json("group", "create", "--name", "Yeyito");
    expect((await json("groups"))[0].id).toBe(group.id);
    const moved = await json("calendar", "update", "Personal", "--group", "Yeyito");
    expect(moved.groupId).toBe(group.id);
    const created = await json("calendar", "create", "--name", "Classes", "--group", group.id);
    expect(created.groupId).toBe(group.id);
    expect(await json("calendars", "--group", "Yeyito")).toHaveLength(2);
    const renamed = await json("group", "update", group.id, "--name", "Yeyito School");
    expect(renamed.id).toBe(group.id);
    expect((await run("calendar", "update", created.id, "--group", group.id, "--ungroup")).code).not.toBe(0);
    expect((await run("group", "delete", group.id)).code).not.toBe(0);
    expect((await run("calendar", "update", created.id, "--group", "missing")).code).not.toBe(0);
    expect((await json("calendar", "update", created.id, "--ungroup")).groupId).toBeUndefined();
    expect(await json("calendars", "--group", "Yeyito School")).toHaveLength(1);
    await json("group", "delete", "Yeyito School", "--yes");
    expect(await json("groups")).toEqual([]);
    expect((await json("calendars")).every((c: any) => !c.groupId)).toBe(true);
    expect(store.snapshot().events[0]!.id).toBe(task.id);
  } finally {
    await server.stop();
    if (oldLog === undefined) delete process.env.CAL_DISABLE_FILE_LOG; else process.env.CAL_DISABLE_FILE_LOG = oldLog;
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
