import { deadlineKey, deadlineOccurrences, filterDeadlines, type DeadlineFilter } from "./deadline-list";
import { addDays, eventIsCompleted, isDateKey, isTimeKey, occurrencesOnDate, todayKey } from "@whale-cal/shared/dates";
import type { Calendar, CalendarDatabase, CalendarEvent, CalendarItemKind, CalendarView, DateKey, EventDraft, EventOccurrence, RecurrenceRule } from "@whale-cal/shared/types";
import { focusCalendar } from "./focus";

export type Focus = "calendar" | "sidebar";
export type VimMode = "normal" | "insert";

export interface PromptState {
  text: string; cursor: number; mode: VimMode;
  completion?: import("./completion").CompletionState | null;
  completionText?: string;
  completionCursor?: number;
  selectionAnchor?: number;
  focusEpoch?: number;
}

export type EditorFieldKey = "title" | "itemKind" | "startDate" | "endDate" | "startTime" | "endTime" | "calendar" | "location" | "repeat" | "notes";
export interface EditorField { key: EditorFieldKey; label: string; value: string }
export interface EditorState {
  kind: "create" | "edit";
  eventId?: string;
  fields: EditorField[];
  active: number;
  cursor: number;
  mode: VimMode;
  error?: string;
  saving?: string;
  originalDate?: DateKey;
  saveDate?: DateKey;
  lastStartDate?: DateKey;
  eventEnd?: { startDate: string; endDate: string; endTime: string };
}

export interface Notice { text: string; kind: "info" | "success" | "warning" | "error"; at: number }

export interface CalendarCellHit { date: DateKey; left: number; right: number; top: number; bottom: number }
export interface ActionHit { action: string; left: number; right: number; row: number }
export interface LayoutState {
  dayList?: { left: number; right: number; top: number; bottom: number };
  dayTimeline?: { scroll: number; maxScroll: number };
  deadlineDetails?: { left: number; right: number; top: number; bottom: number; maxScroll: number };
  sidebarWidth: number;
  calendarRows: Array<{ calendarId?: string; groupId?: string; row: number }>;
  monthCells: CalendarCellHit[];
  mainLeft: number;
  bodyTop: number;
  bodyBottom: number;
  actions: ActionHit[];
  eventRows: Array<{ index: number; left: number; right: number; row: number; date?: DateKey; eventId?: string }>;
  editorFields: Array<{ index: number; left: number; right: number; row: number }>;
}

export interface AppState {
  database: CalendarDatabase;
  selectedDate: DateKey;
  selectedEventIndex: number;
  selectedCalendarIndex: number;
  selectedGroupId: string | null;
  collapsedGroupIds: string[];
  hiddenCalendarIdsBySource: Record<string, string[]>;
  view: CalendarView;
  deadlineFilter: DeadlineFilter;
  deadlineIndex: number;
  deadlineSelectedKey: string | null;
  deadlineMarkedKeys: string[];
  focus: Focus;
  mainFocus: "calendar" | "prompt";
  sidebarOpen: boolean;
  prompt: PromptState | null;
  editor: EditorState | null;
  confirmDelete: CalendarEvent | null;
  dayOpen: boolean;
  detailScroll: number;
  dayTimelineScroll: number | null;
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
    database: emptyDatabase(), selectedDate: todayKey(), selectedEventIndex: 0, selectedCalendarIndex: 0, selectedGroupId: null, collapsedGroupIds: [], hiddenCalendarIdsBySource: {},
    view: "month", deadlineFilter: "pending", deadlineIndex: 0, deadlineSelectedKey: null, deadlineMarkedKeys: [], focus: "calendar", mainFocus: "calendar", sidebarOpen: false, prompt: null, editor: null, confirmDelete: null,
    dayOpen: false, detailScroll: 0, dayTimelineScroll: null, helpOpen: false, notice: { text: "Connecting to cald…", kind: "info", at: Date.now() }, remoteAlias: null,
    connected: false, cols: process.stdout.columns || 100, rows: process.stdout.rows || 30, pendingKeys: "",
    layout: { sidebarWidth: 0, calendarRows: [], monthCells: [], mainLeft: 1, bodyTop: 2, bodyBottom: 20, actions: [], eventRows: [], editorFields: [] },
  };
}

export function calendarFilterSource(state: AppState): string {
  return state.remoteAlias === null ? "local" : `ssh:${state.remoteAlias}`;
}

/** Visibility belongs to this UI, never to the canonical calendar record. */
export function calendarIsVisible(state: AppState, id: string): boolean {
  return !state.hiddenCalendarIdsBySource[calendarFilterSource(state)]?.includes(id);
}

