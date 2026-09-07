import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CalendarStore } from "../../daemon/src/store";
import { DaemonServer } from "../../daemon/src/server";
import { createHandler } from "../../daemon/src/handler";

test("CLI completes and reopens one recurring occurrence through real daemon IPC", async () => {
  const root = mkdtempSync(join(tmpdir(), "cal-done-"));
  mkdirSync(join(root, "runtime"));
  const store = new CalendarStore(join(root, "data/calendar.json"));
  const event = store.createEvent({ title: "Weekly task", startDate: "2026-09-01", recurrence: { frequency: "weekly", interval: 1, count: 3 } });
  let handler: ReturnType<typeof createHandler>;
  const oldLog = process.env.CAL_DISABLE_FILE_LOG;
  process.env.CAL_DISABLE_FILE_LOG = "1";
  const server = new DaemonServer(join(root, "runtime/cald.sock"), (client, command) => handler(client, command));
  handler = createHandler(server, store);
  const run = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "main.ts"), ...args], {
      env: { ...process.env, CAL_CONFIG_DIR: root }, stdout: "pipe", stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { out, err, code };
  };
  try {
    await server.start();
    const missingDate = await run("event", "complete", event.id, "--json");
    expect(missingDate.code).not.toBe(0);
    expect(missingDate.err).toContain("occurrence start date");
    const completed = await run("event", "complete", event.id, "--date", "2026-09-08", "--json");
    expect(completed.code).toBe(0);
    expect(JSON.parse(completed.out).completedDates).toEqual(["2026-09-08"]);
    const listing = await run("events", "--from", "2026-09-08", "--to", "2026-09-15");
    expect(listing.code).toBe(0);
    expect(listing.out.match(/\[done\]/g)).toHaveLength(1);
    const reopened = await run("event", "reopen", event.id, "--date", "2026-09-08", "--json");
    expect(reopened.code).toBe(0);
    expect(JSON.parse(reopened.out).completedDates).toEqual([]);
    const due = await run("event", "create", "--type", "deadline", "--title", "Submit quiz", "--date", "2026-09-14", "--start", "15:05", "--repeat", "weekly", "--count", "2", "--json");
    expect(due.code).toBe(0);
    const item = JSON.parse(due.out);
    expect(item.kind).toBe("deadline"); expect(item.startTime).toBe("15:05"); expect(item.endTime).toBeUndefined();
    const mark = await run("event", "complete", item.id, "--date", "2026-09-21", "--json");
    expect(mark.code).toBe(0); expect(JSON.parse(mark.out).completedDates).toEqual(["2026-09-21"]);
    const converted = await run("event", "update", item.id, "--type", "event", "--end", "16:00", "--json");
    expect(converted.code).toBe(0); expect(JSON.parse(converted.out).kind).toBe("event");
    const back = await run("event", "update", item.id, "--type", "deadline", "--json");
    expect(back.code).toBe(0); expect(JSON.parse(back.out).endTime).toBeUndefined();
    const invalid = await run("event", "create", "--type", "deadline", "--title", "Invalid range", "--date", "2026-09-14", "--start", "15:00", "--end", "16:00", "--json");
    expect(invalid.code).not.toBe(0); expect(invalid.err).toContain("duration");
    const badType = await run("event", "update", item.id, "--type", "other", "--json");
    expect(badType.code).not.toBe(0); expect(badType.err).toContain("--type");
    const dateOnly = await run("event", "create", "--type", "deadline", "--title", "Due on date", "--date", "2026-09-14", "--json");
    expect(dateOnly.code).toBe(0); expect(JSON.parse(dateOnly.out).startTime).toBeUndefined();
  } finally {
    await server.stop();
    if (oldLog === undefined) delete process.env.CAL_DISABLE_FILE_LOG; else process.env.CAL_DISABLE_FILE_LOG = oldLog;
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
