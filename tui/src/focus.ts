import type { KeyEvent } from "./input";
import type { AppState, PromptState } from "./state";

/** The sidebar and main panel are peers; the prompt is an inner main focus. */
export function isPromptFocused(state: AppState): state is AppState & { prompt: PromptState } {
  return state.focus === "calendar" && state.mainFocus === "prompt" && !!state.prompt;
}

function leaveInput(state: AppState): void {
  state.pendingKeys = "";
  if (state.prompt) {
    state.prompt.mode = "normal";
    state.prompt.completion = null;
    state.prompt.selectionAnchor = undefined;
    state.prompt.focusEpoch = (state.prompt.focusEpoch ?? 0) + 1;
  }
}

export function focusPrompt(state: AppState, text?: string): void {
  state.focus = "calendar";
  state.mainFocus = "prompt";
  state.pendingKeys = "";
  if (text !== undefined || !state.prompt) {
    const value = text ?? "";
    state.prompt = { text: value, cursor: value.length, mode: "insert" };
  } else {
    if (state.prompt.mode !== "insert") state.prompt.focusEpoch = (state.prompt.focusEpoch ?? 0) + 1;
    state.prompt.mode = "insert";
    state.prompt.completionText = undefined;
  }
}

export function focusCalendar(state: AppState): void {
  leaveInput(state);
  state.focus = "calendar";
  state.mainFocus = "calendar";
}

export function focusSidebar(state: AppState): void {
  // The sidebar is hidden at compact widths: never focus an invisible panel.
  if (state.cols < 76 || !state.sidebarOpen) return;
  leaveInput(state);
  state.focus = "sidebar";
}

export function cyclePanelFocus(state: AppState): void {
  if (!state.sidebarOpen || state.cols < 76) return;
  if (state.focus === "sidebar") state.focus = "calendar";
  else focusSidebar(state);
}

/** Run after modal routing, before prompt/calendar/sidebar-specific bindings. */
export function handleFocusKey(state: AppState, key: KeyEvent): "handled" | "new" | null {
  if (state.editor || state.helpOpen || state.confirmDelete) return null;
  if (key.type === "ctrl-j" || key.type === "ctrl-k") {
    cyclePanelFocus(state);
    return "handled";
  }
  if (key.type === "ctrl-s") {
    state.sidebarOpen = !state.sidebarOpen;
    if (state.sidebarOpen) focusSidebar(state);
    else if (state.focus === "sidebar") state.focus = "calendar";
    return "handled";
  }
  if (key.type === "ctrl-n") {
    if (state.focus === "calendar" && state.mainFocus === "calendar") focusPrompt(state);
    else focusCalendar(state);
    return "handled";
  }
  if (key.type === "ctrl-p" || key.type === "ctrl-shift-o") return "new";
  // Pasting from a browsing surface resumes the existing draft, not a new one.
  if (key.type === "paste") focusPrompt(state);
  return null;
}
