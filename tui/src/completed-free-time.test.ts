import { expect, test } from "bun:test";
import type { CalendarEvent } from "@whale-cal/shared/types";
import { occurrencesOnDate } from "@whale-cal/shared/dates";
import { daySchedule, scheduleNow, scheduleOverlaps } from "./day-schedule";
import { moveTimelineSelection, renderDayTimeline, timelineLayout } from "./day-timeline";
import { createState } from "./state";
import { stripAnsi, width } from "./text";
import { theme } from "./theme";

const date = "2026-09-09";
const event = (id: string, startTime: string, endTime: string, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({ id, title: id, calendarId: "work", startDate: date, endDate: date, startTime, endTime, createdAt: "", updatedAt: "", ...extra });
const fixture = () => [event("Lecture", "09:00", "11:00"), event("Quiz", "12:15", "13:00", { completed: true }), event("Math", "15:00", "16:00")];
const schedule = (events = fixture(), day = date) => daySchedule(occurrencesOnDate(events, day), day);

test("a completed event merges surrounding free time but retains its original interval", () => {
  const result = schedule();
  expect(result.rows.filter(row => row.kind === "free").map(row => row.time)).toEqual(["00:00–09:00", "11:00–15:00", "16:00–24:00"]);
  expect(result.freeMinutes).toBe(21 * 60);
  expect(result.rows.find(row => row.kind === "event" && row.eventIndex === 1)).toMatchObject({ start: 735, end: 780, completed: true });
  const layout = timelineLayout(result.rows);
  const free = layout.cards.find(card => card.kind === "free")!;
  const done = layout.cards.find(card => card.eventIndex === 1)!;
  expect(free).toMatchObject({ start: 660, end: 900, lanes: 2 });
  expect(free.group).toBe(done.group); expect(free.lane).not.toBe(done.lane);
  expect(free.top).toBeLessThan(done.top); expect(free.bottom).toBeGreaterThan(done.bottom);
  expect(moveTimelineSelection(result.rows, 0, 1)).toBe(1);
  expect(moveTimelineSelection(result.rows, 1, 1)).toBe(2);
  expect(moveTimelineSelection(result.rows, 2, 1)).toBe(0);
});

test("reopening restores the reservation and unfinished overlaps still block time", () => {
  const events = fixture(); events[1]!.completed = false;
  expect(schedule(events).rows.filter(row => row.kind === "free").map(row => row.time)).toEqual(["00:00–09:00", "11:00–12:15", "13:00–15:00", "16:00–24:00"]);
  expect(schedule(events).freeMinutes).toBe(20 * 60 + 15);
  expect(timelineLayout(schedule(events).rows).cards.every(card => card.kind === "event")).toBe(true);
  events[1]!.completed = true;
  events.push(event("Meeting", "12:30", "14:30"));
  const result = schedule(events);
  expect(result.freeMinutes).toBe(19 * 60);
  expect(result.rows.filter(row => row.kind === "free").map(row => row.time)).toEqual(["00:00–09:00", "11:00–12:30", "14:30–15:00", "16:00–24:00"]);
  expect(timelineLayout(result.rows).cards.filter(card => card.kind === "free").map(card => [card.start, card.end])).toEqual([[660, 750]]);
  expect(scheduleOverlaps(result.rows).size).toBe(0);
});

test("completion frees only its recurring occurrence, including an overnight continuation", () => {
  const recurring = event("Night", "22:00", "02:00", { startDate: "2026-09-08", endDate: date, recurrence: { frequency: "weekly", interval: 1, count: 3 }, completedDates: ["2026-09-08"] });
  expect(schedule([recurring]).freeMinutes).toBe(1440);
  expect(schedule([recurring], "2026-09-08").freeMinutes).toBe(1440);
  expect(schedule([recurring], "2026-09-16").freeMinutes).toBe(1320);
  const at = new Date(`${date}T01:00:00`);
  expect(scheduleNow(schedule([recurring]).rows, date, at)?.rows.map(row => row.kind)).toEqual(["free"]);
});

test("free cards share rows with completed history but are never selectable or clickable", () => {
  const s = createState(); s.selectedDate = date; s.selectedEventIndex = 1;
  s.database.calendars = [{ id: "work", name: "Work", color: "#8b5cf6", visible: true, createdAt: "", updatedAt: "" }];
  const events = fixture(); s.database.events = events;
  for (const columns of [50, 80, 120]) {
    const result = renderDayTimeline(s, occurrencesOnDate(events, date), columns, 30, new Date("2026-09-08T12:00:00"));
    const text = result.rows.map(stripAnsi).join("\n");
    expect(text).toContain("Free · 4h"); expect(text).toContain("11:00–15:00"); expect(text).toContain("✓ Quiz");
    expect(result.rows.join("\n")).toContain(theme.strike);
    expect(result.hits.every(hit => hit.index >= 0)).toBe(true);
    const doneHits = result.hits.filter(hit => hit.index === 1);
    expect(doneHits.length).toBeGreaterThan(0);
    expect(doneHits.every(hit => hit.left > columns / 2)).toBe(true);
    expect(result.rows.every(row => width(row) === columns)).toBe(true);
  }
});

test("a long merged availability remains labeled when scrolling to later completed history", () => {
  const s = createState(); s.selectedDate = date; s.selectedEventIndex = 1;
  const events = [event("Early", "08:00", "09:00", { completed: true }), event("Late", "18:00", "19:00", { completed: true })];
  s.database.events = events;
  const result = renderDayTimeline(s, occurrencesOnDate(events, date), 80, 6, new Date("2026-09-08T12:00:00"));
  const text = result.rows.map(stripAnsi).join("\n");
  expect(result.scroll).toBeGreaterThan(0);
  expect(text).toContain("Free · 24h"); expect(text).toContain("00:00–24:00");
  expect(text).toContain("✓ Late");
  expect(result.hits.some(hit => hit.index === 1)).toBe(true);
});

test("availability is exactly the complement of unfinished reservations in mixed schedules", () => {
  let seed = 9;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const time = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  for (let sample = 0; sample < 20; sample++) {
    const busy = Array<boolean>(1440).fill(false), events: CalendarEvent[] = [];
    for (let i = 0; i < 12; i++) {
      const start = random() % 1438, end = start + 1 + random() % (1439 - start), completed = random() % 3 === 0;
      events.push(event(String(i), time(start), time(end), { completed }));
      if (!completed) busy.fill(true, start, end);
    }
    const result = schedule(events), free = Array<number>(1440).fill(0);
    for (const row of result.rows) if (row.kind === "free") for (let m = row.start; m < row.end; m++) free[m]!++;
    expect(result.freeMinutes).toBe(busy.filter(value => !value).length);
    expect(free.every((count, m) => count === (busy[m] ? 0 : 1))).toBe(true);
    for (const card of timelineLayout(result.rows).cards.filter(card => card.kind === "free")) expect(busy.slice(card.start, card.end).some(Boolean)).toBe(false);
  }
});
