import { addDays, occurrencesOnDate, todayKey } from "@whale-cal/shared/dates";
import type { Calendar, CalendarDatabase, CalendarEvent, CalendarView, DateKey, EventDraft, EventOccurrence, RecurrenceRule } from "@whale-cal/shared/types";

export type Focus = "calendar" | "sidebar";
export type VimMode = "normal" | "insert";

export interface PromptState { text: string; cursor: number; mode: VimMode }

export type EditorFieldKey = "title" | "startDate" | "endDate" | "startTime" | "endTime" | "calendar" | "location" | "repeat" | "notes";
export interface EditorField { key: EditorFieldKey; label: string; value: string }
export interface EditorState {
  kind: "create" | "edit";
  eventId?: string;
  fields: EditorField[];
  active: number;
  cursor: number;
  mode: VimMode;
}

export interface Notice { text: string; kind: "info" | "success" | "warning" | "error"; at: number }

export interface CalendarCellHit { date: DateKey; left: number; right: number; top: number; bottom: number }
export interface LayoutState {
  sidebarWidth: number;
  calendarRows: Array<{ calendarId: string; row: number }>;
  monthCells: CalendarCellHit[];
  mainLeft: number;
  bodyTop: number;
  bodyBottom: number;
}

export interface AppState {
  database: CalendarDatabase;
  selectedDate: DateKey;
  selectedEventIndex: number;
  selectedCalendarIndex: number;
  view: CalendarView;
  focus: Focus;
  sidebarOpen: boolean;
  prompt: PromptState | null;
  editor: EditorState | null;
  confirmDelete: CalendarEvent | null;
  dayOpen: boolean;
  helpOpen: boolean;
  notice: Notice | null;
  remoteAlias: string | null;
  connected: boolean;
  cols: number;
  rows: number;
  pendingKeys: string;
  layout: LayoutState;
}

export function emptyDatabase(): CalendarDatabase {
  return { version: 1, revision: 0, calendars: [], events: [] };
}

export function createState(): AppState {
  return {
    database: emptyDatabase(), selectedDate: todayKey(), selectedEventIndex: 0, selectedCalendarIndex: 0,
    view: "month", focus: "calendar", sidebarOpen: false, prompt: null, editor: null, confirmDelete: null,
    dayOpen: false, helpOpen: false, notice: { text: "Connecting to cald…", kind: "info", at: Date.now() }, remoteAlias: null,
    connected: false, cols: process.stdout.columns || 100, rows: process.stdout.rows || 30, pendingKeys: "",
    layout: { sidebarWidth: 0, calendarRows: [], monthCells: [], mainLeft: 1, bodyTop: 2, bodyBottom: 20 },
  };
}

export function visibleEvents(state: AppState): CalendarEvent[] {
  const visible = new Set(state.database.calendars.filter(calendar => calendar.visible).map(calendar => calendar.id));
  return state.database.events.filter(event => visible.has(event.calendarId));
}

export function eventsOnSelectedDate(state: AppState): EventOccurrence[] {
  return occurrencesOnDate(visibleEvents(state), state.selectedDate);
}

export function selectedOccurrence(state: AppState): EventOccurrence | null {
  const occurrences = eventsOnSelectedDate(state);
  if (occurrences.length === 0) return null;
  state.selectedEventIndex = Math.max(0, Math.min(state.selectedEventIndex, occurrences.length - 1));
  return occurrences[state.selectedEventIndex] ?? null;
}

export function selectDate(state: AppState, key: DateKey): void {
  state.selectedDate = key;
  state.selectedEventIndex = 0;
}

export function moveDate(state: AppState, days: number): void { selectDate(state, addDays(state.selectedDate, days)); }

export function cyclePanelFocus(state: AppState): void {
  if (state.sidebarOpen && state.cols >= 76) state.focus = state.focus === "calendar" ? "sidebar" : "calendar";
}

export function exitPromptAndCycleFocus(state: AppState): void {
  state.prompt = null;
  cyclePanelFocus(state);
}

