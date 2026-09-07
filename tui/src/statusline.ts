import { addDays, addMonths, addYears } from "@whale-cal/shared/dates";
import type { CalendarEvent } from "@whale-cal/shared/types";
import { visibleEvents, type AppState } from "./state";
import { theme } from "./theme";
import { pad, truncate, width } from "./text";

function occurrenceDate(event: CalendarEvent, index: number): string {
  const rule = event.recurrence;
  if (!rule) return event.startDate;
  const n = index * rule.interval;
  switch (rule.frequency) {
    case "daily": return addDays(event.startDate, n);
    case "weekly": return addDays(event.startDate, n * 7);
    case "monthly": return addMonths(event.startDate, n);
    case "yearly": return addYears(event.startDate, n);
  }
}
function startsAt(event: CalendarEvent, date: string): number {
  // Calendar wall time, intentionally using the user's local timezone (including DST).
  return new Date(`${date}T${event.startTime ?? "00:00"}:00`).getTime();
}

export interface NextEvent { event: CalendarEvent; date: string; timestamp: number }
export function nextEvent(events: readonly CalendarEvent[], now: number): NextEvent | null {
  let next: NextEvent | null = null;
  for (const event of events) {
    let low = 0, high = event.recurrence ? Math.min(event.recurrence.count ?? 100000, 100000) : 1;
    const count = high;
    // Find the first future occurrence without expanding years of past instances.
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (startsAt(event, occurrenceDate(event, middle)) < now) low = middle + 1;
      else high = middle;
    }
    if (low >= count) continue;
    const date = occurrenceDate(event, low);
    if (event.recurrence?.until && date > event.recurrence.until) continue;
    const timestamp = startsAt(event, date);
    if (!Number.isFinite(timestamp) || timestamp < now) continue;
    if (!next || timestamp < next.timestamp || timestamp === next.timestamp && event.title.localeCompare(next.event.title) < 0) next = { event, date, timestamp };
  }
  return next;
}

export function countdown(milliseconds: number): string {
  if (milliseconds <= 0) return "now";
  const minutes = Math.ceil(milliseconds / 60000);
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

export const STATUSLINE_HEIGHT = 2;

export function renderStatusline(state: AppState, now = Date.now()): [string, string] {
  const next = nextEvent(visibleEvents(state), now);
  const title = !state.connected ? "offline" : !next ? "none scheduled"
    : next.event.title + (next.event.startTime ? "" : " · All day");
  const remaining = state.connected && next ? countdown(next.timestamp - now) : "—";
  const row = (label: string, value: string) => {
    const content = `${theme.muted}${label}${theme.accent}${truncate(value, Math.max(0, state.cols - width(label)))}`;
    return `${theme.appBg}${pad(content, state.cols)}${theme.reset}`;
  };
  return [row("  Next Event: ", title), row("  Happens in: ", remaining)];
}
