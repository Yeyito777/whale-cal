import type { DateKey, EventOccurrence } from "@whale-cal/shared/types";

export type ScheduleRow =
  | { kind: "event"; eventIndex: number; time: string }
  | { kind: "free"; start: number; end: number; time: string };

const minute = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const range = (start: number, end: number) => `${clock(start)}–${clock(end)}`;

export function durationLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return `${hours ? `${hours}h` : ""}${rest || !hours ? `${rest}m` : ""}`;
}

/** Full local wall-clock day, using only the visible occurrences supplied by the caller.
 * Only explicit start/end times reserve time. All-day entries and entries with
 * no end time remain markers; never invent a duration. The UI calls out missing
 * end times so these gaps aren't mistaken for fully confirmed availability.
 */
export function daySchedule(occurrences: readonly EventOccurrence[], date: DateKey): { rows: ScheduleRow[]; freeMinutes: number } {
  const events = occurrences.map((occurrence, eventIndex) => {
    const { event } = occurrence;
    const allDay = !event.startTime;
    const start = allDay || occurrence.startDate < date ? 0 : minute(event.startTime!);
    const deadline = event.kind === "deadline";
    const end = deadline || allDay || !event.endTime ? start : occurrence.endDate > date ? 1440 : minute(event.endTime);
    const time = deadline ? allDay ? "Due this day" : `Due ${clock(start)}` : allDay ? "all-day" : !event.endTime ? `${clock(start)}–?` : range(start, end);
    return { eventIndex, start, end, time, priority: deadline && allDay ? -1 : 0 };
  }).sort((a, b) => a.priority - b.priority || a.start - b.start || a.eventIndex - b.eventIndex);
  const rows: ScheduleRow[] = [];
  let busyUntil = 0, freeMinutes = 0;
  const free = (start: number, end: number) => {
    if (end <= start) return;
    rows.push({ kind: "free", start, end, time: range(start, end) });
    freeMinutes += end - start;
  };
  for (const event of events) {
    free(busyUntil, event.start);
    rows.push({ kind: "event", eventIndex: event.eventIndex, time: event.time });
    busyUntil = Math.max(busyUntil, event.end);
  }
  free(busyUntil, 1440);
  return { rows, freeMinutes };
}

/** Scroll by schedule rows but keep keyboard selection attached to real events. */
export function scheduleWindow(rows: readonly ScheduleRow[], eventIndex: number, capacity: number): number {
  const selected = Math.max(0, rows.findIndex(row => row.kind === "event" && row.eventIndex === eventIndex));
  return Math.max(0, Math.min(selected - Math.floor(capacity / 2), rows.length - capacity));
}

export function moveScheduleSelection(rows: readonly ScheduleRow[], selected: number, amount: number): number {
  const indices = rows.flatMap(row => row.kind === "event" ? [row.eventIndex] : []);
  if (!indices.length) return selected;
  const position = Math.max(0, indices.indexOf(selected));
  return indices[((position + amount) % indices.length + indices.length) % indices.length]!;
}
