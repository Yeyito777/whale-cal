import schema from "../../schema/cal-ipc.schema.json";

/** Machine-readable JSON Schema served by cald through `get_schema`. */
export const CAL_IPC_PROTOCOL_VERSION = 1 as const;
export const CAL_IPC_SCHEMA = schema;
