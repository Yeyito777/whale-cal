import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CalendarStore } from "./store";
import { eventIsCompleted } from "@whale-cal/shared/dates";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function store(): { store: CalendarStore; path: string } {
  const root = mkdtempSync(join(tmpdir(), "whale-cal-store-"));
  roots.push(root);
  const path = join(root, "calendar.json");
  return { store: new CalendarStore(path), path };
}

describe("CalendarStore", () => {
  test("completion persists, is reversible and idempotent, and survives ordinary edits", () => {
    const instance = store();
    const event = instance.store.createEvent({ title: "Finish homework", startDate: "2026-09-09" });
    expect(eventIsCompleted(event)).toBe(false);
    expect(instance.store.completeEvent(event.id, true).completed).toBe(true);
    const revision = instance.store.revision;
    instance.store.completeEvent(event.id, true);
    expect(instance.store.revision).toBe(revision);
    const reopened = new CalendarStore(instance.path);
    expect(reopened.updateEvent(event.id, { title: "Updated title" }).completed).toBe(true);
    expect(reopened.completeEvent(event.id, false).completed).toBe(false);
    expect(() => reopened.completeEvent(event.id, "yes" as unknown as boolean)).toThrow("boolean");
    expect(() => reopened.completeEvent(event.id, true, "2026-09-10")).toThrow("No occurrence");
  });

  test("recurring completion belongs to one occurrence, including multi-day events", () => {
    const instance = store();
    const event = instance.store.createEvent({ title: "Weekly", startDate: "2026-09-01", endDate: "2026-09-02", recurrence: { frequency: "weekly", interval: 1, count: 3 } });
    expect(() => instance.store.completeEvent(event.id, true)).toThrow("requires");
    expect(() => instance.store.completeEvent(event.id, true, "2026-09-09")).toThrow("No occurrence");
    expect(() => instance.store.completeEvent(event.id, true, "2026-09-22")).toThrow("No occurrence");
    const done = instance.store.completeEvent(event.id, true, "2026-09-08");
    expect(eventIsCompleted(done, "2026-09-08")).toBe(true);
    expect(eventIsCompleted(done, "2026-09-01")).toBe(false);
    expect(eventIsCompleted(done, "2026-09-15")).toBe(false);
    const updated = new CalendarStore(instance.path).updateEvent(event.id, { notes: "New notes" });
    expect(updated.completedDates).toEqual(["2026-09-08"]);
    expect(instance.store.completeEvent(event.id, false, "2026-09-08").completedDates).toEqual([]);
  });

  test("turning a completed one-off into a series completes only its first occurrence", () => {
    const instance = store();
    const event = instance.store.createEvent({ title: "Task", startDate: "2026-09-01" });
    instance.store.completeEvent(event.id, true);
    const recurring = instance.store.updateEvent(event.id, { recurrence: { frequency: "weekly", interval: 1 } });
    expect(recurring.completedDates).toEqual(["2026-09-01"]);
    expect(eventIsCompleted(recurring, "2026-09-08")).toBe(false);
    expect(instance.store.updateEvent(event.id, { recurrence: null }).completed).toBe(true);
  });
  test("automatic colors survive deletion, hidden calendars, custom colors, and reload", () => {
    const instance = store();
    const original = instance.store.snapshot().calendars[0]!;
    const custom = instance.store.createCalendar("Custom", "#C792EA");
    instance.store.updateCalendar(custom.id, { visible: false });
    const removed = instance.store.createCalendar("Remove me");
    instance.store.deleteCalendar(removed.id);
    const reopened = new CalendarStore(instance.path);
    for (let i = 0; i < 30; i++) reopened.createCalendar(`Calendar ${i}`);
    const calendars = reopened.snapshot().calendars;
    expect(new Set(calendars.map(c => c.color.toLowerCase())).size).toBe(calendars.length);
    expect(calendars.find(c => c.id === original.id)!.color).toBe(original.color);
    expect(calendars.find(c => c.id === custom.id)!.color).toBe("#C792EA");
    // Explicit user choices remain valid, even when deliberately matching.
    expect(reopened.createCalendar("Matching", original.color).color).toBe(original.color);
  });
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
