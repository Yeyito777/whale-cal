import type { Command, Event } from "@whale-cal/shared/protocol";
import { daysBetween, isDateKey, occurrencesForRange } from "@whale-cal/shared/dates";
import { CAL_IPC_PROTOCOL_VERSION, CAL_IPC_SCHEMA } from "@whale-cal/shared/schema";
import { CalendarStore } from "./store";
import type { ClientConnection } from "./server";
import { DaemonServer } from "./server";

function reqId(command: Command): string | undefined {
  return "reqId" in command ? command.reqId : undefined;
}

export function createHandler(server: DaemonServer, store: CalendarStore) {
  return (client: ClientConnection, command: Command): void => {
    try {
      let event: Event | null = null;
      switch (command.type) {
        case "probe":
          server.send(client, { type: "pong", reqId: command.reqId });
          return;
        case "get_schema":
          server.send(client, {
            type: "schema",
            reqId: command.reqId,
            protocolVersion: CAL_IPC_PROTOCOL_VERSION,
            schema: CAL_IPC_SCHEMA,
          });
          return;
        case "bootstrap":
          server.send(client, { type: "bootstrap", database: store.snapshot() });
          return;
        case "list_calendars": {
          const database = store.snapshot();
          server.send(client, {
            type: "calendars_list",
            reqId: command.reqId,
            calendars: database.calendars,
            revision: database.revision,
          });
          return;
        }
        case "list_events": {
          if (!isDateKey(command.from) || !isDateKey(command.to)) throw new Error("Event range dates must use YYYY-MM-DD.");
          if (command.to < command.from) throw new Error("Event range end cannot be before its start.");
          if (daysBetween(command.from, command.to) > 3_660) throw new Error("Event range cannot exceed 3661 days.");
          const database = store.snapshot();
          const calendar = command.calendarId
            ? database.calendars.find(item => item.id === command.calendarId)
            : undefined;
          if (command.calendarId && !calendar) throw new Error("Calendar not found.");
          const visibleIds = new Set(database.calendars.filter(item => command.includeHidden || item.visible).map(item => item.id));
          const query = command.query?.trim().toLocaleLowerCase();
          const events = database.events.filter(item => {
            if (calendar && item.calendarId !== calendar.id) return false;
            if (!visibleIds.has(item.calendarId)) return false;
            if (!query) return true;
            return [item.title, item.location, item.notes].some(value => value?.toLocaleLowerCase().includes(query));
          });
          server.send(client, {
            type: "events_list",
            reqId: command.reqId,
            from: command.from,
            to: command.to,
            occurrences: occurrencesForRange(events, command.from, command.to),
            revision: database.revision,
          });
          return;
        }
        case "get_event": {
          const database = store.snapshot();
          const found = database.events.find(item => item.id === command.id);
          if (!found) throw new Error("Event not found.");
          server.send(client, { type: "event_details", reqId: command.reqId, event: found, revision: database.revision });
          return;
        }
        case "create_event": {
          const created = store.createEvent(command.event);
          event = { type: "event_created", reqId: command.reqId, event: created, revision: store.revision };
          break;
        }
        case "update_event": {
          const updated = store.updateEvent(command.id, command.patch);
          event = { type: "event_updated", reqId: command.reqId, event: updated, revision: store.revision };
          break;
        }
        case "delete_event":
          store.deleteEvent(command.id);
          event = { type: "event_deleted", reqId: command.reqId, id: command.id, revision: store.revision };
          break;
        case "create_calendar": {
          const calendar = store.createCalendar(command.name, command.color);
          event = { type: "calendar_created", reqId: command.reqId, calendar, revision: store.revision };
          break;
        }
        case "update_calendar": {
          const calendar = store.updateCalendar(command.id, command.patch);
          event = { type: "calendar_updated", reqId: command.reqId, calendar, revision: store.revision };
          break;
        }
        case "delete_calendar":
          store.deleteCalendar(command.id);
          event = { type: "calendar_deleted", reqId: command.reqId, id: command.id, revision: store.revision };
          break;
        default:
          server.send(client, { type: "error", message: "Unknown command.", reqId: reqId(command) });
          return;
      }
      server.broadcast(event);
    } catch (error) {
      server.send(client, {
        type: "error",
        message: error instanceof Error ? error.message : String(error),
        reqId: reqId(command),
      });
    }
  };
}
