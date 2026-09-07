#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { addDays, eventIsCompleted, formatItemTime, isDateKey, isTimeKey, todayKey } from "@whale-cal/shared/dates";
import type { Command, Event } from "@whale-cal/shared/protocol";
import type { Calendar, CalendarEvent, CalendarItemKind, EventDraft, EventPatch, RecurrenceRule } from "@whale-cal/shared/types";
import { request, requestRaw } from "./connection";

const HELP = `Whale Cal CLI — daemon-backed calendar access for people and AI agents

Usage:
  cal status [--json]
  cal schema
  cal calendars [--json]
  cal events [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--calendar ID|NAME]
             [--query TEXT] [--include-hidden] [--json]
  cal event get ID [--json]
  cal event create --title TEXT --date YYYY-MM-DD [options]
  cal event update ID [options]
  cal event delete ID --yes [--json]
  cal event complete ID [--date YYYY-MM-DD] [--json]
  cal event reopen ID [--date YYYY-MM-DD] [--json]
  cal calendar create --name TEXT [--color '#rrggbb'] [--json]
  cal calendar update ID [--name TEXT] [--color '#rrggbb'] [--show|--hide] [--json]
  cal calendar delete ID --yes [--json]
  cal ipc

Event create options:
  --type event|deadline  Default: event. Also supported by event update.
  --end-date DATE        Multi-day inclusive end (defaults to --date)
  --start HH:mm          Start wall time; omit for an all-day event
  --end HH:mm            End wall time
  --calendar ID|NAME     Calendar (defaults to the first calendar)
  --location TEXT
  --notes-stdin          Read notes from standard input
  --repeat RULE          daily, weekly, monthly, yearly, or e.g. weekly/2
  --until DATE           Inclusive recurrence limit
  --count NUMBER         Maximum occurrences, including the original

Event update options:
  --title TEXT, --date DATE, --end-date DATE, --start HH:mm, --end HH:mm,
  --calendar ID|NAME, --location TEXT, --notes-stdin, --repeat RULE,
  --until DATE, --count NUMBER, --all-day, --clear-location, --clear-notes,
  --clear-repeat

Completion: --date is required for recurring events and identifies the occurrence
start date. Completing one occurrence never completes the entire series.

Deadlines: --date is the due date; --start is the optional due time. Omit --start
for a date-only deadline. Deadlines cannot have --end or a different --end-date,
never block free time, and support recurrence and completion like events.
Updating --type deadline removes the old duration unless end fields are explicit.

Machine interface:
  'cal schema' returns the daemon's JSON Schema for protocol version 1.
  'cal ipc' forwards exactly one single-line JSON command object from stdin and
  prints one response event. reqId is required except for bootstrap. IPC is UTF-8 JSONL on
  a user-only Unix socket; mutations are canonicalized and broadcast by cald.

Defaults: 'cal events' lists today through 30 days from today, inclusive.
Omit --color when creating a calendar to pick a distinct unused color automatically.
Use --color only for an intentional custom color.
Delete commands require --yes. IDs are stable base-event/calendar IDs.`;

class UsageError extends Error {}
type OptionValue = string | true;
interface Parsed { positionals: string[]; options: Map<string, OptionValue>; }

const BOOLEAN_OPTIONS = new Set([
  "json", "include-hidden", "yes", "notes-stdin", "show", "hide", "all-day",
  "clear-location", "clear-notes", "clear-repeat",
]);

function parse(values: string[]): Parsed {
  const result: Parsed = { positionals: [], options: new Map() };
  for (let index = 0; index < values.length; index++) {
    const token = values[index]!;
    if (!token.startsWith("--")) { result.positionals.push(token); continue; }
    const equals = token.indexOf("=");
    const name = token.slice(2, equals === -1 ? undefined : equals);
    if (!name) throw new UsageError("Empty option name.");
    if (result.options.has(name)) throw new UsageError(`Option --${name} was supplied more than once.`);
    if (equals !== -1) result.options.set(name, token.slice(equals + 1));
    else if (BOOLEAN_OPTIONS.has(name)) result.options.set(name, true);
    else {
      const value = values[++index];
      if (value === undefined || value.startsWith("--")) throw new UsageError(`Option --${name} requires a value.`);
      result.options.set(name, value);
    }
  }
  return result;
}

