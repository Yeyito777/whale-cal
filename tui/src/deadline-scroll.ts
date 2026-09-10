import type { KeyEvent } from "./input";
import type { AppState } from "./state";

export interface DeadlineListEntry { index: number; key: string; top: number; bottom: number; revealTop: number }
export interface DeadlineListViewport { height: number; total: number; entries: DeadlineListEntry[] }
const clamp = (value: number, max: number) => Math.max(0, Math.min(value, Math.max(0, max)));

/** Edge-triggered reveal, like Exocortex's sidebar, with two-row items kept
 * together. Moving within the viewport must not move the viewport itself. */
export function revealDeadline(scroll: number, view: DeadlineListViewport, selectedIndex: number): number {
  scroll = clamp(scroll, view.total - view.height);
  const entry = view.entries.find(entry => entry.index === selectedIndex);
  if (!entry || view.height <= 0) return scroll;
  if (entry.top < scroll) scroll = entry.revealTop;
  else if (entry.bottom >= scroll + view.height) scroll = entry.bottom - view.height + 1;
  return clamp(scroll, view.total - view.height);
}

/** Exocortex sidebar semantics: E/Y keep the selected buffer item until it
 * leaves the viewport; D/U move both by half a viewport; F/B overlap two rows
 * and select the leading/trailing entry on the new page. Headers aren't items. */
export function handleDeadlineScroll(state: AppState, key: KeyEvent): boolean {
  if (!["ctrl-e", "ctrl-y", "ctrl-d", "ctrl-u", "ctrl-f", "ctrl-b"].includes(key.type)) return false;
  const view = state.layout.deadlineList;
  if (!view || view.height <= 0 || !view.entries.length) return true;
  const current = view.entries.find(entry => entry.index === state.deadlineIndex) ?? view.entries[0]!;
  const direction = ["ctrl-e", "ctrl-d", "ctrl-f"].includes(key.type) ? 1 : -1;
  const line = key.type === "ctrl-e" || key.type === "ctrl-y";
  const page = key.type === "ctrl-f" || key.type === "ctrl-b";
  const amount = line ? 1 : page ? Math.max(1, view.height - 2) : Math.max(1, Math.floor(view.height / 2));
  const start = revealDeadline(state.deadlineScroll, view, state.deadlineIndex);
  if (view.total <= view.height && page) return true;
  const next = clamp(start + direction * amount, view.total - view.height);
  const end = next + view.height - 1;
  const visible = view.entries.filter(entry => entry.top >= next && entry.bottom <= end);
  const candidates = visible.length ? visible : view.entries.filter(entry => entry.top <= end && entry.bottom >= next);
  if (!candidates.length) return true;
  const targetRow = page ? direction > 0 ? next : end : line ? current.top : current.top + direction * amount;
  const target = candidates.reduce((best, entry) => {
    const a = Math.abs(entry.top - targetRow), b = Math.abs(best.top - targetRow);
    return a < b || a === b && (direction > 0 ? entry.top > best.top : entry.top < best.top) ? entry : best;
  });
  if (state.deadlineSelectedKey !== target.key) state.detailScroll = 0;
  state.deadlineIndex = target.index; state.deadlineSelectedKey = target.key;
  state.deadlineScroll = revealDeadline(next, view, target.index);
  return true;
}
