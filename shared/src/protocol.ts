import type { Calendar, CalendarGroup, CalendarPatch, CalendarDatabase, CalendarEvent, EventDraft, EventOccurrence, EventPatch } from "./types";

export type Command =
  | { type: "probe"; reqId: string }
  | { type: "get_schema"; reqId: string }
  | { type: "restart_daemon"; reqId: string }
  | { type: "bootstrap" }
  | { type: "list_calendars"; reqId: string }
  | { type: "list_groups"; reqId: string }
  | { type: "create_group"; reqId: string; name: string }
  | { type: "update_group"; reqId: string; id: string; name: string }
  | { type: "delete_group"; reqId: string; id: string }
  | {
      type: "list_events";
      reqId: string;
      from: string;
      to: string;
      calendarId?: string;
      query?: string;
      includeHidden?: boolean;
    }
  | { type: "get_event"; reqId: string; id: string }
  | { type: "create_event"; reqId: string; event: EventDraft }
  | { type: "update_event"; reqId: string; id: string; patch: EventPatch }
  | { type: "complete_event"; reqId: string; id: string; completed: boolean; occurrenceDate?: string }
  | { type: "delete_event"; reqId: string; id: string }
  | { type: "create_calendar"; reqId: string; name: string; color?: string; groupId?: string }
  | { type: "update_calendar"; reqId: string; id: string; patch: CalendarPatch }
  | { type: "delete_calendar"; reqId: string; id: string };

export type MutationKind = Extract<Command, { type: `${string}_${"event" | "calendar" | "group"}` }>["type"];

export type Event =
  | { type: "pong"; reqId: string }
  | { type: "ack"; reqId: string }
  | { type: "schema"; reqId: string; protocolVersion: 1; schema: unknown }
  | { type: "bootstrap"; database: CalendarDatabase }
  | { type: "calendars_list"; reqId: string; calendars: Calendar[]; revision: number }
  | { type: "groups_list"; reqId: string; groups: CalendarGroup[]; revision: number }
  | { type: "group_created"; reqId: string; group: CalendarGroup; revision: number }
  | { type: "group_updated"; reqId: string; group: CalendarGroup; revision: number }
  | { type: "group_deleted"; reqId: string; id: string; revision: number }
  | { type: "events_list"; reqId: string; from: string; to: string; occurrences: EventOccurrence[]; revision: number }
  | { type: "event_details"; reqId: string; event: CalendarEvent; revision: number }
  | { type: "event_created"; reqId: string; event: CalendarEvent; revision: number }
  | { type: "event_updated"; reqId: string; event: CalendarEvent; revision: number }
  | { type: "event_deleted"; reqId: string; id: string; revision: number }
  | { type: "calendar_created"; reqId: string; calendar: Calendar; revision: number }
  | { type: "calendar_updated"; reqId: string; calendar: Calendar; revision: number }
  | { type: "calendar_deleted"; reqId: string; id: string; revision: number }
  | { type: "error"; message: string; reqId?: string }
  | { type: "daemon_shutdown" };