function allowed(parsed: Parsed, names: readonly string[]): void {
  const valid = new Set(names);
  for (const name of parsed.options.keys()) if (!valid.has(name)) throw new UsageError(`Unknown option --${name}.`);
}

function option(parsed: Parsed, name: string): string | undefined {
  const value = parsed.options.get(name);
  return typeof value === "string" ? value : undefined;
}

function flag(parsed: Parsed, name: string): boolean { return parsed.options.get(name) === true; }
function reqId(): string { return `cal-cli-${randomUUID()}`; }
function printJson(value: unknown): void { process.stdout.write(JSON.stringify(value, null, 2) + "\n"); }

function requireDate(value: string | undefined, label: string): string {
  if (!value) throw new UsageError(`${label} is required.`);
  if (!isDateKey(value)) throw new UsageError(`${label} must be a real date in YYYY-MM-DD form.`);
  return value;
}

function optionalTime(value: string | undefined, label: string): string | undefined {
  if (value !== undefined && !isTimeKey(value)) throw new UsageError(`${label} must use 24-hour HH:mm form.`);
  return value;
}

function positiveInteger(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 100_000) throw new UsageError(`${label} must be an integer from 1 to 100000.`);
  return number;
}

function recurrence(parsed: Parsed): RecurrenceRule | undefined {
  const raw = option(parsed, "repeat");
  const until = option(parsed, "until");
  const count = positiveInteger(option(parsed, "count"), "--count");
  if (!raw) {
    if (until || count) throw new UsageError("--until and --count require --repeat.");
    return undefined;
  }
  const match = /^(daily|weekly|monthly|yearly)(?:\/([1-9][0-9]{0,2}))?$/.exec(raw);
  if (!match) throw new UsageError("--repeat must be daily, weekly, monthly, yearly, or RULE/INTERVAL (for example weekly/2).");
  if (until && !isDateKey(until)) throw new UsageError("--until must be a real date in YYYY-MM-DD form.");
  return {
    frequency: match[1] as RecurrenceRule["frequency"],
    interval: Number(match[2] ?? 1),
    ...(until ? { until } : {}),
    ...(count ? { count } : {}),
  };
}

async function stdinText(): Promise<string> {
  const bytes = await Bun.stdin.arrayBuffer();
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new UsageError("Standard input is not valid UTF-8."); }
}

async function calendars(): Promise<{ calendars: Calendar[]; revision: number }> {
  const event = await request({ type: "list_calendars", reqId: reqId() });
  if (event.type !== "calendars_list") throw new Error("Unexpected daemon response.");
  return event;
}

async function calendarId(value: string | undefined): Promise<string | undefined> {
  if (!value) return undefined;
  const list = (await calendars()).calendars;
  const exactId = list.find(item => item.id === value);
  if (exactId) return exactId.id;
  const byName = list.filter(item => item.name.toLocaleLowerCase() === value.toLocaleLowerCase());
  if (byName.length === 1) return byName[0]!.id;
  if (byName.length > 1) throw new UsageError(`Calendar name '${value}' is ambiguous; use its ID.`);
  throw new UsageError(`Calendar '${value}' was not found.`);
}

function eventLine(event: CalendarEvent, startDate = event.startDate, endDate = event.endDate, occurrenceId = event.id): string {
  const dates = endDate === startDate ? startDate : `${startDate}–${endDate}`;
  return `${dates}  ${formatItemTime(event).padEnd(13)}  ${event.kind === "deadline" ? "◆ " : ""}${eventIsCompleted(event, startDate) ? "[done] " : ""}${event.title}  [event:${event.id}] [occurrence:${occurrenceId}] [calendar:${event.calendarId}]`;
}

