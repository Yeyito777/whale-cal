import { expect, test } from "bun:test";
import type { CalendarEvent } from "@whale-cal/shared/types";
import { occurrencesOnDate } from "@whale-cal/shared/dates";
import { daySchedule, durationLabel, moveScheduleSelection, scheduleWindow } from "./day-schedule";
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

test("deadlines never reserve time, sort date-only items above the timeline, and retain exact due times", () => {
  const result = schedule([
    event("All-day note"),
    event("Date-only due", undefined, undefined, { kind: "deadline" }),
    event("Timed due", "15:05", undefined, { kind: "deadline" }),
    event("Work", "10:00", "11:00"),
  ]);
  expect(result.freeMinutes).toBe(23 * 60);
  expect(result.rows[0]).toMatchObject({ kind: "event", eventIndex: 1, time: "Due this day" });
  expect(result.rows.some(row => row.kind === "event" && row.time === "Due 15:05")).toBe(true);
  expect(result.rows.filter(row => row.kind === "free").map(row => row.time)).toEqual(["00:00–10:00", "11:00–15:05", "15:05–24:00"]);
  // j/k follows visual order even when date-only deadlines are lifted above notes.
  expect(moveScheduleSelection(result.rows, 1, 1)).toBe(0);
  expect(moveScheduleSelection(result.rows, 0, 1)).toBe(2);
  expect(moveScheduleSelection(result.rows, 1, -1)).toBe(3);
});

test("overlapping, nested and adjacent events never create false gaps or double-count busy time", () => {
  const result = schedule([event("A", "09:00", "12:00"), event("B", "10:00", "11:00"), event("C", "11:30", "13:00"), event("D", "13:00", "14:00")]);
  expect(result.freeMinutes).toBe(19 * 60);
  expect(result.rows.filter(r => r.kind === "free").map(r => r.time)).toEqual(["00:00–09:00", "14:00–24:00"]);
  expect(result.rows.filter(r => r.kind === "event")).toHaveLength(4);
});

test("all-day and missing-end markers remain visible without inventing busy time", () => {
  expect(schedule([])).toEqual({ rows: [{ kind: "free", start: 0, end: 1440, time: "00:00–24:00" }], freeMinutes: 1440 });
  const allDay = schedule([event("Due today")]);
  expect(allDay.freeMinutes).toBe(1440);
  expect(allDay.rows[0]).toMatchObject({ kind: "event", eventIndex: 0, time: "all-day" });
  expect(allDay.rows[1]).toMatchObject({ kind: "free", time: "00:00–24:00" });
  const unknown = schedule([event("Open-ended", "10:00"), event("Later", "12:00", "13:00")]);
  expect(unknown.freeMinutes).toBe(23 * 60);
  expect(unknown.rows[1]).toMatchObject({ kind: "event", time: "10:00–?" });
  expect(unknown.rows.filter(r => r.kind === "free").map(r => r.time)).toEqual(["00:00–10:00", "10:00–12:00", "13:00–24:00"]);
});

test("September 14: a start-only deadline cannot swallow gaps after overlapping classes", () => {
  const result = schedule([
    event("Weekly prep due", "09:00"), event("Lecture", "10:10", "11:00"),
    event("VIC163", "11:00", "13:00"), event("Study", "11:30", "12:15"),
    event("Seminar", "13:00", "15:00"), event("Tutorial", "14:00", "15:00"),
    event("Practice", "16:00", "17:30"),
  ]);
  expect(result.freeMinutes).toBe(1060);
  expect(result.rows.filter(r => r.kind === "free").map(r => r.time)).toEqual([
    "00:00–09:00", "09:00–10:10", "15:00–16:00", "17:30–24:00",
  ]);
  expect(result.rows.filter(r => r.kind === "event")).toHaveLength(7);
});

test("missing ends never introduce fake overnight reservations or double-count gaps", () => {
  const markers = [event("A", "09:00"), event("B", "09:00"), event("C", "23:55")];
  expect(schedule(markers).freeMinutes).toBe(1440);
  expect(schedule([event("Ongoing", "22:00", undefined, { startDate: "2026-09-10", endDate: "2026-09-12" })]).freeMinutes).toBe(1440);
});

