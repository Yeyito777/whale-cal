import { addMonths, deadlineDueAt, eventIsCompleted, occurrencesForRange, todayKey } from "@whale-cal/shared/dates";
import type { CalendarEvent, EventOccurrence } from "@whale-cal/shared/types";

export type DeadlineFilter = "pending" | "completed" | "all";
export const deadlineKey = (item: EventOccurrence) => `${item.event.id}@${item.startDate}`;

/** Keep all one-off deadlines and past recurring occurrences; bound only future
 * expansion of recurring series. An overdue deadline never ages out. */
export function deadlineOccurrences(events: readonly CalendarEvent[], through = addMonths(todayKey(), 12)): EventOccurrence[] {
  return events.filter(event => event.kind === "deadline").flatMap(event =>
    occurrencesForRange([event], event.startDate, event.recurrence ? through : event.endDate))
    .sort((a, b) => deadlineDueAt(a.event, a.startDate) - deadlineDueAt(b.event, b.startDate)
      || a.event.title.localeCompare(b.event.title) || deadlineKey(a).localeCompare(deadlineKey(b)));
}

export function filterDeadlines(items: readonly EventOccurrence[], filter: DeadlineFilter): EventOccurrence[] {
  return items.filter(item => filter === "all" || eventIsCompleted(item.event, item.startDate) === (filter === "completed"));
}