function printEventDetails(event: CalendarEvent): void {
  console.log(`Event ID:    ${event.id}`);
  console.log(`Calendar ID: ${event.calendarId}`);
  console.log(`Title:       ${event.title}`);
  console.log(`Type:        ${event.kind ?? "event"}`);
  console.log(`Completion:  ${event.recurrence ? `${event.completedDates?.length ?? 0} occurrences completed` : event.completed ? "done" : "unfinished"}`);
  if (event.recurrence && event.completedDates?.length) console.log(`Done dates:  ${event.completedDates.join(", ")}`);
  console.log(`When:        ${event.startDate}${event.endDate !== event.startDate ? ` through ${event.endDate}` : ""}, ${formatItemTime(event)}`);
  if (event.location) console.log(`Location:    ${event.location}`);
  if (event.recurrence) console.log(`Repeat:      ${event.recurrence.frequency}/${event.recurrence.interval}${event.recurrence.until ? ` until ${event.recurrence.until}` : ""}${event.recurrence.count ? ` count ${event.recurrence.count}` : ""}`);
  if (event.notes) console.log(`Notes:\n${event.notes}`);
}

async function statusCommand(parsed: Parsed): Promise<void> {
  allowed(parsed, ["json"]);
  if (parsed.positionals.length) throw new UsageError("status takes no positional arguments.");
  const started = performance.now();
  const event = await request({ type: "probe", reqId: reqId() });
  const output = { ok: event.type === "pong", daemon: "cald", protocolVersion: 1, latencyMs: Math.round(performance.now() - started) };
  if (flag(parsed, "json")) printJson(output); else console.log(`cald is running (protocol 1, ${output.latencyMs}ms).`);
}

async function schemaCommand(parsed: Parsed): Promise<void> {
  allowed(parsed, []);
  if (parsed.positionals.length) throw new UsageError("schema takes no arguments.");
  const event = await request({ type: "get_schema", reqId: reqId() });
  if (event.type !== "schema") throw new Error("Unexpected daemon response.");
  printJson(event.schema);
}

async function calendarsCommand(parsed: Parsed): Promise<void> {
  allowed(parsed, ["json"]);
  if (parsed.positionals.length) throw new UsageError("calendars takes no positional arguments.");
  const result = await calendars();
  if (flag(parsed, "json")) { printJson(result.calendars); return; }
  for (const item of result.calendars) console.log(`${item.visible ? "visible" : "hidden "}  ${item.color}  ${item.name}  [calendar:${item.id}]`);
}

async function eventsCommand(parsed: Parsed): Promise<void> {
  allowed(parsed, ["from", "to", "calendar", "query", "include-hidden", "json"]);
  if (parsed.positionals.length) throw new UsageError("events takes no positional arguments.");
  const from = option(parsed, "from") ?? todayKey();
  const to = option(parsed, "to") ?? addDays(from, 30);
  requireDate(from, "--from"); requireDate(to, "--to");
  const command: Command = {
    type: "list_events", reqId: reqId(), from, to,
    ...(option(parsed, "calendar") ? { calendarId: await calendarId(option(parsed, "calendar")) } : {}),
    ...(option(parsed, "query") ? { query: option(parsed, "query") } : {}),
    ...(flag(parsed, "include-hidden") ? { includeHidden: true } : {}),
  };
  const event = await request(command);
  if (event.type !== "events_list") throw new Error("Unexpected daemon response.");
  if (flag(parsed, "json")) { printJson(event.occurrences); return; }
  if (!event.occurrences.length) { console.log(`No events from ${from} through ${to}.`); return; }
  for (const item of event.occurrences) console.log(eventLine(item.event, item.startDate, item.endDate, item.id));
}

async function eventGet(parsed: Parsed): Promise<void> {
  allowed(parsed, ["json"]);
  if (parsed.positionals.length !== 1) throw new UsageError("event get requires exactly one event ID.");
  const response = await request({ type: "get_event", reqId: reqId(), id: parsed.positionals[0]! });
  if (response.type !== "event_details") throw new Error("Unexpected daemon response.");
  if (flag(parsed, "json")) printJson(response.event); else printEventDetails(response.event);
}

