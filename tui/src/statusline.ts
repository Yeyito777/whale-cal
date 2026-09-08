import { addDays, addMonths, addYears, deadlineDueAt, eventIsCompleted } from "@whale-cal/shared/dates";
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
  if (event.kind === "deadline") return deadlineDueAt(event, date);
  // Calendar wall time, intentionally using the user's local timezone (including DST).
  return new Date(`${date}T${event.startTime ?? "00:00"}:00`).getTime();
}

export interface NextEvent { event: CalendarEvent; date: string; timestamp: number }
function nextItem(events: readonly CalendarEvent[], now: number): NextEvent | null {
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
    const completedDates = new Set(event.completedDates ?? []);
    while (low < count && (event.recurrence ? completedDates.has(occurrenceDate(event, low)) : eventIsCompleted(event))) low++;
    if (low >= count) continue;
    const date = occurrenceDate(event, low);
    if (event.recurrence?.until && date > event.recurrence.until) continue;
    const timestamp = startsAt(event, date);
    if (!Number.isFinite(timestamp) || timestamp < now) continue;
    if (!next || timestamp < next.timestamp || timestamp === next.timestamp && event.title.localeCompare(next.event.title) < 0) next = { event, date, timestamp };
  }
  return next;
}

export function nextEvent(events: readonly CalendarEvent[], now: number): NextEvent | null {
  return nextItem(events.filter(event => event.kind !== "deadline"), now);
}

export function nextDeadline(events: readonly CalendarEvent[], now: number): NextEvent | null {
  return nextItem(events.filter(event => event.kind === "deadline"), now);
}

export function countdown(milliseconds: number): string {
  const minutes = Math.max(0, Math.ceil(milliseconds / 60000));
  return `${Math.floor(minutes / 1440)}d${Math.floor(minutes / 60) % 24}h${minutes % 60}m`;
}

export const STATUSLINE_HEIGHT = 2;

export function renderStatusline(state: AppState, now = Date.now()): [string, string] {
  const events = visibleEvents(state);
  const next = nextEvent(events, now), due = nextDeadline(events, now);
  const title = (item: NextEvent | null) => !state.connected ? "offline" : !item ? "none"
    : item.event.title + (!item.event.startTime && item.event.kind !== "deadline" ? " · All day" : "");
  const remaining = (item: NextEvent | null) => state.connected && item ? countdown(item.timestamp - now) : "—";
  const left = [["Next Event: ", title(next)], ["Happens in: ", remaining(next)]] as const;
  const right = [["Next Deadline: ", title(due)], ["Due in: ", remaining(due)]] as const;
  const margin = state.cols > 0 ? " " : "";
  const separator = state.cols >= 4 ? ` ${theme.accent}│ ` : "";
  const available = Math.max(0, state.cols - width(margin) - width(separator));
  const wantedLeft = Math.max(...left.map(([label, value]) => width(label + value)));
  const wantedRight = Math.max(...right.map(([label, value]) => width(label + value)));
  // Natural-width blocks, packed left. Share space only when titles must shrink.
  const leftWidth = Math.min(wantedLeft, Math.max(Math.floor(available / 2), available - wantedRight));
  const rightWidth = Math.min(wantedRight, available - leftWidth);
  const block = (label: string, value: string, size: number) => {
    const content = `${theme.muted}${truncate(label, size)}${theme.accent}${truncate(value, Math.max(0, size - width(label)))}`;
    return pad(content, size);
  };
  const row = (leftLabel: string, leftValue: string, rightLabel: string, rightValue: string) =>
    `${theme.appBg}${pad(margin + block(leftLabel, leftValue, leftWidth) + separator + block(rightLabel, rightValue, rightWidth), state.cols)}${theme.reset}`;
  return [row(...left[0], ...right[0]), row(...left[1], ...right[1])];
}
