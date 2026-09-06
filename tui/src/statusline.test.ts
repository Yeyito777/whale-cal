import { expect, test } from "bun:test";
import type { CalendarEvent } from "@whale-cal/shared/types";
import { countdown, nextEvent, renderStatusline } from "./statusline";
import { createState } from "./state";
import { stripAnsi, width } from "./text";

const event = (changes: Partial<CalendarEvent> = {}): CalendarEvent => ({ id: "event", calendarId: "cal", title: "Design review", startDate: "2026-09-06", endDate: "2026-09-06", startTime: "14:00", createdAt: "", updatedAt: "", ...changes });
const now = new Date("2026-09-06T12:30:00").getTime();

test("next event is relative to now, not calendar selection; past starts are skipped", () => {
  const next = nextEvent([event({ startTime: "09:00" }), event(), event({ startTime: "16:00" })], now)!;
  expect(next.event.startTime).toBe("14:00");
  expect(countdown(next.timestamp - now)).toBe("1h30m");
  expect(countdown(20000)).toBe("0h01m");
  expect(countdown(0)).toBe("now");
});

test("recurring next occurrence respects count and inclusive until", () => {
  const weekly = event({ startDate: "2026-08-30", endDate: "2026-08-30", recurrence: { frequency: "weekly", interval: 1, count: 2 } });
  expect(nextEvent([weekly], now)!.date).toBe("2026-09-06");
  expect(nextEvent([weekly], new Date("2026-09-07T00:00:00").getTime())).toBeNull();
  expect(nextEvent([event({ ...weekly, recurrence: { frequency: "weekly", interval: 1, until: "2026-09-05" } })], now)).toBeNull();
});

test("monthly clamping, all-day midnight, and far-future events", () => {
  const monthly = event({ startDate: "2026-01-31", endDate: "2026-01-31", recurrence: { frequency: "monthly", interval: 1 } });
  expect(nextEvent([monthly], new Date("2026-02-01T00:00:00").getTime())!.date).toBe("2026-02-28");
  const allDay = event({ startTime: undefined, startDate: "2026-09-07" });
  expect(new Date(nextEvent([allDay], now)!.timestamp).getHours()).toBe(0);
  expect(nextEvent([event({ startDate: "2040-01-01" })], now)!.date).toBe("2040-01-01");
});

test("status blocks fit narrow terminals and honor hidden calendars", () => {
  const state = createState();
  state.cols = 54; state.connected = true; state.selectedDate = "2040-01-01";
  state.database.events = [event({ title: "A very long title 東京 👩‍💻 that needs truncation" })];
  state.database.calendars = [{ id: "cal", name: "Work", visible: true, color: "#fff", createdAt: "", updatedAt: "" }];
  let line = renderStatusline(state, now);
  expect(width(line)).toBe(54);
  expect(stripAnsi(line)).toContain("Happens in: 1h30m");
  state.database.calendars[0]!.visible = false;
  expect(stripAnsi(renderStatusline(state, now))).toContain("none scheduled");
  state.connected = false;
  expect(stripAnsi(renderStatusline(state, now))).toContain("offline");
});

test("countdown follows local wall-time timestamps over DST changes", () => {
  const before = new Date("2027-03-14T01:30:00").getTime();
  const meeting = event({ startDate: "2027-03-14", startTime: "03:30" });
  expect(nextEvent([meeting], before)!.timestamp - before).toBe(new Date("2027-03-14T03:30:00").getTime() - before);
});