export function toggleCalendarVisibility(state: AppState, id: string): boolean {
  const selected = selectedOccurrence(state);
  const source = calendarFilterSource(state);
  const hidden = state.hiddenCalendarIdsBySource[source] ?? [];
  const show = hidden.includes(id);
  state.hiddenCalendarIdsBySource[source] = show ? hidden.filter(value => value !== id) : [...hidden, id];
  const occurrences = eventsOnSelectedDate(state);
  const index = selected ? occurrences.findIndex(item => item.event.id === selected.event.id && item.startDate === selected.startDate) : -1;
  state.selectedEventIndex = index >= 0 ? index : Math.max(0, Math.min(state.selectedEventIndex, occurrences.length - 1));
  state.dayTimelineScroll = null;
  state.detailScroll = 0;
  return show;
}

export function visibleEvents(state: AppState): CalendarEvent[] {
  const visible = new Set(state.database.calendars.filter(calendar => calendarIsVisible(state, calendar.id)).map(calendar => calendar.id));
  return state.database.events.filter(event => visible.has(event.calendarId));
}

export function eventsOnSelectedDate(state: AppState): EventOccurrence[] {
  return occurrencesOnDate(visibleEvents(state), state.selectedDate);
}

export function selectedOccurrence(state: AppState): EventOccurrence | null {
  if (state.view === "deadlines" && !state.dayOpen) return selectedDeadline(state);
  const occurrences = eventsOnSelectedDate(state);
  if (occurrences.length === 0) return null;
  state.selectedEventIndex = Math.max(0, Math.min(state.selectedEventIndex, occurrences.length - 1));
  return occurrences[state.selectedEventIndex] ?? null;
}

export function selectDate(state: AppState, key: DateKey): void {
  state.selectedDate = key;
  state.selectedEventIndex = 0;
  state.detailScroll = 0;
  state.dayTimelineScroll = null;
}

export function moveDate(state: AppState, days: number): void { selectDate(state, addDays(state.selectedDate, days)); }

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
    { key: "itemKind", label: "Type", value: "event" },
    { key: "startDate", label: "Date", value: event?.startDate ?? state.selectedDate },
    { key: "endDate", label: "End date", value: event?.endDate ?? state.selectedDate },
    { key: "startTime", label: "Start", value: event?.startTime ?? "" },
    { key: "endTime", label: "End", value: event?.endTime ?? "" },
    { key: "calendar", label: "Calendar", value: calendar?.name ?? "Personal" },
    { key: "location", label: "Location", value: event?.location ?? "" },
    { key: "repeat", label: "Repeat", value: recurrenceText(event?.recurrence) },
    { key: "notes", label: "Notes", value: event?.notes ?? "" },
  ];
  const editor: EditorState = {
    kind: event ? "edit" : "create", ...(event ? { eventId: event.id } : {}), fields,
    active: 0, cursor: fields[0]!.value.length, mode: "insert", originalDate: event?.startDate, lastStartDate: event?.startDate ?? state.selectedDate,
  };
  if (event?.kind === "deadline") setEditorItemKind(editor, "deadline");
  return editor;
}

function field(editor: EditorState, key: EditorFieldKey): string {
  return editor.fields.find(item => item.key === key)?.value.trim() ?? "";
}

export function editorItemKind(editor: EditorState): CalendarItemKind {
  return field(editor, "itemKind") === "deadline" ? "deadline" : "event";
}

