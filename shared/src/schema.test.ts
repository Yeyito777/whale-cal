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
    "probe", "get_schema", "restart_daemon", "bootstrap", "list_calendars", "list_events", "get_event",
    "create_event", "update_event", "delete_event", "complete_event", "create_calendar", "update_calendar", "delete_calendar",
  ]);
  expect(new Set(commands).size).toBe((commands ?? []).length);
});

test("canonical event schema includes daemon-owned fields and rejects extras", () => {
  const definition = (CAL_IPC_SCHEMA as SchemaShape).$defs?.calendarEvent;
  expect(definition?.additionalProperties).toBe(false);
  expect(definition?.required).toContain("id");
  expect(definition?.required).toContain("calendarId");
  expect(definition?.required).toContain("createdAt");
  expect(definition?.required).toContain("updatedAt");
});
