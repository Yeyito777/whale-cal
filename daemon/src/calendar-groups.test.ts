import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CalendarStore } from "./store";

test("groups persist, preserve calendar identity and visibility, and delete without deleting contents", () => {
  const root = mkdtempSync(join(tmpdir(), "cal-groups-"));
  const path = join(root, "calendar.json");
  try {
    let store = new CalendarStore(path);
    const legacy = store.snapshot();
    expect(legacy.groups).toBeUndefined();
    const personal = legacy.calendars[0]!;
    const event = store.createEvent({ title: "Quiz", kind: "deadline", startDate: "2026-09-14", calendarId: personal.id, recurrence: { frequency: "weekly", interval: 1, count: 2 } });
    store.completeEvent(event.id, true, "2026-09-14");
    const beforeEvents = store.snapshot().events;
    const group = store.createGroup("Yeyito");
    const another = store.createGroup("Together");
    store.updateCalendar(personal.id, { groupId: group.id, visible: false });
    const course = store.createCalendar("UofT", undefined, group.id);
    store = new CalendarStore(path);
    expect(store.snapshot().groups?.map(g => g.name)).toEqual(["Yeyito", "Together"]);
    expect(store.snapshot().calendars[0]).toMatchObject({ id: personal.id, groupId: group.id, visible: false });
    store.updateGroup(group.id, "Yeyito School");
    expect(store.snapshot().calendars.find(c => c.id === course.id)?.groupId).toBe(group.id);
    store.updateCalendar(course.id, { groupId: another.id });
    store.deleteGroup(group.id);
    expect(store.snapshot().calendars[0]).toMatchObject({ id: personal.id, visible: false });
    expect(store.snapshot().calendars[0]!.groupId).toBeUndefined();
    expect(store.snapshot().calendars.find(c => c.id === course.id)?.groupId).toBe(another.id);
    expect(store.snapshot().events).toEqual(beforeEvents);
    store.updateCalendar(course.id, { groupId: null });
    expect(JSON.parse(readFileSync(path, "utf8")).calendars.every((c: any) => !c.groupId)).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("invalid group operations are atomic and names are unique case-insensitively", () => {
  const root = mkdtempSync(join(tmpdir(), "cal-groups-invalid-"));
  try {
    const store = new CalendarStore(join(root, "calendar.json"));
    const one = store.createGroup("Yeyito"), two = store.createGroup("Selin");
    const calendar = store.snapshot().calendars[0]!;
    const before = store.snapshot();
    for (const operation of [
      () => store.createGroup(" yeyito "), () => store.createGroup(" "),
      () => store.updateGroup(two.id, "YEYITO"), () => store.updateGroup("missing", "Other"),
      () => store.createCalendar("Bad", undefined, "missing"),
      () => store.updateCalendar(calendar.id, { name: "Changed", groupId: "missing" }),
      () => store.updateCalendar(calendar.id, { groupId: one.id, color: "bad" }),
      () => store.deleteGroup("missing"),
    ]) {
      expect(operation).toThrow(); expect(store.snapshot()).toEqual(before);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
