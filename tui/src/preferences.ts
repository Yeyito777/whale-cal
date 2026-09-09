import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configDir } from "@whale-cal/shared/paths";
import { isDateKey } from "@whale-cal/shared/dates";
import type { CalendarView } from "@whale-cal/shared/types";
import type { AppState } from "./state";

interface Preferences {
  weekStartsOn?: 0 | 1;
  timeFormat?: "12h" | "24h";
  defaultView?: CalendarView;
  tui?: { selectedDate?: string; view?: CalendarView; sidebarOpen?: boolean; collapsedGroupIds?: string[]; hiddenCalendarIdsBySource?: Record<string, string[]> };
}

const path = () => join(configDir(), "config.json");

export function loadPreferences(state: AppState, file = path()): void {
  if (!existsSync(file)) return;
  try {
    const prefs = JSON.parse(readFileSync(file, "utf8")) as Preferences;
    if (prefs.tui?.selectedDate && isDateKey(prefs.tui.selectedDate)) state.selectedDate = prefs.tui.selectedDate;
    const view = prefs.tui?.view ?? prefs.defaultView;
    if (view && ["month", "week", "agenda"].includes(view)) state.view = view;
    if (typeof prefs.tui?.sidebarOpen === "boolean") state.sidebarOpen = prefs.tui.sidebarOpen;
    if (Array.isArray(prefs.tui?.collapsedGroupIds)) state.collapsedGroupIds = prefs.tui.collapsedGroupIds.filter(id => typeof id === "string");
    const filters = prefs.tui?.hiddenCalendarIdsBySource;
    if (filters && typeof filters === "object" && !Array.isArray(filters)) {
      state.hiddenCalendarIdsBySource = Object.fromEntries(Object.entries(filters)
        .filter(([source, ids]) => (source === "local" || source.startsWith("ssh:")) && Array.isArray(ids))
        .map(([source, ids]) => [source, [...new Set(ids.filter(id => typeof id === "string"))]]));
    }
  } catch { /* malformed preferences never prevent calendar startup */ }
}

export function savePreferences(state: AppState, file = path()): void {
  mkdirSync(dirname(file), { recursive: true });
  let prefs: Preferences = {};
  try { if (existsSync(file)) prefs = JSON.parse(readFileSync(file, "utf8")) as Preferences; } catch { /* replace malformed file */ }
  prefs.tui = { selectedDate: state.selectedDate, view: state.view, sidebarOpen: state.sidebarOpen, collapsedGroupIds: state.collapsedGroupIds, hiddenCalendarIdsBySource: state.hiddenCalendarIdsBySource };
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(prefs, null, 2) + "\n", { mode: 0o600 });
  renameSync(temp, file);
}
