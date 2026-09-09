import { afterEach, expect, setSystemTime, test } from "bun:test";
import type { CalendarEvent } from "@whale-cal/shared/types";
import { occurrencesOnDate } from "@whale-cal/shared/dates";
import { daySchedule, scheduleNow } from "./day-schedule";
import { createState } from "./state";
import { buildFrame } from "./render";
import { stripAnsi, width } from "./text";
import { theme } from "./theme";

const day = "2026-09-07";
const event = (id: string, startTime?: string, endTime?: string, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id, title: id, calendarId: "work", startDate: day, endDate: day, startTime, endTime, createdAt: "", updatedAt: "", ...extra,
});
const events = [event("Lecture", "10:10", "11:00"), event("Call", "10:30", "10:45"), event("Lunch", "12:15", "13:00")];
const rowsFor = (items = events, date = day) => daySchedule(occurrencesOnDate(items, date), date).rows;
const at = (time: string) => new Date(`${day}T${time}:00`);
afterEach(() => setSystemTime());

test("Now follows exact boundaries, overlaps and free blocks without rounding", () => {
  const rows = rowsFor();
  expect(scheduleNow(rows, day, at("10:09"))?.rows[0]?.kind).toBe("free");
  expect(scheduleNow(rows, day, at("10:10"))?.rows).toEqual([rows.find(r => r.kind === "event" && r.eventIndex === 0)!]);
  expect(scheduleNow(rows, day, at("10:30"))?.rows).toHaveLength(2);
  expect(scheduleNow(rows, day, at("10:45"))?.rows).toHaveLength(1);
  expect(scheduleNow(rows, day, at("11:00"))?.rows[0]).toMatchObject({ kind: "free", start: 660, end: 735 });
  expect(scheduleNow(rows, day, at("23:59"))?.rows[0]?.kind).toBe("free");
  expect(scheduleNow(rows, "2026-09-08", at("10:30"))).toBeNull();
  expect(scheduleNow(rows, day, new Date("2026-09-08T00:00:00"))).toBeNull();
});

test("point markers do not become current blocks; overnight recurring reservations do", () => {
  const markers = [event("All day"), event("Unknown", "10:00"), event("Due", "10:00", undefined, { kind: "deadline" })];
  expect(scheduleNow(rowsFor(markers), day, at("10:00"))?.rows.map(r => r.kind)).toEqual(["free"]);
  const overnight = event("Night", "22:00", "02:00", { startDate: "2026-08-30", endDate: "2026-08-31", recurrence: { frequency: "weekly", interval: 1, count: 3 } });
  expect(scheduleNow(rowsFor([overnight]), day, at("00:00"))?.rows[0]).toMatchObject({ kind: "event", start: 0, end: 120 });
  expect(scheduleNow(rowsFor([overnight]), day, at("02:00"))?.rows[0]?.kind).toBe("free");
});

function fixture(cols = 160, rows = 36) {
  const s = createState(); s.cols = cols; s.rows = rows; s.dayOpen = true; s.selectedDate = day;
  s.database.calendars = [{ id: "work", name: "Work", visible: true, color: "#1d9bf0", createdAt: "", updatedAt: "" }];
  s.database.events = events; s.selectedEventIndex = 2;
  return s;
}

test("live day rendering keeps selection independent and updates from busy to free", () => {
  setSystemTime(at("10:35"));
  const s = fixture();
  let frame = buildFrame(s);
  let plain = frame.rows.map(stripAnsi).join("\n");
  expect(plain).toContain("Now 10:35");
  // Keyboard selection follows Lunch; the Now summary remains visible even
  // when the live line is above the scrolled viewport.
  const selectedRow = frame.rows.find(row => stripAnsi(row).includes("▸ Lunch"))!;
  expect(selectedRow).toContain(theme.sidebarSelBg);
  expect(s.selectedEventIndex).toBe(2);
  setSystemTime(at("11:00"));
  plain = buildFrame(s).rows.map(stripAnsi).join("\n");
  expect(plain).toContain("Now 11:00");
  s.dayTimelineScroll = 0;
  plain = buildFrame(s).rows.map(stripAnsi).join("\n");
  expect(plain).toContain("11:00▶");
  expect(plain).toContain("Free 11:00–12:15");
  s.selectedDate = "2026-09-08";
  expect(buildFrame(s).rows.map(stripAnsi).join("\n")).not.toContain("Now");
});

test("Now fits compact layouts and leaves missing-end warnings visible", () => {
  setSystemTime(at("10:35"));
  for (const [cols, rows] of [[54, 18], [80, 24], [120, 36], [160, 48]]) {
    const s = fixture(cols, rows);
    s.database.events = [...events, event("Unknown", "09:00")];
    const frame = buildFrame(s);
    // Frames use absolute-column overlays, not a single concatenated text line.
    for (const row of frame.rows) {
      let column = 1;
      for (const part of row.split(/(\x1b\[\d+G)/)) {
        const move = /^\x1b\[(\d+)G$/.exec(part);
        if (move) column = Number(move[1]);
        else { expect(column - 1 + width(part)).toBeLessThanOrEqual(s.cols); column += width(part); }
      }
    }
    const plain = frame.rows.map(stripAnsi).join("\n");
    expect(plain).toContain("Now 10:35");
    expect(plain).toContain("1 missing end time");
  }
  const empty = fixture(); empty.database.events = [];
  const emptyText = buildFrame(empty).rows.map(stripAnsi).join("\n");
  expect(emptyText).toContain("Now 10:35");
  expect(emptyText).toContain("10:35▶");
  expect(emptyText).toContain("Free 00:00–24:00");
});
