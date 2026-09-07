import type { CalendarEvent, DateKey, EventOccurrence, RecurrenceRule, TimeKey } from "./types";

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isDateKey(value: unknown): value is DateKey {
  if (typeof value !== "string") return false;
  const match = DATE_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day, 12);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

export function isTimeKey(value: unknown): value is TimeKey {
  return typeof value === "string" && TIME_RE.test(value);
}

export function dateKey(date: Date): DateKey {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function dateFromKey(key: DateKey): Date {
  const match = DATE_RE.exec(key);
  if (!match) throw new Error(`Invalid date: ${key}`);
  const result = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
  if (dateKey(result) !== key) throw new Error(`Invalid date: ${key}`);
  return result;
}

export function todayKey(now = new Date()): DateKey { return dateKey(now); }

export function addDays(key: DateKey, amount: number): DateKey {
  const value = dateFromKey(key);
  value.setDate(value.getDate() + amount);
  return dateKey(value);
}

export function daysBetween(from: DateKey, to: DateKey): number {
  const a = dateFromKey(from);
  const b = dateFromKey(to);
  return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate())
    - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86_400_000);
}

export function addMonths(key: DateKey, amount: number): DateKey {
  const source = dateFromKey(key);
  const targetMonth = source.getMonth() + amount;
  const target = new Date(source.getFullYear(), targetMonth, 1, 12);
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0, 12).getDate();
  target.setDate(Math.min(source.getDate(), last));
  return dateKey(target);
}

export function addYears(key: DateKey, amount: number): DateKey {
  const source = dateFromKey(key);
  const target = new Date(source.getFullYear() + amount, source.getMonth(), 1, 12);
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0, 12).getDate();
  target.setDate(Math.min(source.getDate(), last));
  return dateKey(target);
}

export function startOfWeek(key: DateKey, weekStartsOn: 0 | 1 = 1): DateKey {
  const value = dateFromKey(key);
  const offset = (value.getDay() - weekStartsOn + 7) % 7;
  return addDays(key, -offset);
}

export function endOfWeek(key: DateKey, weekStartsOn: 0 | 1 = 1): DateKey {
  return addDays(startOfWeek(key, weekStartsOn), 6);
}

export function startOfMonth(key: DateKey): DateKey {
  const date = dateFromKey(key);
  return dateKey(new Date(date.getFullYear(), date.getMonth(), 1, 12));
}

export function endOfMonth(key: DateKey): DateKey {
  const date = dateFromKey(key);
  return dateKey(new Date(date.getFullYear(), date.getMonth() + 1, 0, 12));
}

export function monthMatrix(key: DateKey, weekStartsOn: 0 | 1 = 1): DateKey[][] {
  const first = startOfWeek(startOfMonth(key), weekStartsOn);
  return Array.from({ length: 6 }, (_, week) => (
    Array.from({ length: 7 }, (_unused, day) => addDays(first, week * 7 + day))
  ));
}

export function formatMonthYear(key: DateKey): string {
  return new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(dateFromKey(key));
}

export function formatLongDate(key: DateKey): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
  }).format(dateFromKey(key));
}

export function formatShortDate(key: DateKey): string {
  return new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(dateFromKey(key));
}

export function weekdayLabels(weekStartsOn: 0 | 1 = 1, width: "short" | "long" = "short"): string[] {
  const sunday = new Date(2024, 0, 7, 12);
  return Array.from({ length: 7 }, (_, i) => {
    const date = new Date(sunday);
    date.setDate(sunday.getDate() + ((i + weekStartsOn) % 7));
    return new Intl.DateTimeFormat(undefined, { weekday: width }).format(date);
  });
}

export function compareDateKeys(a: DateKey, b: DateKey): number { return a.localeCompare(b); }

export function eventIsAllDay(event: Pick<CalendarEvent, "startTime">): boolean {
  return !event.startTime;
}

export function eventIsCompleted(event: CalendarEvent, occurrenceDate = event.startDate): boolean {
  return event.recurrence ? (event.completedDates ?? []).includes(occurrenceDate) : event.completed === true;
}

/** A date-only deadline is due by the end of that local day, not at its start. */
export function deadlineDueAt(event: Pick<CalendarEvent, "startTime">, date: DateKey): number {
  if (event.startTime) return new Date(`${date}T${event.startTime}:00`).getTime();
  const end = dateFromKey(date);
  end.setDate(end.getDate() + 1);
  end.setHours(0, 0, 0, 0);
  return end.getTime();
}

export function deadlineIsOverdue(event: CalendarEvent, date = event.startDate, now = Date.now()): boolean {
  return event.kind === "deadline" && !eventIsCompleted(event, date) && now >= deadlineDueAt(event, date);
}

export function formatItemTime(event: Pick<CalendarEvent, "kind" | "startTime" | "endTime">): string {
  return event.kind === "deadline" ? event.startTime ? `Due ${event.startTime}` : "Due this day" : formatEventTime(event);
}

export function formatEventTime(event: Pick<CalendarEvent, "startTime" | "endTime">): string {
  if (!event.startTime) return "all-day";
  return event.endTime ? `${event.startTime}–${event.endTime}` : event.startTime;
}

function nextOccurrenceDate(base: DateKey, rule: RecurrenceRule, index: number): DateKey {
  const amount = rule.interval * index;
  switch (rule.frequency) {
    case "daily": return addDays(base, amount);
    case "weekly": return addDays(base, amount * 7);
    case "monthly": return addMonths(base, amount);
    case "yearly": return addYears(base, amount);
  }
}

function occurrenceOverlaps(start: DateKey, end: DateKey, rangeStart: DateKey, rangeEnd: DateKey): boolean {
  return start <= rangeEnd && end >= rangeStart;
}

/** Expand recurring series only far enough to cover an inclusive date range. */
export function occurrencesForRange(
  events: readonly CalendarEvent[],
  rangeStart: DateKey,
  rangeEnd: DateKey,
): EventOccurrence[] {
  const output: EventOccurrence[] = [];
  for (const event of events) {
    const duration = Math.max(0, daysBetween(event.startDate, event.endDate));
    const rule = event.recurrence;
    if (!rule) {
      if (occurrenceOverlaps(event.startDate, event.endDate, rangeStart, rangeEnd)) {
        output.push({ id: event.id, event, startDate: event.startDate, endDate: event.endDate, occurrenceIndex: 0 });
      }
      continue;
    }

    const maxCount = Math.min(rule.count ?? 100_000, 100_000);
    for (let index = 0; index < maxCount; index++) {
      const start = nextOccurrenceDate(event.startDate, rule, index);
      if (rule.until && start > rule.until) break;
      if (start > rangeEnd) break;
      const end = addDays(start, duration);
      if (occurrenceOverlaps(start, end, rangeStart, rangeEnd)) {
        output.push({
          id: index === 0 ? event.id : `${event.id}@${start}`,
          event,
          startDate: start,
          endDate: end,
          occurrenceIndex: index,
        });
      }
    }
  }
  return output.sort(compareOccurrences);
}

export function compareOccurrences(a: EventOccurrence, b: EventOccurrence): number {
  return a.startDate.localeCompare(b.startDate)
    || Number(!!a.event.startTime) - Number(!!b.event.startTime)
    || (a.event.startTime ?? "").localeCompare(b.event.startTime ?? "")
    || a.event.title.localeCompare(b.event.title);
}

export function occurrencesOnDate(events: readonly CalendarEvent[], key: DateKey): EventOccurrence[] {
  return occurrencesForRange(events, key, key);
}
