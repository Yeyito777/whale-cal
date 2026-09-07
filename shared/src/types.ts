export type DateKey = string; // YYYY-MM-DD in the calendar's local timezone
export type TimeKey = string; // HH:mm, 24-hour local wall time
export type CalendarItemKind = "event" | "deadline";

export type RecurrenceFrequency = "none" | "daily" | "weekly" | "monthly" | "yearly";

export interface RecurrenceRule {
  frequency: Exclude<RecurrenceFrequency, "none">;
  interval: number;
  /** Last permitted occurrence start date, inclusive. */
  until?: DateKey;
  /** Maximum number of occurrences, including the original. */
  count?: number;
}

export interface Calendar {
  id: string;
  name: string;
  color: string;
  visible: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CalendarEvent {
  /** Missing on legacy records means event. Deadlines use startDate/startTime as due date/time. */
  kind?: CalendarItemKind;
  id: string;
  calendarId: string;
  title: string;
  startDate: DateKey;
  endDate: DateKey;
  /** Missing times mean an all-day event. */
  startTime?: TimeKey;
  endTime?: TimeKey;
  location?: string;
  notes?: string;
  recurrence?: RecurrenceRule;
  /** Completion of a non-recurring event. Missing means unfinished. */
  completed?: boolean;
  /** Completed recurring occurrences, keyed by their start date. */
  completedDates?: DateKey[];
  createdAt: string;
  updatedAt: string;
}

export interface EventOccurrence {
  id: string;
  event: CalendarEvent;
  startDate: DateKey;
  endDate: DateKey;
  occurrenceIndex: number;
}

export interface CalendarDatabase {
  version: 1;
  revision: number;
  calendars: Calendar[];
  events: CalendarEvent[];
}

export interface EventDraft {
  kind?: CalendarItemKind;
  calendarId?: string;
  title: string;
  startDate: DateKey;
  endDate?: DateKey;
  startTime?: TimeKey;
  endTime?: TimeKey;
  location?: string;
  notes?: string;
  recurrence?: RecurrenceRule;
}

/** Mutation shape; nullable optional fields explicitly clear an existing value. */
export type EventPatch = Partial<Omit<EventDraft, "startTime" | "endTime" | "location" | "notes" | "recurrence">> & {
  startTime?: TimeKey | null;
  endTime?: TimeKey | null;
  location?: string | null;
  notes?: string | null;
  recurrence?: RecurrenceRule | null;
};

export type CalendarView = "month" | "week" | "agenda";