function itemKind(parsed: Parsed): CalendarItemKind | undefined {
  const kind = option(parsed, "type");
  if (kind !== undefined && kind !== "event" && kind !== "deadline") throw new UsageError("--type must be event or deadline.");
  return kind;
}

const EVENT_VALUE_OPTIONS = ["type", "title", "date", "end-date", "start", "end", "calendar", "location", "notes-stdin", "repeat", "until", "count", "json"] as const;

async function eventCreate(parsed: Parsed): Promise<void> {
  allowed(parsed, EVENT_VALUE_OPTIONS);
  if (parsed.positionals.length) throw new UsageError("event create takes options, not positional arguments.");
  const title = option(parsed, "title");
  if (!title?.trim()) throw new UsageError("--title is required.");
  const startDate = requireDate(option(parsed, "date"), "--date");
  const endDate = option(parsed, "end-date") ?? startDate;
  requireDate(endDate, "--end-date");
  const startTime = optionalTime(option(parsed, "start"), "--start");
  const endTime = optionalTime(option(parsed, "end"), "--end");
  if (endTime && !startTime) throw new UsageError("--end requires --start.");
  const selectedCalendar = await calendarId(option(parsed, "calendar"));
  const notes = flag(parsed, "notes-stdin") ? await stdinText() : undefined;
  const repeat = recurrence(parsed);
  const draft: EventDraft = {
    ...(itemKind(parsed) ? { kind: itemKind(parsed) } : {}),
    title, startDate, endDate,
    ...(selectedCalendar ? { calendarId: selectedCalendar } : {}),
    ...(startTime ? { startTime } : {}), ...(endTime ? { endTime } : {}),
    ...(option(parsed, "location") !== undefined ? { location: option(parsed, "location") } : {}),
    ...(notes !== undefined ? { notes } : {}),
    ...(repeat ? { recurrence: repeat } : {}),
  };
  const response = await request({ type: "create_event", reqId: reqId(), event: draft });
  if (response.type !== "event_created") throw new Error("Unexpected daemon response.");
  if (flag(parsed, "json")) printJson(response.event); else console.log(`Created. Event ID: ${response.event.id}`);
}

async function eventUpdate(parsed: Parsed): Promise<void> {
  allowed(parsed, [...EVENT_VALUE_OPTIONS, "all-day", "clear-location", "clear-notes", "clear-repeat"]);
  if (parsed.positionals.length !== 1) throw new UsageError("event update requires exactly one event ID.");
  if (flag(parsed, "all-day") && (option(parsed, "start") || option(parsed, "end"))) throw new UsageError("--all-day cannot be combined with --start or --end.");
  if (flag(parsed, "clear-location") && option(parsed, "location") !== undefined) throw new UsageError("Use either --location or --clear-location.");
  if (flag(parsed, "clear-notes") && flag(parsed, "notes-stdin")) throw new UsageError("Use either --notes-stdin or --clear-notes.");
  if (flag(parsed, "clear-repeat") && (option(parsed, "repeat") || option(parsed, "until") || option(parsed, "count"))) {
    throw new UsageError("Use either recurrence options or --clear-repeat.");
  }
  const repeat = flag(parsed, "clear-repeat") ? undefined : recurrence(parsed);
  const patch: EventPatch = {};
  if (itemKind(parsed)) patch.kind = itemKind(parsed);
  if (option(parsed, "title") !== undefined) patch.title = option(parsed, "title")!;
  if (option(parsed, "date") !== undefined) patch.startDate = requireDate(option(parsed, "date"), "--date");
  if (option(parsed, "end-date") !== undefined) patch.endDate = requireDate(option(parsed, "end-date"), "--end-date");
  if (option(parsed, "calendar") !== undefined) patch.calendarId = await calendarId(option(parsed, "calendar"));
  if (flag(parsed, "all-day")) { patch.startTime = null; patch.endTime = null; }
  else {
    if (option(parsed, "start") !== undefined) patch.startTime = optionalTime(option(parsed, "start"), "--start");
    if (option(parsed, "end") !== undefined) patch.endTime = optionalTime(option(parsed, "end"), "--end");
  }
  if (option(parsed, "location") !== undefined) patch.location = option(parsed, "location")!;
  if (flag(parsed, "clear-location")) patch.location = null;
  if (flag(parsed, "notes-stdin")) patch.notes = await stdinText();
  if (flag(parsed, "clear-notes")) patch.notes = null;
  if (repeat) patch.recurrence = repeat;
  if (flag(parsed, "clear-repeat")) patch.recurrence = null;
  if (!Object.keys(patch).length) throw new UsageError("event update requires at least one field to change.");
  const response = await request({ type: "update_event", reqId: reqId(), id: parsed.positionals[0]!, patch });
  if (response.type !== "event_updated") throw new Error("Unexpected daemon response.");
  if (flag(parsed, "json")) printJson(response.event); else console.log(`Updated. Event ID: ${response.event.id}`);
}

