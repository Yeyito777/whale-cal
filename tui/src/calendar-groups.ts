import type { Calendar, CalendarGroup } from "@whale-cal/shared/types";
import type { AppState } from "./state";

export type SidebarRow = { kind: "group"; group: CalendarGroup; count: number; collapsed: boolean }
  | { kind: "calendar"; calendar: Calendar; index: number; nested: boolean };

export function calendarSidebarRows(state: AppState): SidebarRow[] {
  const rows: SidebarRow[] = [], groups = state.database.groups ?? [];
  for (const group of groups) {
    const members = state.database.calendars.map((calendar, index) => ({ calendar, index })).filter(item => item.calendar.groupId === group.id);
    const collapsed = state.collapsedGroupIds.includes(group.id);
    rows.push({ kind: "group", group, count: members.length, collapsed });
    if (!collapsed) for (const member of members) rows.push({ kind: "calendar", ...member, nested: true });
  }
  for (const [index, calendar] of state.database.calendars.entries()) {
    if (!calendar.groupId || !groups.some(group => group.id === calendar.groupId)) rows.push({ kind: "calendar", calendar, index, nested: false });
  }
  return rows;
}

export function selectedSidebarIndex(state: AppState, rows = calendarSidebarRows(state)): number {
  const found = rows.findIndex(row => state.selectedGroupId ? row.kind === "group" && row.group.id === state.selectedGroupId : row.kind === "calendar" && row.index === state.selectedCalendarIndex);
  if (found >= 0) return found;
  const parent = state.database.calendars[state.selectedCalendarIndex]?.groupId;
  return Math.max(0, rows.findIndex(row => row.kind === "group" && row.group.id === parent));
}

export function selectSidebarRow(state: AppState, row: SidebarRow): void {
  state.selectedGroupId = row.kind === "group" ? row.group.id : null;
  if (row.kind === "calendar") state.selectedCalendarIndex = row.index;
}

export function moveSidebarSelection(state: AppState, amount: number): void {
  const rows = calendarSidebarRows(state);
  const next = Math.max(0, Math.min(rows.length - 1, selectedSidebarIndex(state, rows) + amount));
  if (rows[next]) selectSidebarRow(state, rows[next]!);
}

export function toggleGroupExpanded(state: AppState, id: string, expanded?: boolean): void {
  const collapsed = state.collapsedGroupIds.includes(id);
  const expand = expanded ?? collapsed;
  state.collapsedGroupIds = state.collapsedGroupIds.filter(value => value !== id);
  if (!expand) state.collapsedGroupIds.push(id);
  state.selectedGroupId = id;
}

/** Enter/Space handles a group locally; a calendar returns to the caller for its
 * daemon-backed visibility toggle. Folding never changes calendar visibility. */
export function sidebarGroupKey(state: AppState, key: string): boolean {
  const rows = calendarSidebarRows(state), selected = rows[selectedSidebarIndex(state, rows)];
  if (!selected) return false;
  if (selected.kind === "group" && ["enter", " ", "h", "l", "left", "right"].includes(key)) {
    toggleGroupExpanded(state, selected.group.id, key === "h" || key === "left" ? false : key === "l" || key === "right" ? true : undefined);
    return true;
  }
  if (selected.kind === "calendar" && selected.nested && (key === "h" || key === "left")) {
    state.selectedGroupId = selected.calendar.groupId!;
    return true;
  }
  return false;
}
