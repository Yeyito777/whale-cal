import { expect, test } from "bun:test";
import type { CalendarEvent } from "@whale-cal/shared/types";
import { occurrencesOnDate } from "@whale-cal/shared/dates";
import { daySchedule, scheduleOverlaps } from "./day-schedule";
import { createState, eventsOnSelectedDate } from "./state";
import { buildFrame } from "./render";
import { stripAnsi, width } from "./text";
import { theme } from "./theme";

const day = "2026-09-14";
const event = (id: string, startTime?: string, endTime?: string, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id, title: id, calendarId: "work", startDate: day, endDate: day, startTime, endTime, createdAt: "", updatedAt: "", ...extra,
});
const events = [event("Lecture", "10:10", "11:00"), event("Study", "10:30", "11:30"), event("Call", "11:00", "12:00")];
const analyze = (items = events, date = day) => {
  const occurrences = occurrencesOnDate(items, date);
  const schedule = daySchedule(occurrences, date);
  return { occurrences, schedule, overlaps: scheduleOverlaps(schedule.rows) };
};

test("concurrency reports direct shared intervals, not transitive conflicts or adjacency", () => {
  const { overlaps, schedule } = analyze();
  expect(overlaps.size).toBe(3);
  expect(overlaps.get(0)).toEqual([{ eventIndex: 1, start: 630, end: 660, time: "10:30–11:00" }]);
  expect(overlaps.get(1)?.map(m => m.eventIndex)).toEqual([0, 2]);
  expect(overlaps.get(2)).toEqual([{ eventIndex: 1, start: 660, end: 690, time: "11:00–11:30" }]);
  expect(schedule.freeMinutes).toBe(24 * 60 - 110);
  expect(analyze([event("A", "09:00", "10:00"), event("B", "10:00", "11:00")]).overlaps.size).toBe(0);
});

test("nested intervals overlap, but completed history and point markers do not reserve time", () => {
  const { overlaps, occurrences } = analyze([
    event("A", "10:00", "12:00"), event("B", "10:00", "12:00", { completed: true }),
    event("Nested", "10:35", "10:45"), event("Date note"), event("Unknown", "10:00"),
    event("Due", "10:35", undefined, { kind: "deadline" }),
  ]);
  expect([...overlaps.keys()].map(i => occurrences[i]!.event.title).sort()).toEqual(["A", "Nested"]);
  expect([...overlaps.values()].every(matches => matches.length === 1)).toBe(true);
});

test("overnight recurring occurrences overlap only inside the inspected day", () => {
  const overnight = event("Night", "22:00", "02:00", { startDate: "2026-09-06", endDate: "2026-09-07", recurrence: { frequency: "weekly", interval: 1, count: 3 } });
  const { overlaps } = analyze([overnight, event("Early", "01:15", "03:00")]);
  expect(overlaps.size).toBe(2);
  expect(overlaps.get(0)?.[0]).toMatchObject({ start: 75, end: 120, time: "01:15–02:00" });
});

function fixture(cols = 180, rows = 40) {
  const s = createState(); s.cols = cols; s.rows = rows; s.selectedDate = day; s.notice = null;
  s.database.calendars = [{ id: "work", name: "Work", visible: true, color: "#1d9bf0", createdAt: "", updatedAt: "" }];
  s.database.events = events.map(e => ({ ...e }));
  return s;
}

test("day details explain exact overlaps while retaining independent selection and completion", () => {
  const s = fixture(); s.dayOpen = true;
  let frame = buildFrame(s); let text = frame.rows.map(stripAnsi).join("\n");
  expect(text).toContain("┌▸ Lecture");
  expect(text).toContain("┌Study");
  expect(text).toContain("Overlaps with");
  expect(text).toContain("10:30–11:00 · 30m shared");
  expect(text).not.toContain("11:00–11:30 · 30m shared");
  expect(s.layout.eventRows.find(r => r.index === 0)).toBeDefined();
  const selected = s.layout.eventRows.find(r => r.index === 0)!;
  expect(frame.rows[selected.row - 1]).toContain(theme.sidebarSelBg);
  s.selectedEventIndex = 1;
  text = buildFrame(s).rows.map(stripAnsi).join("\n");
  expect(text).toContain("10:30–11:00 · 30m shared");
  expect(text).toContain("11:00–11:30 · 30m shared");
  s.database.events[1]!.completed = true;
  frame = buildFrame(s);
  expect(frame.rows.map(stripAnsi).join("\n")).toContain("✓ Study");
  expect(frame.rows.join("\n")).toContain(theme.strike);
});

test("overview views stay uncluttered; hidden calendars do not create timeline overlaps", () => {
  const s = fixture();
  for (const view of ["month", "week", "agenda"] as const) {
    s.view = view;
    const frame = buildFrame(s);
    expect(frame.rows.map(stripAnsi).join("\n")).not.toContain("∥");
    expect(frame.rows.every(row => width(row) <= s.cols)).toBe(true);
  }
  // Hiding the other calendar must remove both the marker and shared-time details.
  s.database.events = [events[0]!, { ...events[1]!, calendarId: "hidden" }];
  s.database.calendars.push({ ...s.database.calendars[0]!, id: "hidden", visible: false });
  s.dayOpen = true;
  expect(eventsOnSelectedDate(s)).toHaveLength(1);
  expect(buildFrame(s).rows.map(stripAnsi).join("\n")).not.toContain("Overlaps with");
});

test("compact day lists keep selected rows clickable with concurrency summaries", () => {
  for (const [cols, rows] of [[54, 18], [80, 24], [120, 36]]) {
    const s = fixture(cols, rows); s.dayOpen = true;
    for (let index = 0; index < events.length; index++) {
      s.selectedEventIndex = index;
      const frame = buildFrame(s);
      expect(s.layout.eventRows.some(hit => hit.index === index)).toBe(true);
      for (const row of frame.rows) {
        let column = 1;
        for (const part of row.split(/(\x1b\[\d+G)/)) {
          const move = /^\x1b\[(\d+)G$/.exec(part);
          if (move) column = Number(move[1]);
          else { expect(column - 1 + width(part)).toBeLessThanOrEqual(cols!); column += width(part); }
        }
      }
    }
  }
});
