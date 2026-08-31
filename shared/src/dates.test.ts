import { describe, expect, test } from "bun:test";
import { addDays, addMonths, daysBetween, isDateKey, monthMatrix, occurrencesForRange, startOfWeek } from "./dates";
import type { CalendarEvent } from "./types";

describe("calendar date arithmetic", () => {
  test("validates real calendar dates", () => {
    expect(isDateKey("2024-02-29")).toBe(true);
    expect(isDateKey("2023-02-29")).toBe(false);
    expect(isDateKey("2026-13-01")).toBe(false);
  });

  test("uses local calendar days without millisecond/DST drift", () => {
    expect(addDays("2026-03-08", 1)).toBe("2026-03-09");
    expect(daysBetween("2026-03-08", "2026-03-09")).toBe(1);
    expect(startOfWeek("2026-08-31", 1)).toBe("2026-08-31");
  });

  test("clamps month navigation to the destination month", () => {
    expect(addMonths("2025-01-31", 1)).toBe("2025-02-28");
    expect(addMonths("2024-01-31", 1)).toBe("2024-02-29");
  });

  test("builds a stable six-week month matrix", () => {
    const matrix = monthMatrix("2026-08-31", 1);
    expect(matrix).toHaveLength(6);
    expect(matrix[0]?.[0]).toBe("2026-07-27");
    expect(matrix[5]?.[6]).toBe("2026-09-06");
  });
});

describe("recurrence expansion", () => {
  const base: CalendarEvent = {
    id: "event", calendarId: "cal", title: "Standup", startDate: "2026-08-31", endDate: "2026-08-31",
    startTime: "09:00", endTime: "09:15", createdAt: "now", updatedAt: "now",
    recurrence: { frequency: "weekly", interval: 1, count: 3 },
  };

  test("expands and identifies recurring instances", () => {
    const occurrences = occurrencesForRange([base], "2026-09-01", "2026-09-30");
    expect(occurrences.map(item => item.startDate)).toEqual(["2026-09-07", "2026-09-14"]);
    expect(occurrences[0]?.id).toBe("event@2026-09-07");
  });

  test("preserves duration for multi-day recurrences", () => {
    const recurring = { ...base, endDate: "2026-09-01" };
    const occurrences = occurrencesForRange([recurring], "2026-09-07", "2026-09-08");
    expect(occurrences[0]?.endDate).toBe("2026-09-08");
  });
});