async function eventCompletion(parsed: Parsed, completed: boolean): Promise<void> {
  allowed(parsed, ["date", "json"]);
  if (parsed.positionals.length !== 1) throw new UsageError("Completion requires exactly one base event ID.");
  const occurrenceDate = option(parsed, "date");
  if (occurrenceDate !== undefined && !isDateKey(occurrenceDate)) throw new UsageError("--date must be a real YYYY-MM-DD date.");
  const response = await request({ type: "complete_event", reqId: reqId(), id: parsed.positionals[0]!, completed, ...(occurrenceDate ? { occurrenceDate } : {}) });
  if (response.type !== "event_updated") throw new Error("Unexpected daemon response.");
  if (flag(parsed, "json")) printJson(response.event);
  else console.log(`${completed ? "Completed" : "Reopened"}. Event ID: ${response.event.id}${occurrenceDate ? ` · ${occurrenceDate}` : ""}`);
}

async function eventDelete(parsed: Parsed): Promise<void> {
  allowed(parsed, ["yes", "json"]);
  if (parsed.positionals.length !== 1) throw new UsageError("event delete requires exactly one event ID.");
  if (!flag(parsed, "yes")) throw new UsageError("Refusing to delete without --yes.");
  const id = parsed.positionals[0]!;
  const response = await request({ type: "delete_event", reqId: reqId(), id });
  if (response.type !== "event_deleted") throw new Error("Unexpected daemon response.");
  if (flag(parsed, "json")) printJson({ deleted: true, id }); else console.log(`Deleted. Event ID: ${id}`);
}

async function calendarCreate(parsed: Parsed): Promise<void> {
  allowed(parsed, ["name", "color", "json"]);
  if (parsed.positionals.length) throw new UsageError("calendar create takes options, not positional arguments.");
  const name = option(parsed, "name");
  if (!name?.trim()) throw new UsageError("--name is required.");
  const response = await request({ type: "create_calendar", reqId: reqId(), name, ...(option(parsed, "color") ? { color: option(parsed, "color") } : {}) });
  if (response.type !== "calendar_created") throw new Error("Unexpected daemon response.");
  if (flag(parsed, "json")) printJson(response.calendar); else console.log(`Created. Calendar ID: ${response.calendar.id}`);
}

