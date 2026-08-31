import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CalendarStore } from "./store";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function store(): { store: CalendarStore; path: string } {
  const root = mkdtempSync(join(tmpdir(), "whale-cal-store-"));
  roots.push(root);
  const path = join(root, "calendar.json");
  return { store: new CalendarStore(path), path };
}

describe("CalendarStore", () => {
  test("persists an atomically created event", () => {
    const instance = store();
    const calendarId = instance.store.snapshot().calendars[0]!.id;
    const event = instance.store.createEvent({ calendarId, title: "Dentist", startDate: "2026-09-02", startTime: "10:00", endTime: "11:00" });
    expect(instance.store.revision).toBe(1);
    expect(new CalendarStore(instance.path).snapshot().events[0]?.id).toBe(event.id);
    expect(JSON.parse(readFileSync(instance.path, "utf8")).revision).toBe(1);
  });

  test("validates temporal ordering", () => {
    const instance = store();
    expect(() => instance.store.createEvent({ title: "Bad", startDate: "2026-09-02", startTime: "11:00", endTime: "10:00" })).toThrow("after");
    expect(instance.store.revision).toBe(0);
  });

  test("explicit nulls clear optional fields during update", () => {
    const instance = store();
    const event = instance.store.createEvent({
      title: "Standup", startDate: "2026-09-02", startTime: "09:00", endTime: "09:15",
      location: "Office", recurrence: { frequency: "weekly", interval: 1 },
    });
    const updated = instance.store.updateEvent(event.id, {
      startTime: null, endTime: null, location: null, recurrence: null,
    });
    expect(updated.startTime).toBeUndefined();
    expect(updated.location).toBeUndefined();
    expect(updated.recurrence).toBeUndefined();
  });

  test("does not delete a non-empty calendar", () => {
    const instance = store();
    const original = instance.store.snapshot().calendars[0]!;
    instance.store.createCalendar("Work");
    instance.store.createEvent({ calendarId: original.id, title: "Busy", startDate: "2026-09-02" });
    expect(() => instance.store.deleteCalendar(original.id)).toThrow("events");
  });
});
