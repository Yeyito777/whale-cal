import { expect, test } from "bun:test";
import { deadlineDueAt, deadlineIsOverdue, formatItemTime, occurrencesOnDate } from "./dates";
import type { CalendarEvent } from "./types";

const deadline: CalendarEvent = { id: "due", kind: "deadline", title: "Submit quiz", calendarId: "work", startDate: "2026-09-09", endDate: "2026-09-09", createdAt: "", updatedAt: "" };

test("date-only deadlines become overdue after the due day, not at midnight before it", () => {
  expect(deadlineDueAt(deadline, deadline.startDate)).toBe(new Date("2026-09-10T00:00:00").getTime());
  expect(deadlineIsOverdue(deadline, deadline.startDate, new Date("2026-09-09T23:59:59").getTime())).toBe(false);
  expect(deadlineIsOverdue(deadline, deadline.startDate, new Date("2026-09-10T00:00:00").getTime())).toBe(true);
  expect(formatItemTime(deadline)).toBe("Due this day");
});

test("timed deadlines have minute-precise due points and completed items aren't overdue", () => {
  const timed = { ...deadline, startTime: "15:05" };
  expect(formatItemTime(timed)).toBe("Due 15:05");
  expect(deadlineIsOverdue(timed, timed.startDate, new Date("2026-09-09T15:04:59").getTime())).toBe(false);
  expect(deadlineIsOverdue(timed, timed.startDate, new Date("2026-09-09T15:06:00").getTime())).toBe(true);
  expect(deadlineIsOverdue({ ...timed, completed: true }, timed.startDate, new Date("2027-01-01").getTime())).toBe(false);
  expect(deadlineIsOverdue({ ...timed, kind: "event" }, timed.startDate, new Date("2027-01-01").getTime())).toBe(false);
});

test("recurring deadlines retain their type and each occurrence's due date and completion", () => {
  const weekly = { ...deadline, recurrence: { frequency: "weekly" as const, interval: 1, count: 3 }, completedDates: ["2026-09-16"] };
  const occurrence = occurrencesOnDate([weekly], "2026-09-16")[0]!;
  expect(occurrence.event.kind).toBe("deadline");
  expect(deadlineIsOverdue(weekly, occurrence.startDate, new Date("2027-01-01").getTime())).toBe(false);
  expect(deadlineIsOverdue(weekly, "2026-09-23", new Date("2027-01-01").getTime())).toBe(true);
});

test("date-only due boundaries follow local calendar days across DST", () => {
  for (const date of ["2026-03-08", "2026-11-01"]) {
    const due = new Date(deadlineDueAt(deadline, date));
    expect(due.getHours()).toBe(0);
    const next = new Date(`${date}T12:00:00`); next.setDate(next.getDate() + 1);
    expect(due.getDate()).toBe(next.getDate());
  }
});