/** Changing type is reversible within the draft; deadlines have no duration fields. */
export function setEditorItemKind(editor: EditorState, kind: CalendarItemKind): void {
  if (kind === editorItemKind(editor)) return;
  const activeKey = editor.fields[editor.active]?.key;
  const actionOffset = editor.active - editor.fields.length;
  if (kind === "deadline") {
    editor.eventEnd = { startDate: field(editor, "startDate"), endDate: field(editor, "endDate"), endTime: field(editor, "endTime") };
    editor.fields = editor.fields.filter(item => item.key !== "endDate" && item.key !== "endTime");
  } else {
    const saved = editor.eventEnd;
    const endDate = saved && saved.endDate !== saved.startDate ? saved.endDate : field(editor, "startDate");
    editor.fields.splice(editor.fields.findIndex(item => item.key === "startDate") + 1, 0, { key: "endDate", label: "End date", value: endDate });
    editor.fields.splice(editor.fields.findIndex(item => item.key === "startTime") + 1, 0, { key: "endTime", label: "End", value: saved?.endTime ?? "" });
  }
  editor.fields.find(item => item.key === "itemKind")!.value = kind;
  editor.fields.find(item => item.key === "startDate")!.label = kind === "deadline" ? "Due date" : "Date";
  editor.fields.find(item => item.key === "startTime")!.label = kind === "deadline" ? "Due time" : "Start";
  editor.active = actionOffset >= 0 ? editor.fields.length + actionOffset : Math.max(0, editor.fields.findIndex(item => item.key === activeKey));
  editor.cursor = Math.min(editor.cursor, editor.fields[editor.active]?.value.length ?? 0);
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

export function syncEditorDates(editor: EditorState): void {
  const start = field(editor, "startDate");
  if (!isDateKey(start) || start === editor.lastStartDate) return;
  const end = editor.fields.find(item => item.key === "endDate");
  if (end && end.value === editor.lastStartDate) end.value = start;
  editor.lastStartDate = start;
}

export function editorDraft(state: AppState, editor: EditorState): EventDraft {
  syncEditorDates(editor);
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
  if (!isDateKey(startDate)) throw new Error("Date must be a real date in YYYY-MM-DD format.");
  if (!isDateKey(endDate)) throw new Error("End date must be a real date in YYYY-MM-DD format.");
  if (endDate < startDate) throw new Error("End date must not be before the start date.");
  if (startTime && !isTimeKey(startTime)) throw new Error("Start time must use 24-hour HH:MM format, e.g. 09:00.");
  if (endTime && !isTimeKey(endTime)) throw new Error("End time must use 24-hour HH:MM format, e.g. 10:00.");
  if (endTime && !startTime) throw new Error("Add a start time, or clear both times for an all-day event.");
  if (startDate === endDate && startTime && endTime && endTime <= startTime) throw new Error("End time must be after the start time.");
  const location = field(editor, "location");
  const notes = field(editor, "notes");
  return {
    kind: editorItemKind(editor), calendarId: calendar.id, title, startDate, endDate,
    ...(startTime ? { startTime } : {}), ...(endTime ? { endTime } : {}),
    ...(location ? { location } : {}), ...(notes ? { notes } : {}),
    ...(parseRepeat(field(editor, "repeat")) ? { recurrence: parseRepeat(field(editor, "repeat")) } : {}),
  };
}

export function setNotice(state: AppState, text: string, kind: Notice["kind"] = "info"): void {
  state.notice = { text, kind, at: Date.now() };
}

export function settleEditorSave(state: AppState, reqId: string, event: CalendarEvent): void {
  if (state.editor?.saving !== reqId) return;
  selectDate(state, state.editor.saveDate ?? event.startDate);
  state.editor = null;
  focusCalendar(state);
  state.dayOpen = state.view !== "deadlines";
  if (!state.dayOpen) state.deadlineSelectedKey = `${event.id}@${state.selectedDate}`;
  state.selectedEventIndex = Math.max(0, eventsOnSelectedDate(state).findIndex(item => item.event.id === event.id));
}

export function deadlinesInView(state: AppState): EventOccurrence[] {
  const items = filterDeadlines(deadlineOccurrences(visibleEvents(state)), state.deadlineFilter);
  if (state.deadlineFilter === "all") items.sort((a, b) => Number(eventIsCompleted(a.event, a.startDate)) - Number(eventIsCompleted(b.event, b.startDate)));
  const keys = new Set(items.map(deadlineKey));
  state.deadlineMarkedKeys = state.deadlineMarkedKeys.filter(key => keys.has(key));
  const index = items.findIndex(item => deadlineKey(item) === state.deadlineSelectedKey);
  state.deadlineIndex = index >= 0 ? index : Math.max(0, Math.min(state.deadlineIndex, items.length - 1));
  const selectedKey = items[state.deadlineIndex] ? deadlineKey(items[state.deadlineIndex]!) : null;
  if (selectedKey !== state.deadlineSelectedKey) state.detailScroll = 0;
  state.deadlineSelectedKey = selectedKey;
  return items;
}

export function selectedDeadline(state: AppState): EventOccurrence | null {
  return deadlinesInView(state)[state.deadlineIndex] ?? null;
}

export function moveDeadlineSelection(state: AppState, amount: number): void {
  state.detailScroll = 0;
  const items = deadlinesInView(state);
  state.deadlineIndex = Math.max(0, Math.min(items.length - 1, state.deadlineIndex + amount));
  state.deadlineSelectedKey = items[state.deadlineIndex] ? deadlineKey(items[state.deadlineIndex]!) : null;
}

export function setDeadlineFilter(state: AppState, filter: DeadlineFilter): void {
  state.deadlineFilter = filter; state.deadlineMarkedKeys = []; state.detailScroll = 0;
  state.deadlineIndex = 0; state.deadlineSelectedKey = null;
}

export function markDeadline(state: AppState): void {
  const item = selectedDeadline(state);
  if (!item) return;
  const key = deadlineKey(item);
  state.deadlineMarkedKeys = state.deadlineMarkedKeys.includes(key)
    ? state.deadlineMarkedKeys.filter(value => value !== key) : [...state.deadlineMarkedKeys, key];
}

export function deadlineCompletionTargets(state: AppState): EventOccurrence[] {
  const items = deadlinesInView(state);
  return state.deadlineMarkedKeys.length ? items.filter(item => state.deadlineMarkedKeys.includes(deadlineKey(item)))
    : items[state.deadlineIndex] ? [items[state.deadlineIndex]!] : [];
}
