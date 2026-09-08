import { expect, test } from "bun:test";
import type { CalendarEvent } from "@whale-cal/shared/types";
import { countdown, nextDeadline, nextEvent, renderStatusline } from "./statusline";
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
  const lines = renderStatusline(state, now);
  expect(lines).toHaveLength(2);
  expect(lines.every(line => width(line) === 54)).toBe(true);
  expect(stripAnsi(lines[0])).toStartWith("  Next Event: ");
  expect(stripAnsi(lines[0])).not.toContain("Happens in:");
  expect(stripAnsi(lines[1])).toContain("  Happens in: 1h30m");
  expect(lines.every(line => stripAnsi(line).includes("│"))).toBe(true);
  expect(stripAnsi(lines[0])).toContain("Next Deadline: none");
  state.database.calendars[0]!.visible = false;
  expect(stripAnsi(renderStatusline(state, now)[0])).toContain("Next Event: none");
  expect(stripAnsi(renderStatusline(state, now)[1])).toContain("Happens in: —");
  state.connected = false;
  expect(stripAnsi(renderStatusline(state, now)[0])).toContain("offline");
});

test("event and deadline blocks independently select upcoming incomplete occurrences", () => {
  const due = event({ id: "due", kind: "deadline", title: "Submit quiz", startTime: "13:00" });
  const meeting = event();
  expect(nextEvent([due, meeting], now)?.event.id).toBe(meeting.id);
  expect(nextDeadline([meeting, due], now)?.event.id).toBe(due.id);
  expect(nextEvent([due], now)).toBeNull();
  expect(nextDeadline([meeting], now)).toBeNull();
  expect(nextDeadline([{ ...due, completed: true }], now)).toBeNull();
  expect(nextDeadline([{ ...due, startTime: "09:00" }], now)).toBeNull();
  const recurring = { ...due, recurrence: { frequency: "weekly" as const, interval: 1, count: 2 }, completedDates: ["2026-09-06"] };
  expect(nextDeadline([recurring], now)?.date).toBe("2026-09-13");
  expect(nextDeadline([{ ...recurring, completedDates: ["2026-09-06", "2026-09-13"] }], now)).toBeNull();

  const state = createState(); state.cols = 120; state.connected = true;
  state.database.events = [meeting, due];
  state.database.calendars = [{ id: "cal", name: "Work", visible: true, color: "#fff", createdAt: "", updatedAt: "" }];
  let lines = renderStatusline(state, now).map(stripAnsi);
  expect(lines[0]).toContain("Next Event: Design review");
  expect(lines[0]).toContain("Next Deadline: Submit quiz");
  expect(lines[1]).toContain("Happens in: 1h30m");
  expect(lines[1]).toContain("Due in: 0h30m");
  expect(lines[0]!.indexOf("│")).toBe(lines[1]!.indexOf("│"));
  state.database.calendars[0]!.visible = false;
  lines = renderStatusline(state, now).map(stripAnsi);
  expect(lines[0]).toContain("Next Deadline: none");
  expect(lines[1]).toContain("Due in: —");
  state.connected = false;
  expect(stripAnsi(renderStatusline(state, now)[0])).toContain("Next Deadline: offline");
});

test("side-by-side blocks retain two rows and exact width with long Unicode titles", () => {
  const state = createState(); state.connected = true;
  state.database.calendars = [{ id: "cal", name: "Work", visible: true, color: "#fff", createdAt: "", updatedAt: "" }];
  state.database.events = [event({ title: "東京 👩‍💻 ".repeat(30) }), event({ kind: "deadline", title: "締切 👩‍💻 ".repeat(30) })];
  for (const cols of [54, 55, 80, 120, 160]) {
    state.cols = cols;
    const lines = renderStatusline(state, now);
    expect(lines).toHaveLength(2);
    expect(lines.every(line => width(line) === cols)).toBe(true);
    expect(stripAnsi(lines[0])).toContain("Next Deadline:");
    expect(stripAnsi(lines[1])).toContain("Due in: 1h30m");
  }
});

test("countdown follows local wall-time timestamps over DST changes", () => {
  const before = new Date("2027-03-14T01:30:00").getTime();
  const meeting = event({ startDate: "2027-03-14", startTime: "03:30" });
  expect(nextEvent([meeting], before)!.timestamp - before).toBe(new Date("2027-03-14T03:30:00").getTime() - before);
});
