import { todayKey } from "@whale-cal/shared/dates";
import type { KeyEvent } from "./input";
import { moveDeadlineSelection, selectDate, type AppState } from "./state";

/** Vim g-prefix navigation only on the main browsing surface, never in input. */
export function handleViewNavigation(state: AppState, key: KeyEvent): boolean {
  if (state.focus !== "calendar" || state.mainFocus === "prompt" || state.editor || state.helpOpen || state.confirmDelete) return false;
  if (state.pendingKeys === "g") {
    state.pendingKeys = "";
    if (key.type === "char" && key.char === "j") {
      state.view = "deadlines"; state.dayOpen = false; return true;
    }
    if (key.type === "char" && key.char === "g") {
      if (state.view === "deadlines" && !state.dayOpen) moveDeadlineSelection(state, -Number.MAX_SAFE_INTEGER);
      else selectDate(state, todayKey());
      return true;
    }
  }
  if (key.type === "char" && key.char === "g") { state.pendingKeys = "g"; return true; }
  return false;
}
