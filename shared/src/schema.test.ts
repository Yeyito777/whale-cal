import { expect, test } from "bun:test";
import { CAL_IPC_PROTOCOL_VERSION, CAL_IPC_SCHEMA } from "./schema";

interface Variant { properties?: { type?: { const?: string } } }
interface SchemaShape {
  $id?: string;
  $defs?: {
    command?: { oneOf?: Variant[] };
    calendarEvent?: { additionalProperties?: boolean; required?: string[] };
  };
}

test("IPC schema publishes every version-one command as a distinct variant", () => {
  const schema = CAL_IPC_SCHEMA as SchemaShape;
  const commands = schema.$defs?.command?.oneOf?.map(item => item.properties?.type?.const);
  expect(CAL_IPC_PROTOCOL_VERSION).toBe(1);
  expect(schema.$id).toContain("cal-ipc-v1");
  expect(commands).toEqual([
    "list_groups", "create_group", "update_group", "delete_group",
    "probe", "get_schema", "restart_daemon", "bootstrap", "list_calendars", "list_events", "get_event",
    "create_event", "update_event", "delete_event", "complete_event", "create_calendar", "update_calendar", "delete_calendar",
  ]);
  expect(new Set(commands).size).toBe((commands ?? []).length);
});

test("groups and nullable calendar membership are exposed in the machine contract", () => {
  const defs = CAL_IPC_SCHEMA.$defs;
  expect(defs.calendar.properties.groupId.type).toBe("string");
  expect(defs.database.properties.groups.items.$ref).toBe("#/$defs/calendarGroup");
  expect(defs.database.required).not.toContain("groups");
  const commands = defs.command.oneOf as any[];
  expect(commands.find(c => c.properties.type.const === "create_calendar").properties.groupId.type).toBe("string");
  expect(commands.find(c => c.properties.type.const === "update_calendar").properties.patch.properties.groupId.type).toEqual(["string", "null"]);
});

test("canonical event schema includes daemon-owned fields and rejects extras", () => {
  const definition = (CAL_IPC_SCHEMA as SchemaShape).$defs?.calendarEvent;
  expect(definition?.additionalProperties).toBe(false);
  expect(definition?.required).toContain("id");
  expect(definition?.required).toContain("calendarId");
  expect(definition?.required).toContain("createdAt");
  expect(definition?.required).toContain("updatedAt");
});

test("the machine contract exposes both kinds for create, update and canonical events", () => {
  const defs = CAL_IPC_SCHEMA.$defs;
  expect(defs.itemKind.enum).toEqual(["event", "deadline"]);
  expect(defs.eventDraft.properties.kind.$ref).toBe("#/$defs/itemKind");
  expect(defs.eventPatch.properties.kind.$ref).toBe("#/$defs/itemKind");
  expect(defs.calendarEvent.properties.kind.$ref).toBe("#/$defs/itemKind");
});
