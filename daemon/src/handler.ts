import type { Command, Event } from "@whale-cal/shared/protocol";
import { daysBetween, isDateKey, occurrencesForRange } from "@whale-cal/shared/dates";
import { CAL_IPC_PROTOCOL_VERSION, CAL_IPC_SCHEMA } from "@whale-cal/shared/schema";
import { CalendarStore } from "./store";
import type { ClientConnection } from "./server";
import { ApiError, Auth, LOCAL_OWNER } from "./auth";
import { authorize } from "./permissions";
import { validateCommand } from "./validation";

export interface CommandResponder {
  send(client: ClientConnection, event: Event): void;
  broadcast(event: Event, exclude?: ClientConnection): void;
  setCredentialCheck?(check: (client: ClientConnection) => boolean): void;
}

export interface HandlerLifecycle {
  /** Stop this exact daemon process with the supervisor-recognized restart exit code. */
  requestRestart?: () => void;
}

function reqId(command: Command): string | undefined {
  return "reqId" in command ? command.reqId : undefined;
}

export function createHandler(server: CommandResponder, store: CalendarStore, lifecycle: HandlerLifecycle = {}) {
  const auth = new Auth(store.persistence.sql);
  server.setCredentialCheck?.(client => {
    if (client.trustedLocal || !client.principal) return true;
    try { auth.authenticate(client.token ?? ""); return true; } catch { return false; }
  });
  const operation = createOperationHandler({
    send: (_client, event) => { result = event; },
    broadcast: event => { result = event; published = event; },
  }, store, lifecycle);
  let result: Event | undefined, published: Event | undefined;
  return (client: ClientConnection, input: Command): void => {
    result = published = undefined;
    try {
      validateCommand(input);
      // Socket liveness is deliberately non-secret and needed by the supervisor.
      // HTTP still authenticates at its boundary before reaching this handler.
      if (input.type === "probe") { server.send(client, { type: "pong", reqId: input.reqId }); return; }
      if (input.type === "authenticate") {
        const principal = auth.authenticate(input.token);
        client.principal = principal; client.token = input.token; client.trustedLocal = false;
        server.send(client, { type: "identity", reqId: input.reqId, user: principal, timeZone: store.snapshot().timeZone });
        return;
      }
      const principal = client.token ? auth.authenticate(client.token)
        : client.principal ?? (client.trustedLocal !== false ? LOCAL_OWNER : undefined);
      if (!principal) throw new ApiError("Authentication required.", "unauthorized");
      const command = input;
      const mutation = /^(create|update|delete|complete|assign)_/.test(command.type);
      const id = reqId(command);
      const encoded = canonicalJson(command);
      store.transaction(principal.id, () => {
        if (mutation && id) {
          const saved = store.persistence.sql.query("SELECT command, response FROM requests WHERE user_id=? AND req_id=?")
            .get(principal.id, id) as { command: string; response: string } | null;
          if (saved) {
            if (saved.command !== encoded) throw new ApiError("Request ID was already used with a different command.", "conflict");
            result = JSON.parse(saved.response);
            return;
          }
        }
        authorize(principal, command, store.snapshot());
        if (mutation && command.ifRevision !== undefined && command.ifRevision !== store.revision) {
          throw new ApiError("Calendar changed since it was read. Refresh before editing.", "conflict");
        }
        switch (command.type) {
          case "whoami": result = { type: "identity", reqId: command.reqId, user: principal, timeZone: store.snapshot().timeZone }; break;
          case "list_users": result = { type: "users_list", reqId: command.reqId, users: auth.users() }; break;
          case "list_tokens": result = { type: "tokens_list", reqId: command.reqId, tokens: auth.tokens() }; break;
          case "assign_owner":
            if (!auth.users().some(user => user.id === command.userId)) throw new ApiError("User not found.");
            store.assignOwner(command.target, command.id, command.userId);
            result = { type: "ack", reqId: command.reqId };
            published = { type: "bootstrap", database: store.snapshot() };
            break;
          case "create_user": {
            const user = auth.createUser(command.name);
            store.transaction(user.id, () => store.createCalendar(`${user.name.slice(0, 88)}'s calendar`));
            result = { type: "user_created", reqId: command.reqId, user };
            published = { type: "bootstrap", database: store.snapshot() };
            break;
          }
          case "create_token": result = { type: "token_created", reqId: command.reqId, ...auth.issueToken(command.userId, command.label) }; break;
          case "revoke_token": auth.revokeToken(command.tokenId); result = { type: "ack", reqId: command.reqId }; break;
          default: operation(client, command);
        }
        if (!result) throw new Error("Command produced no response.");
        if (result.type === "error") throw new Error(result.message);
        if (mutation && id) {
          // Never store a recoverable credential in the request journal. An
          // ambiguous token issuance can be revoked by ID instead of reissued.
          const saved = result.type === "token_created" ? {
            type: "error", code: "conflict", reqId: id,
            message: `Token was already issued for this request. If its secret was lost, revoke token ${result.tokenId} and issue a new request.`,
          } : result;
          store.persistence.sql.query("INSERT INTO requests VALUES (?, ?, ?, ?)").run(principal.id, id, encoded, JSON.stringify(saved));
        }
      });
      server.send(client, result!);
      if (published) server.broadcast(published, published === result ? client : undefined);
    } catch (error) {
      server.send(client, {
        type: "error", message: error instanceof Error ? error.message : "Daemon command failed.",
        ...(input && typeof input === "object" && "reqId" in input && typeof input.reqId === "string" ? { reqId: input.reqId } : {}),
        ...(error instanceof ApiError ? { code: error.code } : {}),
      });
    }
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .filter(([, item]) => item !== undefined).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function createOperationHandler(server: CommandResponder, store: CalendarStore, lifecycle: HandlerLifecycle = {}) {
  let restartRequested = false;
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
        case "restart_daemon":
          if (!lifecycle.requestRestart) {
            server.send(client, { type: "error", message: "This daemon instance cannot restart itself.", reqId: command.reqId });
            return;
          }
          server.send(client, { type: "ack", reqId: command.reqId });
          if (!restartRequested) {
            restartRequested = true;
            setTimeout(() => lifecycle.requestRestart?.(), 0);
          }
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
        case "list_groups":
          server.send(client, { type: "groups_list", reqId: command.reqId, groups: store.snapshot().groups ?? [], revision: store.revision });
          return;
        case "create_group":
          event = { type: "group_created", reqId: command.reqId, group: store.createGroup(command.name), revision: store.revision };
          break;
        case "update_group":
          event = { type: "group_updated", reqId: command.reqId, group: store.updateGroup(command.id, command.name), revision: store.revision };
          break;
        case "delete_group":
          store.deleteGroup(command.id);
          event = { type: "group_deleted", reqId: command.reqId, id: command.id, revision: store.revision };
          break;
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
        case "complete_event": {
          const updated = store.completeEvent(command.id, command.completed, command.occurrenceDate);
          event = { type: "event_updated", reqId: command.reqId, event: updated, revision: store.revision };
          break;
        }
        case "delete_event":
          store.deleteEvent(command.id);
          event = { type: "event_deleted", reqId: command.reqId, id: command.id, revision: store.revision };
          break;
        case "create_calendar": {
          const calendar = store.createCalendar(command.name, command.color, command.groupId);
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
