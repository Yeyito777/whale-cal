import { describe, expect, test } from "bun:test";
import { parseQuickAdd } from "./quick-add";

describe("quick add", () => {
  const now = new Date(2026, 7, 31, 12);

  test("parses relative date, range, and title", () => {
    expect(parseQuickAdd("tomorrow 09:00-10:30 Planning", { selectedDate: "2026-08-31", now })).toMatchObject({
      title: "Planning", startDate: "2026-09-01", endDate: "2026-09-01", startTime: "09:00", endTime: "10:30",
    });
  });

  test("uses the selected date when omitted", () => {
    expect(parseQuickAdd("all-day Birthday", { selectedDate: "2026-09-12", now })).toMatchObject({
      title: "Birthday", startDate: "2026-09-12",
    });
  });

  test("parses recurrence modifiers without putting them in the title", () => {
    expect(parseQuickAdd("fri 14:00 Focus repeat:weekly/2", { selectedDate: "2026-08-31", now })).toMatchObject({
      title: "Focus", startDate: "2026-09-04", recurrence: { frequency: "weekly", interval: 2 },
    });
  });

  test("rejects title-less input", () => {
    expect(() => parseQuickAdd("tomorrow 09:00", { selectedDate: "2026-08-31", now })).toThrow("title");
  });
});
