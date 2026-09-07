import { expect, test } from "bun:test";
import { CALENDAR_COLORS, nextCalendarColor } from "./calendar-colors";

test("expands the palette to 24 unique accents and keeps Personal blue", () => {
  expect(CALENDAR_COLORS).toHaveLength(24);
  expect(new Set(CALENDAR_COLORS).size).toBe(24);
  expect(nextCalendarColor([])).toBe("#1d9bf0");
});

test("automatic colors never repeat, even beyond the curated palette", () => {
  const used: string[] = [];
  for (let i = 0; i < 80; i++) {
    const color = nextCalendarColor(used);
    expect(color).toMatch(/^#[0-9a-f]{6}$/);
    expect(used).not.toContain(color);
    used.push(color);
  }
});

test("matches existing custom colors case-insensitively and favors a different hue", () => {
  const color = nextCalendarColor(["#1D9BF0", "#48CAE4", "#2ec4b6"]);
  expect(["#1d9bf0", "#48cae4", "#2ec4b6"]).not.toContain(color);
  // A blue-heavy sidebar should get a warm accent, not another near-blue.
  const red = parseInt(color.slice(1, 3), 16), blue = parseInt(color.slice(5, 7), 16);
  expect(red).toBeGreaterThan(blue);
});

test("removing a calendar frees its palette entry instead of restarting a color cycle", () => {
  const removed = CALENDAR_COLORS[8];
  expect(nextCalendarColor(CALENDAR_COLORS.filter(color => color !== removed))).toBe(removed);
});