export function selectedCalendar(state: AppState): Calendar | null {
  if (state.database.calendars.length === 0) return null;
  state.selectedCalendarIndex = Math.max(0, Math.min(state.selectedCalendarIndex, state.database.calendars.length - 1));
  return state.database.calendars[state.selectedCalendarIndex] ?? null;
}

function recurrenceText(rule?: RecurrenceRule): string {
  if (!rule) return "none";
  let text = `${rule.frequency}${rule.interval > 1 ? `/${rule.interval}` : ""}`;
  if (rule.until) text += ` until ${rule.until}`;
  if (rule.count) text += ` count ${rule.count}`;
  return text;
}

export function createEditor(state: AppState, event?: CalendarEvent): EditorState {
  const calendar = event
    ? state.database.calendars.find(item => item.id === event.calendarId)
    : selectedCalendar(state) ?? state.database.calendars[0];
  const fields: EditorField[] = [
    { key: "title", label: "Title", value: event?.title ?? "" },
    { key: "startDate", label: "Date", value: event?.startDate ?? state.selectedDate },
    { key: "endDate", label: "End date", value: event?.endDate ?? state.selectedDate },
    { key: "startTime", label: "Start", value: event?.startTime ?? "" },
    { key: "endTime", label: "End", value: event?.endTime ?? "" },
    { key: "calendar", label: "Calendar", value: calendar?.name ?? "Personal" },
    { key: "location", label: "Location", value: event?.location ?? "" },
    { key: "repeat", label: "Repeat", value: recurrenceText(event?.recurrence) },
    { key: "notes", label: "Notes", value: event?.notes ?? "" },
  ];
  return {
    kind: event ? "edit" : "create", ...(event ? { eventId: event.id } : {}), fields,
    active: 0, cursor: fields[0]!.value.length, mode: "insert",
  };
}

function field(editor: EditorState, key: EditorFieldKey): string {
  return editor.fields.find(item => item.key === key)?.value.trim() ?? "";
}

function parseRepeat(value: string): RecurrenceRule | undefined {
  if (!value || value.toLowerCase() === "none") return undefined;
  const match = /^(daily|weekly|monthly|yearly)(?:\/(\d+))?(?:\s+until\s+(\d{4}-\d{2}-\d{2}))?(?:\s+count\s+(\d+))?$/i.exec(value);
  if (!match) throw new Error("Repeat must look like weekly, monthly/2, or weekly until 2027-01-01.");
  return {
    frequency: match[1]!.toLowerCase() as RecurrenceRule["frequency"],
    interval: Math.max(1, Number(match[2] ?? 1)),
    ...(match[3] ? { until: match[3] } : {}),
    ...(match[4] ? { count: Number(match[4]) } : {}),
  };
}

export function editorDraft(state: AppState, editor: EditorState): EventDraft {
  const calendarName = field(editor, "calendar");
  const calendar = state.database.calendars.find(item => item.name.toLowerCase() === calendarName.toLowerCase())
    ?? state.database.calendars.find(item => item.id === calendarName);
  if (!calendar) throw new Error(`Calendar not found: ${calendarName}`);
  const title = field(editor, "title");
  if (!title) throw new Error("Title is required.");
  const startDate = field(editor, "startDate");
  const endDate = field(editor, "endDate") || startDate;
  const startTime = field(editor, "startTime");
  const endTime = field(editor, "endTime");
  const location = field(editor, "location");
  const notes = field(editor, "notes");
  return {
    calendarId: calendar.id, title, startDate, endDate,
    ...(startTime ? { startTime } : {}), ...(endTime ? { endTime } : {}),
    ...(location ? { location } : {}), ...(notes ? { notes } : {}),
    ...(parseRepeat(field(editor, "repeat")) ? { recurrence: parseRepeat(field(editor, "repeat")) } : {}),
  };
}

export function setNotice(state: AppState, text: string, kind: Notice["kind"] = "info"): void {
  state.notice = { text, kind, at: Date.now() };
}