async function calendarUpdate(parsed: Parsed): Promise<void> {
  allowed(parsed, ["name", "color", "show", "hide", "json"]);
  if (parsed.positionals.length !== 1) throw new UsageError("calendar update requires exactly one calendar ID.");
  if (flag(parsed, "show") && flag(parsed, "hide")) throw new UsageError("Use either --show or --hide.");
  const patch: Partial<Pick<Calendar, "name" | "color" | "visible">> = {};
  if (option(parsed, "name") !== undefined) patch.name = option(parsed, "name")!;
  if (option(parsed, "color") !== undefined) patch.color = option(parsed, "color")!;
  if (flag(parsed, "show")) patch.visible = true;
  if (flag(parsed, "hide")) patch.visible = false;
  if (!Object.keys(patch).length) throw new UsageError("calendar update requires at least one field to change.");
  const response = await request({ type: "update_calendar", reqId: reqId(), id: parsed.positionals[0]!, patch });
  if (response.type !== "calendar_updated") throw new Error("Unexpected daemon response.");
  if (flag(parsed, "json")) printJson(response.calendar); else console.log(`Updated. Calendar ID: ${response.calendar.id}`);
}

async function calendarDelete(parsed: Parsed): Promise<void> {
  allowed(parsed, ["yes", "json"]);
  if (parsed.positionals.length !== 1) throw new UsageError("calendar delete requires exactly one calendar ID.");
  if (!flag(parsed, "yes")) throw new UsageError("Refusing to delete without --yes.");
  const id = parsed.positionals[0]!;
  const response = await request({ type: "delete_calendar", reqId: reqId(), id });
  if (response.type !== "calendar_deleted") throw new Error("Unexpected daemon response.");
  if (flag(parsed, "json")) printJson({ deleted: true, id }); else console.log(`Deleted. Calendar ID: ${id}`);
}

async function ipcCommand(rawArgs: string[]): Promise<void> {
  if (rawArgs.length) throw new UsageError("ipc takes no arguments; send one JSON object on standard input.");
  const source = await stdinText();
  const withoutFinalNewline = source.endsWith("\n") ? source.slice(0, -1) : source;
  if (!withoutFinalNewline || /[\r\n]/.test(withoutFinalNewline)) {
    throw new UsageError("ipc input must be exactly one single-line JSON command object.");
  }
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new UsageError("ipc standard input must contain exactly one valid JSON value."); }
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as { type?: unknown }).type !== "string") {
    throw new UsageError("ipc input must be a JSON command object with a string type.");
  }
  const command = value as Record<string, unknown>;
  if (command.type !== "bootstrap" && (typeof command.reqId !== "string" || !command.reqId)) {
    throw new UsageError("ipc commands other than bootstrap require a non-empty string reqId.");
  }
  printJson(await requestRaw(source, command));
}

async function main(argv: string[]): Promise<void> {
  if (!argv.length || argv[0] === "-h" || argv[0] === "--help" || argv[0] === "help") { console.log(HELP); return; }
  const [command, ...rest] = argv;
  if (command === "ipc") { await ipcCommand(rest); return; }
  const parsed = parse(rest);
  switch (command) {
    case "status": await statusCommand(parsed); return;
    case "schema": await schemaCommand(parsed); return;
    case "calendars": await calendarsCommand(parsed); return;
    case "events": await eventsCommand(parsed); return;
    case "event": {
      const operation = parsed.positionals.shift();
      if (operation === "get") await eventGet(parsed);
      else if (operation === "create") await eventCreate(parsed);
      else if (operation === "update") await eventUpdate(parsed);
      else if (operation === "delete") await eventDelete(parsed);
      else if (operation === "complete") await eventCompletion(parsed, true);
      else if (operation === "reopen") await eventCompletion(parsed, false);
      else throw new UsageError("event requires get, create, update, delete, complete, or reopen.");
      return;
    }
    case "calendar": {
      const operation = parsed.positionals.shift();
      if (operation === "create") await calendarCreate(parsed);
      else if (operation === "update") await calendarUpdate(parsed);
      else if (operation === "delete") await calendarDelete(parsed);
      else throw new UsageError("calendar requires create, update, or delete.");
      return;
    }
    default: throw new UsageError(`Unknown command '${command}'.`);
  }
}

main(process.argv.slice(2)).catch(error => {
  console.error(`cal: ${error instanceof Error ? error.message : String(error)}`);
  if (error instanceof UsageError) console.error("Run `cal -h` for usage.");
  process.exit(error instanceof UsageError ? 2 : 1);
});
