import { expect, test } from "bun:test";
import { calendarSidebarRows, moveSidebarSelection, selectedSidebarIndex, sidebarGroupKey, toggleGroupExpanded } from "./calendar-groups";
import { createState, visibleEvents } from "./state";
import { runCommand } from "./commands";
import { commandCompletions } from "./completion";
import { buildFrame } from "./render";
import { stripAnsi, width } from "./text";

function fixture() {
  const s = createState(); s.cols = 120; s.rows = 28; s.sidebarOpen = true; s.focus = "sidebar";
  s.database.groups = [{ id: "y", name: "Yeyito", createdAt: "", updatedAt: "" }, { id: "t", name: "Together", createdAt: "", updatedAt: "" }];
  s.database.calendars = [
    { id: "p", name: "Personal", groupId: "y", color: "#1d9bf0", visible: true, createdAt: "", updatedAt: "" },
    { id: "c", name: "UofT Classes", groupId: "y", color: "#8b5cf6", visible: false, createdAt: "", updatedAt: "" },
    { id: "s", name: "Selin", color: "#14b8a6", visible: true, createdAt: "", updatedAt: "" },
  ];
  s.database.events = [{ id: "e", calendarId: "p", title: "Keep visible", startDate: "2026-09-14", endDate: "2026-09-14", createdAt: "", updatedAt: "" }];
  return s;
}

test("sidebar navigates group headers, children, empty groups, and ungrouped calendars", () => {
  const s = fixture();
  expect(calendarSidebarRows(s).map(row => row.kind)).toEqual(["group", "calendar", "calendar", "group", "calendar"]);
  expect(selectedSidebarIndex(s)).toBe(1);
  moveSidebarSelection(s, -1); expect(s.selectedGroupId).toBe("y");
  expect(sidebarGroupKey(s, "enter")).toBe(true);
  expect(calendarSidebarRows(s).map(row => row.kind)).toEqual(["group", "group", "calendar"]);
  moveSidebarSelection(s, 1); expect(s.selectedGroupId).toBe("t");
  moveSidebarSelection(s, 1); expect(s.selectedGroupId).toBeNull(); expect(s.selectedCalendarIndex).toBe(2);
  toggleGroupExpanded(s, "y", true);
  moveSidebarSelection(s, 1); expect(s.selectedCalendarIndex).toBe(0);
  expect(sidebarGroupKey(s, "h")).toBe(true); expect(s.selectedGroupId).toBe("y");
  expect(sidebarGroupKey(s, "left")).toBe(true); expect(s.collapsedGroupIds).toEqual(["y"]);
  expect(sidebarGroupKey(s, "right")).toBe(true); expect(s.collapsedGroupIds).toEqual([]);
});

test("folding affects only sidebar organization, never calendar or event visibility", () => {
  const s = fixture(), before = structuredClone(s.database);
  toggleGroupExpanded(s, "y", false);
  expect(s.database).toEqual(before);
  expect(visibleEvents(s)).toHaveLength(1);
  const frame = buildFrame(s), text = frame.rows.map(stripAnsi).join("\n");
  expect(text).toContain("▸ Yeyito"); expect(text).not.toContain("UofT Classes");
  expect(s.layout.calendarRows.some(hit => hit.groupId === "y")).toBe(true);
  expect(s.layout.calendarRows.some(hit => hit.calendarId === "p")).toBe(false);
  toggleGroupExpanded(s, "y", true);
  expect(buildFrame(s).rows.map(stripAnsi).join("\n")).toContain("UofT Classes");
  expect(s.layout.calendarRows.some(hit => hit.calendarId === "p")).toBe(true);
  expect(frame.rows.every(row => width(row) === s.cols)).toBe(true);
});

test("group slash commands resolve IDs or multi-word names without ambiguous changes", () => {
  const s = fixture();
  expect(runCommand("/group new Yeyito School", s)).toEqual({ type: "group_new", name: "Yeyito School" });
  expect(runCommand("/group move UofT Classes -> Together", s)).toEqual({ type: "calendar_group", id: "c", groupId: "t" });
  expect(runCommand("/group move p -> y", s)).toEqual({ type: "calendar_group", id: "p", groupId: "y" });
  expect(runCommand("/group ungroup UofT Classes", s)).toEqual({ type: "calendar_group", id: "c", groupId: null });
  expect(runCommand("/group rename Yeyito -> Yeyito School", s)).toEqual({ type: "group_rename", id: "y", name: "Yeyito School" });
  expect(runCommand("/group delete Yeyito", s)).toEqual({ type: "group_delete", id: "y" });
  expect(runCommand("/group move Personal -> Missing", s).type).toBe("error");
  const source = "/group move Uo";
  expect(commandCompletions(source, source.length, s)[0]?.value).toBe("/group move UofT Classes -> ");
  const target = "/group move UofT Classes -> Ye";
  expect(commandCompletions(target, target.length, s)[0]?.value).toBe("/group move UofT Classes -> Yeyito");
});

test("legacy and orphaned memberships remain reachable rather than disappearing", () => {
  const s = fixture(); delete s.database.groups;
  expect(calendarSidebarRows(s).map(row => row.kind)).toEqual(["calendar", "calendar", "calendar"]);
});
