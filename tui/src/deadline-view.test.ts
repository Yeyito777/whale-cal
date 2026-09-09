import { expect, test } from "bun:test";
import { addDays, todayKey } from "@whale-cal/shared/dates";
import type { CalendarEvent } from "@whale-cal/shared/types";
import { deadlineKey, deadlineOccurrences } from "./deadline-list";
import { createEditor, createState, deadlineCompletionTargets, deadlinesInView, markDeadline, moveDeadlineSelection, selectedOccurrence, setDeadlineFilter, settleEditorSave, toggleCalendarVisibility } from "./state";
import { handleViewNavigation } from "./view-navigation";
import { buildFrame } from "./render";
import { commandCompletions } from "./completion";
import { runCommand } from "./commands";
import { stripAnsi, width } from "./text";
import { theme } from "./theme";

const deadline = (id: string, offset = 0, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({ id, title: id, kind: "deadline", calendarId: "work", startDate: addDays(todayKey(), offset), endDate: addDays(todayKey(), offset), createdAt: "", updatedAt: "", ...extra });
function fixture() {
  const s = createState(); s.view = "deadlines"; s.notice = null;
  s.database.calendars = [{ id: "work", name: "Work", color: "#8b5cf6", visible: true, createdAt: "", updatedAt: "" }];
  s.database.events = [deadline("Old", -500), deadline("Today"), deadline("Tomorrow", 1), deadline("Done", -1, { completed: true }), deadline("Event", 0, { kind: "event" })];
  return s;
}

test("deadline list keeps old overdue and far-future one-offs; recurrence expands within an explicit horizon", () => {
  const s = fixture();
  s.database.events.push(deadline("Far future", 900), deadline("Timed", 0, { startTime: "09:00" }), deadline("Repeat", -1, { recurrence: { frequency: "daily", interval: 1, count: 4 }, completedDates: [addDays(todayKey(), -1)] }));
  const items = deadlineOccurrences(s.database.events, addDays(todayKey(), 1));
  expect(items.some(item => item.event.kind === "event")).toBe(false);
  expect(items[0]!.event.id).toBe("Old");
  expect(items.at(-1)!.event.id).toBe("Far future");
  expect(items.filter(item => item.event.id === "Repeat").map(item => item.startDate)).toEqual([addDays(todayKey(), -1), todayKey(), addDays(todayKey(), 1)]);
  expect(items.findIndex(item => item.event.id === "Timed")).toBeLessThan(items.findIndex(item => item.event.id === "Today"));
});

test("pending, completed and all are independent of calendar day; stable selection survives canonical updates", () => {
  const s = fixture();
  expect(deadlinesInView(s).map(item => item.event.id)).toEqual(["Old", "Today", "Tomorrow"]);
  moveDeadlineSelection(s, 1); expect(selectedOccurrence(s)?.event.id).toBe("Today");
  s.database.events[0]!.completed = true;
  expect(selectedOccurrence(s)?.event.id).toBe("Today");
  s.database.events[1]!.completed = true;
  expect(selectedOccurrence(s)?.event.id).toBe("Tomorrow");
  setDeadlineFilter(s, "completed"); expect(deadlinesInView(s)).toHaveLength(3);
  setDeadlineFilter(s, "all"); expect(deadlinesInView(s).map(item => item.event.id)).toEqual(["Tomorrow", "Old", "Done", "Today"]);
});

test("marking is local and bulk actions target only visible marked occurrences, never an entire series", () => {
  const s = fixture();
  s.database.events = [deadline("Repeat", 0, { recurrence: { frequency: "daily", interval: 1, count: 3 } })];
  const snapshot = JSON.stringify(s.database);
  markDeadline(s); moveDeadlineSelection(s, 1); markDeadline(s);
  expect(deadlineCompletionTargets(s).map(item => [item.event.id, item.startDate])).toEqual([["Repeat", todayKey()], ["Repeat", addDays(todayKey(), 1)]]);
  expect(JSON.stringify(s.database)).toBe(snapshot);
  markDeadline(s); expect(deadlineCompletionTargets(s)).toHaveLength(1);
  setDeadlineFilter(s, "all"); expect(s.deadlineMarkedKeys).toEqual([]);
  markDeadline(s); toggleCalendarVisibility(s, "work");
  expect(deadlineCompletionTargets(s)).toEqual([]); expect(s.deadlineMarkedKeys).toEqual([]);
});

test("gj opens deadlines from overview or day, gg selects first deadline, and input never consumes the shortcut", () => {
  const s = fixture(); s.view = "month"; s.dayOpen = true;
  expect(handleViewNavigation(s, { type: "char", char: "g" })).toBe(true);
  expect(handleViewNavigation(s, { type: "char", char: "j" })).toBe(true);
  expect(String(s.view)).toBe("deadlines"); expect(s.dayOpen).toBe(false);
  moveDeadlineSelection(s, 2);
  handleViewNavigation(s, { type: "char", char: "g" }); handleViewNavigation(s, { type: "char", char: "g" });
  expect(s.deadlineIndex).toBe(0);
  handleViewNavigation(s, { type: "char", char: "g" }); handleViewNavigation(s, { type: "escape" });
  expect(s.pendingKeys).toBe("");
  s.mainFocus = "prompt";
  expect(handleViewNavigation(s, { type: "char", char: "g" })).toBe(false);
});

test("deadline layouts fit narrow and wide terminals and keep the selected row clickable after scrolling", () => {
  for (const [cols, rows] of [[54, 18], [80, 24], [120, 36], [160, 48]]) {
    const s = fixture(); s.cols = cols!; s.rows = rows!; s.sidebarOpen = true;
    s.database.events = Array.from({ length: 40 }, (_, i) => deadline(`Task ${i}`, i));
    moveDeadlineSelection(s, 39); markDeadline(s);
    const frame = buildFrame(s), text = frame.rows.map(stripAnsi).join("\n");
    expect(text).toContain("Task 39"); expect(text).toContain("1 marked");
    expect(s.layout.eventRows.some(hit => hit.index === 39)).toBe(true);
    expect(s.layout.actions.some(hit => hit.action === "deadline-toggle:39")).toBe(true);
    expect(frame.rows).toHaveLength(rows!);
    expect(frame.rows.every(row => width(row) === cols)).toBe(true);
    expect(s.layout.actions.every(hit => hit.row >= 1 && hit.row <= rows! && hit.right <= cols!)).toBe(true);
  }
});

test("completed deadlines keep checkmarks and strikethrough; empty filters are explicit", () => {
  const s = fixture(); s.cols = 120; s.rows = 30; setDeadlineFilter(s, "completed");
  const frame = buildFrame(s);
  expect(frame.rows.map(stripAnsi).join("\n")).toContain("✓ Done");
  expect(frame.rows.join("\n")).toContain(theme.strike);
  toggleCalendarVisibility(s, "work");
  expect(buildFrame(s).rows.map(stripAnsi).join("\n")).toContain("No completed deadlines");
});

test("saving an edited deadline returns to its list occurrence rather than opening a day", () => {
  const s = fixture(); const event = s.database.events[2]!;
  s.editor = createEditor(s, event); s.editor.saving = "save"; s.editor.saveDate = event.startDate;
  settleEditorSave(s, "save", event);
  expect(s.editor).toBeNull(); expect(s.dayOpen).toBe(false);
  expect(s.deadlineSelectedKey).toBe(deadlineKey({ event, startDate: event.startDate } as any));
  expect(selectedOccurrence(s)?.event.id).toBe("Tomorrow");
});

test("deadline view is available in slash parsing and autocomplete", () => {
  const s = fixture();
  expect(runCommand("/view deadlines", s)).toEqual({ type: "view", view: "deadlines" });
  expect(commandCompletions("/view d", 7, s).map(item => item.value)).toEqual(["/view deadlines"]);
});
