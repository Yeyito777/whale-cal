import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calendarIsVisible, createState, eventsOnSelectedDate, selectedOccurrence, toggleCalendarVisibility } from "./state";
import { loadPreferences, savePreferences } from "./preferences";
import { buildFrame } from "./render";
import { commandCompletions } from "./completion";
import { stripAnsi } from "./text";

function fixture() {
  const s = createState(); s.selectedDate = "2026-09-09"; s.cols = 240; s.rows = 40; s.notice = null; s.sidebarOpen = true;
  s.database.calendars = ["Work", "Home"].map(id => ({ id, name: id, color: "#8b5cf6", visible: true, createdAt: "", updatedAt: "" }));
  s.database.events = ["Work", "Home"].map((id, i) => ({ id, title: `${id} appointment`, calendarId: id, startDate: s.selectedDate, endDate: s.selectedDate, startTime: `${10 + i}:00`, endTime: `${11 + i}:00`, createdAt: "", updatedAt: "" }));
  return s;
}

test("filters are local even with shared snapshots; refresh and canonical flags cannot override them", () => {
  const a = fixture(), b = fixture(); b.database = a.database;
  const snapshot = JSON.stringify(a.database);
  expect(toggleCalendarVisibility(a, "Work")).toBe(false);
  expect(calendarIsVisible(a, "Work")).toBe(false);
  expect(calendarIsVisible(b, "Work")).toBe(true);
  expect(JSON.stringify(a.database)).toBe(snapshot);
  a.database = JSON.parse(snapshot); // /reload, reconnect, or daemon restart
  expect(calendarIsVisible(a, "Work")).toBe(false);
  a.database.calendars[1]!.visible = false; // legacy CLI metadata is not a UI filter
  expect(calendarIsVisible(a, "Home")).toBe(true);
  expect(toggleCalendarVisibility(a, "Work")).toBe(true);
  expect(eventsOnSelectedDate(a)).toHaveLength(2);
});

test("local and each SSH alias have independent filters, even with identical calendar IDs", () => {
  const s = fixture(); toggleCalendarVisibility(s, "Work");
  s.remoteAlias = "whale";
  expect(calendarIsVisible(s, "Work")).toBe(true);
  toggleCalendarVisibility(s, "Home");
  s.remoteAlias = "other";
  expect(eventsOnSelectedDate(s)).toHaveLength(2);
  s.remoteAlias = "whale";
  expect(eventsOnSelectedDate(s).map(o => o.event.id)).toEqual(["Work"]);
  s.remoteAlias = null;
  expect(eventsOnSelectedDate(s).map(o => o.event.id)).toEqual(["Home"]);
});

test("filtering preserves the selected event where possible and resets stale timeline scrolling", () => {
  const s = fixture(); s.selectedEventIndex = 1; s.dayTimelineScroll = 50; s.detailScroll = 20;
  toggleCalendarVisibility(s, "Work");
  expect(selectedOccurrence(s)?.event.id).toBe("Home");
  expect(s.selectedEventIndex).toBe(0);
  expect(s.dayTimelineScroll).toBeNull(); expect(s.detailScroll).toBe(0);
  toggleCalendarVisibility(s, "Work");
  expect(selectedOccurrence(s)?.event.id).toBe("Home");
  toggleCalendarVisibility(s, "Home");
  expect(selectedOccurrence(s)?.event.id).toBe("Work");
  toggleCalendarVisibility(s, "Work");
  expect(selectedOccurrence(s)).toBeNull(); expect(s.selectedEventIndex).toBe(0);
});

test("every calendar view and completion provider uses the same local filter", () => {
  const s = fixture(); toggleCalendarVisibility(s, "Work");
  for (const view of ["month", "week", "agenda"] as const) {
    s.view = view;
    const text = buildFrame(s).rows.map(stripAnsi).join("\n");
    expect(text).not.toContain("Work appointment");
    expect(text).toContain("Home appointment");
    expect(text).toContain("1 visible");
    expect(text).toContain("○ Work");
  }
  s.dayOpen = true;
  expect(buildFrame(s).rows.map(stripAnsi).join("\n")).not.toContain("Work appointment");
  const prefix = "/calendar toggle ";
  expect(commandCompletions(prefix, prefix.length, s).find(item => item.label === "Work")?.description).toBe("Hidden calendar");
  expect(commandCompletions("/search ", 8, s).map(item => item.label)).toEqual(["Home appointment"]);
});

test("filters persist locally by source without replacing unrelated settings, and invalid entries are ignored", () => {
  const dir = mkdtempSync(join(tmpdir(), "cal-filter-prefs-")), file = join(dir, "config.json");
  try {
    writeFileSync(file, JSON.stringify({ weekStartsOn: 0, integration: { keep: true } }));
    const s = fixture(); toggleCalendarVisibility(s, "Work"); s.remoteAlias = "whale"; toggleCalendarVisibility(s, "Home");
    savePreferences(s, file);
    const loaded = createState(); loadPreferences(loaded, file);
    expect(loaded.hiddenCalendarIdsBySource).toEqual({ local: ["Work"], "ssh:whale": ["Home"] });
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ weekStartsOn: 0, integration: { keep: true } });
    writeFileSync(file, JSON.stringify({ tui: { hiddenCalendarIdsBySource: { local: ["Work", "Work", 5, null], "ssh:whale": "bad", other: ["Home"] } } }));
    loadPreferences(loaded, file);
    expect(loaded.hiddenCalendarIdsBySource).toEqual({ local: ["Work"] });
    writeFileSync(file, "not json");
    expect(() => loadPreferences(createState(), file)).not.toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
