import schema from "../../schema/cal-ipc.schema.json";

/** Additive v1 protocol shared by Unix JSONL and the HTTP command API. */
export const CAL_IPC_PROTOCOL_VERSION = 1 as const;
export const CAL_IPC_SCHEMA = schema;
