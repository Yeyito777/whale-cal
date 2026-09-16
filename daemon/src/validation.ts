import { CAL_IPC_SCHEMA } from "@whale-cal/shared/schema";
import type { Command } from "@whale-cal/shared/protocol";
import type { CalendarDatabase } from "@whale-cal/shared/types";
import { ApiError } from "./auth";

type Schema = Record<string, any>;
/** Validator for the finite JSON Schema vocabulary used in cal-ipc.schema.json.
 * Calendar-specific date/recurrence invariants remain in CalendarStore. */
function matches(value: unknown, schema: Schema): boolean {
  if (schema.$ref) return matches(value, (CAL_IPC_SCHEMA.$defs as Schema)[schema.$ref.split("/").pop()]!);
  if (schema.oneOf && schema.oneOf.filter((s: Schema) => matches(value, s)).length !== 1) return false;
  if (schema.anyOf && !schema.anyOf.some((s: Schema) => matches(value, s))) return false;
  if (schema.allOf && !schema.allOf.every((s: Schema) => matches(value, s))) return false;
  if (schema.if && matches(value, schema.if) && schema.then && !matches(value, schema.then)) return false;
  if (schema.not && matches(value, schema.not)) return false;
  if ("const" in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  const types = schema.type ? [schema.type].flat() : [];
  if (types.length && !types.some(type => type === "null" ? value === null
    : type === "array" ? Array.isArray(value)
    : type === "object" ? value !== null && typeof value === "object" && !Array.isArray(value)
    : type === "integer" ? Number.isInteger(value) : typeof value === type)) return false;
  if (typeof value === "string" && ((schema.minLength !== undefined && value.length < schema.minLength)
    || (schema.maxLength !== undefined && value.length > schema.maxLength)
    || (schema.pattern && !new RegExp(schema.pattern).test(value)))) return false;
  if (typeof value === "number" && (!Number.isFinite(value)
    || (schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum))) return false;
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return false;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
    if (schema.items && !value.every(item => matches(item, schema.items))) return false;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    if (schema.required?.some((key: string) => !Object.hasOwn(object, key))) return false;
    if (schema.minProperties !== undefined && Object.keys(object).length < schema.minProperties) return false;
    for (const [key, item] of Object.entries(object)) {
      if (schema.properties && Object.hasOwn(schema.properties, key)) {
        if (!matches(item, schema.properties[key])) return false;
      } else if (schema.additionalProperties === false) return false;
    }
  }
  return true;
}

export function validateCommand(value: unknown): asserts value is Command {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const command = value as Record<string, any>;
    if (typeof command.reqId === "string" && command.reqId.startsWith("broadcast:")) throw new ApiError("The broadcast: request-ID prefix is reserved for server notifications.");
    const draft = command.type === "create_event" ? command.event : command.type === "update_event" ? command.patch : null;
    if (draft?.kind === "deadline" && draft.endTime != null) throw new ApiError("Deadlines have a due point, not an end time or duration.");
  }
  if (!matches(value, CAL_IPC_SCHEMA.$defs.command)) throw new ApiError("Invalid command: consult get_schema for required fields and types.");
}

export function validateDatabase(value: unknown): asserts value is CalendarDatabase {
  if (!matches(value, CAL_IPC_SCHEMA.$defs.database)) throw new Error("Invalid legacy calendar; JSON file was left untouched.");
}
