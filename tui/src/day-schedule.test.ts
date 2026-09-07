import { expect, test } from "bun:test";
import type { CalendarEvent } from "@whale-cal/shared/types";
import { occurrencesOnDate } from "@whale-cal/shared/dates";
import { daySchedule, durationLabel, scheduleWindow } from "./day-schedule";
import { createState, eventsOnSelectedDate } from "./state";
import { buildFrame } from "./render";
import { stripAnsi } from "./text";

const date = "2026-09-11";
function event(id: string, startTime?: string, endTime?: string, extra: Partial<CalendarEvent> = {}): CalendarEvent {
  return { id, title: id, calendarId: "work", startDate: date, endDate: date, startTime, endTime, createdAt: "", updatedAt: "", ...extra };
}
const schedule = (events: CalendarEvent[], day = date) => daySchedule(occurrencesOnDate(events, day), day);

test("shows morning, between-event and evening gaps with a correct daily total", () => {
  const result = schedule([event("Tutorial", "10:00", "11:00"), event("Seminar", "11:00", "13:00"), event("Advising", "15:00", "15:30"), event("Swing", "16:10", "18:00")]);
  expect(result.rows.filter(r => r.kind === "free").map(r => r.time)).toEqual(["00:00–10:00", "13:00–15:00", "15:30–16:10", "18:00–24:00"]);
  expect(result.freeMinutes).toBe(1120);
  expect(durationLabel(result.freeMinutes)).toBe("18h40m");
  expect(durationLabel(40)).toBe("40m");
  expect(durationLabel(0)).toBe("0m");
});

test("overlapping, nested and adjacent events never create false gaps or double-count busy time", () => {
  const result = schedule([event("A", "09:00", "12:00"), event("B", "10:00", "11:00"), event("C", "11:30", "13:00"), event("D", "13:00", "14:00")]);
  expect(result.freeMinutes).toBe(19 * 60);
  expect(result.rows.filter(r => r.kind === "free").map(r => r.time)).toEqual(["00:00–09:00", "14:00–24:00"]);
  expect(result.rows.filter(r => r.kind === "event")).toHaveLength(4);
});

test("empty days are fully free; all-day and unknown-duration events are conservative", () => {
  expect(schedule([])).toEqual({ rows: [{ kind: "free", start: 0, end: 1440, time: "00:00–24:00" }], freeMinutes: 1440 });
  expect(schedule([event("Offsite")]).freeMinutes).toBe(0);
  const unknown = schedule([event("Open-ended", "10:00"), event("Later", "12:00", "13:00")]);
  expect(unknown.freeMinutes).toBe(600);
  expect(unknown.rows[1]).toMatchObject({ kind: "event", time: "10:00–?" });
});

test("overnight and recurring multi-day occurrences clip to the inspected day", () => {
  const overnight = event("Overnight", "22:00", "02:00", { startDate: "2026-09-10", endDate: date });
  expect(schedule([overnight]).rows[0]).toMatchObject({ kind: "event", time: "00:00–02:00" });
  expect(schedule([overnight]).freeMinutes).toBe(22 * 60);
  expect(schedule([overnight], "2026-09-10").rows.at(-1)).toMatchObject({ kind: "event", time: "22:00–24:00" });
  const recurring = { ...overnight, recurrence: { frequency: "weekly" as const, interval: 1, count: 3 } };
  expect(schedule([recurring], "2026-09-18").freeMinutes).toBe(22 * 60);
  const multi = event("Trip", "15:00", "11:00", { startDate: "2026-09-10", endDate: "2026-09-12" });
  expect(schedule([multi]).freeMinutes).toBe(0);
});

test("an event ending at midnight does not occupy the following day", () => {
  const result = schedule([event("Until midnight", "23:00", "00:00", { startDate: "2026-09-10" })]);
  expect(result.freeMinutes).toBe(1440);
});

test("schedule scrolling always retains the real event index, not the inserted gap index", () => {
  const result = schedule([event("A", "10:00", "11:00"), event("B", "15:00", "16:00")]);
  expect(scheduleWindow(result.rows, 0, 3)).toBe(0);
  expect(scheduleWindow(result.rows, 1, 3)).toBe(2);
  for (const capacity of [1, 2, 3, 10]) {
    for (const selected of [0, 1]) {
      const start = scheduleWindow(result.rows, selected, capacity);
      expect(result.rows.slice(start, start + capacity).some(r => r.kind === "event" && r.eventIndex === selected)).toBe(true);
    }
  }
});

test("day render includes gaps, keeps them non-editable, and ignores hidden calendars", () => {
  const state = createState();
  Object.assign(state, { selectedDate: date, cols: 160, rows: 36, dayOpen: true, notice: null });
  state.database.calendars = [
    { id: "work", name: "Work", color: "#c792ea", visible: true, createdAt: "", updatedAt: "" },
    { id: "hidden", name: "Hidden", color: "#c792ea", visible: false, createdAt: "", updatedAt: "" },
  ];
  state.database.events = [event("Tutorial", "10:00", "11:00"), event("Seminar", "13:00", "14:00"), event("Hidden", undefined, undefined, { calendarId: "hidden" })];
  expect(daySchedule(eventsOnSelectedDate(state), date).freeMinutes).toBe(22 * 60);
  const frame = buildFrame(state);
  const text = frame.rows.map(stripAnsi).join("\n");
  expect(text).toContain("22h free");
  expect(text).toContain("11:00–13:00");
  expect(text).toContain("○ Free");
  expect(state.layout.eventRows.map(r => r.index)).toEqual([0, 1]);
  expect(state.layout.eventRows[1]!.row - state.layout.eventRows[0]!.row).toBe(2);
  for (const hit of state.layout.eventRows) expect(stripAnsi(frame.rows[hit.row - 1]!)).not.toContain("○ Free");
  expect(state.layout.dayList!.bottom).toBeGreaterThan(state.layout.eventRows.at(-1)!.row);
});