test("free minutes equal the complement of explicit reservations across mixed schedules", () => {
  let seed = 14;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const time = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  for (let sample = 0; sample < 30; sample++) {
    const busy = Array<boolean>(1440).fill(false);
    const events: CalendarEvent[] = [];
    for (let i = 0; i < 15; i++) {
      const start = random() % 1439, end = start + 1 + random() % (1439 - start);
      const kind = random() % 3;
      events.push(event(String(i), kind === 0 ? undefined : time(start), kind === 2 ? time(end) : undefined));
      if (kind === 2) busy.fill(true, start, end);
    }
    const result = schedule(events);
    expect(result.freeMinutes).toBe(busy.filter(value => !value).length);
    const painted = Array<number>(1440).fill(0);
    for (const row of result.rows) if (row.kind === "free") {
      for (let minute = row.start; minute < row.end; minute++) painted[minute]!++;
    }
    expect(painted.every((count, minute) => count === (busy[minute] ? 0 : 1))).toBe(true);
  }
});

test("an all-day deadline cannot hide the gaps between classes and meetings", () => {
  const result = schedule([
    event("Form due"), event("Prep due", "09:00", "09:05"),
    event("Lecture", "09:10", "11:00"), event("Math", "15:00", "16:00"),
    event("Quiz due", "15:00", "15:05"), event("Plenary", "16:00", "18:00"),
    event("Meeting", "20:30", "21:30"),
  ]);
  expect(result.freeMinutes).toBe(1085);
  expect(result.rows.filter(r => r.kind === "free").map(r => r.time)).toEqual([
    "00:00–09:00", "09:05–09:10", "11:00–15:00", "18:00–20:30", "21:30–24:00",
  ]);
  expect(result.rows.filter(r => r.kind === "event").map(r => r.eventIndex)).toEqual([0, 1, 2, 3, 4, 5, 6]);
});

test("multi-day and recurring all-day markers do not consume timed availability", () => {
  const reminder = event("Reminder", undefined, undefined, {
    startDate: "2026-09-10", endDate: "2026-09-12",
    recurrence: { frequency: "weekly", interval: 1, count: 2 },
  });
  const result = schedule([reminder, event("Call", "10:00", "11:00", { startDate: "2026-09-18", endDate: "2026-09-18" })], "2026-09-18");
  expect(result.freeMinutes).toBe(23 * 60);
  expect(result.rows.filter(r => r.kind === "event")).toHaveLength(2);
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
  state.database.events = [event("Tutorial", "10:00", "11:00"), event("Seminar", "13:00", "14:00"), event("Hidden", "00:00", "23:59", { calendarId: "hidden" })];
  expect(daySchedule(eventsOnSelectedDate(state), date).freeMinutes).toBe(22 * 60);
  const frame = buildFrame(state);
  const text = frame.rows.map(stripAnsi).join("\n");
  expect(text).toContain("22h free");
  expect(text).toContain("11:00–13:00");
  expect(text).toContain("Free 11:00–13:00");
  expect([...new Set(state.layout.eventRows.map(r => r.index))]).toEqual([0, 1]);
  for (const hit of state.layout.eventRows) expect(stripAnsi(frame.rows[hit.row - 1]!)).not.toContain("Free ");
  expect(state.layout.dayList!.bottom).toBeGreaterThan(state.layout.eventRows.at(-1)!.row);
  state.database.events.push(event("All-day deadline"));
  const withReminder = buildFrame(state).rows.map(stripAnsi).join("\n");
  expect(withReminder).toContain("22h free");
  expect(withReminder).toContain("11:00–13:00");
  expect(withReminder).toContain("All-day deadline");
  state.database.events.push(event("End unspecified", "09:00"));
  const withMissingEnd = buildFrame(state).rows.map(stripAnsi).join("\n");
  expect(withMissingEnd).toContain("22h free");
  expect(withMissingEnd).toContain("1 missing end time");
  expect(withMissingEnd).toContain("09:00–?");
  expect(withMissingEnd).toContain("11:00–13:00");
});
