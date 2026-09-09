import { expect, test } from "bun:test";
import type { CalendarEvent } from "@whale-cal/shared/types";
import { occurrencesOnDate } from "@whale-cal/shared/dates";
import { daySchedule } from "./day-schedule";
import { moveTimelineSelection, renderDayTimeline, timelineLayout } from "./day-timeline";
import { createState, selectDate } from "./state";
import { stripAnsi, width } from "./text";
import { eventColor, theme } from "./theme";

const date = "2026-09-14";
const event = (id: string, startTime?: string, endTime?: string, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({ id, title: id, calendarId: "work", startDate: date, endDate: date, startTime, endTime, createdAt: "", updatedAt: "", ...extra });
const items = [event("Lecture", "10:10", "11:00"), event("Study", "10:30", "11:30"), event("Call", "11:00", "12:00")];
const layout = (events = items, day = date) => timelineLayout(daySchedule(occurrencesOnDate(events, day), day).rows);
function fixture(events = items) {
  const s = createState(); s.selectedDate = date;
  s.database.events = events;
  s.database.calendars = [{ id: "work", name: "Work", color: "#1d9bf0", visible: true, createdAt: "", updatedAt: "" }];
  return s;
}

test("parallel cards share a time axis, reuse adjacent lanes, and expand after overlap groups", () => {
  const { cards } = layout([...items, event("Later", "14:00", "15:00")]);
  expect(cards.map(c => c.lane)).toEqual([0, 1, 0, 0]);
  expect(cards.map(c => c.lanes)).toEqual([2, 2, 2, 1]);
  expect(cards[0]!.bottom + 1).toBe(cards[2]!.top);
  expect(cards[1]!.top).toBeGreaterThan(cards[0]!.top);
  expect(cards[1]!.top).toBeLessThan(cards[0]!.bottom);
  expect(cards[1]!.bottom).toBeGreaterThan(cards[2]!.top);
});

test("identical and nested reservations never collide in a lane; markers stay above the axis", () => {
  const data = layout([event("A", "10:00", "12:00"), event("B", "10:00", "12:00"), event("C", "10:15", "10:16"), event("Due", "10:15", undefined, { kind: "deadline" }), event("Note"), event("Unknown", "10:30")]);
  expect(data.cards).toHaveLength(3);
  expect(data.cards.map(c => c.lane)).toEqual([0, 1, 2]);
  expect(data.cards[0]!.top).toBe(data.cards[1]!.top);
  expect(data.cards[2]!.bottom - data.cards[2]!.top).toBeGreaterThanOrEqual(2);
  expect(data.markers).toHaveLength(3);
  expect(data.spans[0]!.top).toBe(5);
  expect(data.spans.filter(s => !s.busy).every(s => s.height === 3)).toBe(true);
});

test("rendered concurrent cards have distinct clickable columns on shared rows", () => {
  const s = fixture();
  const rendered = renderDayTimeline(s, occurrencesOnDate(items, date), 96, 40, new Date("2026-09-13T12:00:00"));
  expect(rendered.rows.every(row => width(row) === 96)).toBe(true);
  const left = rendered.hits.filter(hit => hit.index === 0);
  const right = rendered.hits.filter(hit => hit.index === 1);
  const shared = left.find(a => right.some(b => b.row === a.row));
  expect(shared).toBeDefined();
  expect(shared!.right).toBeLessThan(right.find(b => b.row === shared!.row)!.left);
  expect(rendered.rows.map(stripAnsi).join("\n")).toContain("Free 12:00–24:00");
  expect(rendered.rows.map(stripAnsi).join("\n")).not.toContain("∥");
});

test("selection changes the background, not the card's outline or title color", () => {
  for (const completed of [false, true]) {
    const events = [event("Lecture", "10:00", "11:00", { completed })];
    const s = fixture(events);
    s.database.calendars[0]!.color = "#8b5cf6";
    const border = completed ? theme.muted : eventColor("#8b5cf6");
    for (const selected of [false, true]) {
      s.selectedEventIndex = selected ? 0 : -1;
      const rendered = renderDayTimeline(s, occurrencesOnDate(events, date), 80, 30, new Date("2026-09-13T12:00:00"));
      const bg = selected ? theme.sidebarSelBg : theme.appBg;
      expect(rendered.rows.some(row => row.includes(bg + border + "┌"))).toBe(true);
      expect(rendered.rows.some(row => row.includes(bg + border + "│"))).toBe(true);
      expect(rendered.rows.some(row => row.includes(bg + border + "└"))).toBe(true);
      expect(rendered.rows.join("\n")).not.toContain(theme.accent + theme.bold + "┌");
    }
  }
});

test("keyboard selection follows the marker section before timed cards", () => {
  const occurrences = occurrencesOnDate([event("Work", "09:00", "10:00"), event("Due", "15:00", undefined, { kind: "deadline" }), event("Call", "17:00", "18:00")], date);
  const rows = daySchedule(occurrences, date).rows;
  expect(moveTimelineSelection(rows, 1, 1)).toBe(0);
  expect(moveTimelineSelection(rows, 0, 1)).toBe(2);
  expect(moveTimelineSelection(rows, 2, 1)).toBe(1);
  expect(moveTimelineSelection(rows, 1, -1)).toBe(2);
});

test("a dedicated live time line crosses cards without overwriting their titles or hit targets", () => {
  const s = fixture(); s.dayTimelineScroll = 0;
  const rendered = renderDayTimeline(s, occurrencesOnDate(items, date), 96, 40, new Date(`${date}T10:35:00`));
  const line = rendered.rows.findIndex(row => stripAnsi(row).startsWith("10:35▶"));
  expect(line).toBeGreaterThan(0);
  expect(rendered.hits.some(hit => hit.row === line)).toBe(false);
  expect(rendered.rows.map(stripAnsi).join("\n")).toContain("┌▸ Lecture");
  expect(rendered.rows.map(stripAnsi).join("\n")).toContain("┌Study");
  expect(rendered.rows.every(row => width(row) === 96)).toBe(true);
});

test("many concurrent lanes and vertical scrolling keep every selected card reachable", () => {
  const events = Array.from({ length: 8 }, (_, i) => event(`Meeting ${i} 東京`, "10:00", "16:00"));
  const s = fixture(events);
  for (let i = 0; i < events.length; i++) {
    s.selectedEventIndex = i;
    const rendered = renderDayTimeline(s, occurrencesOnDate(events, date), 50, 5);
    expect(rendered.hits.some(hit => hit.index === i)).toBe(true);
    expect(rendered.laneNote).toContain("lanes");
    expect(rendered.rows.every(row => width(row) === 50)).toBe(true);
  }
  s.dayTimelineScroll = 10000;
  const scrolled = renderDayTimeline(s, occurrencesOnDate(events, date), 50, 5);
  expect(scrolled.scroll).toBe(scrolled.maxScroll);
  expect(scrolled.rows.map(stripAnsi).join("\n")).toContain("Free 16:00–24:00");
  selectDate(s, "2026-09-15");
  expect(s.dayTimelineScroll).toBeNull();
});

test("recurring overnight cards are clipped and align to next-day reservations", () => {
  const night = event("Night", "22:00", "02:00", { startDate: "2026-09-06", endDate: "2026-09-07", recurrence: { frequency: "weekly", interval: 1, count: 3 } });
  const { cards } = layout([night, event("Early", "01:30", "03:00")]);
  expect(cards[0]).toMatchObject({ start: 0, end: 120, lane: 0, lanes: 2 });
  expect(cards[1]).toMatchObject({ start: 90, end: 180, lane: 1, lanes: 2 });
});
