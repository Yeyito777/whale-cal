import { addDays, addMonths, eventIsCompleted, occurrencesForRange, todayKey } from "@whale-cal/shared/dates";
import type { CalendarEvent, CalendarItemKind, CalendarView, EventDraft, EventPatch } from "@whale-cal/shared/types";
import { DaemonClient, type ClientEvent } from "./client";
import { runCommand, type CommandAction } from "./commands";
import { PromptController } from "./prompt";
import { daySchedule } from "./day-schedule";
import { moveTimelineSelection } from "./day-timeline";
import { focusCalendar, focusPrompt, focusSidebar, handleFocusKey, isPromptFocused } from "./focus";
import { STATUSLINE_HEIGHT } from "./statusline";
import { cycleCompletion } from "./completion";
import { invalidateFrame } from "./frame";
import { InputBuffer, parseInput, type KeyEvent, type MouseEvent } from "./input";
import { loadPreferences, savePreferences } from "./preferences";
import { render } from "./render";
import {
  createEditor, createState, editorDraft, editorItemKind, setEditorItemKind, eventsOnSelectedDate,
  moveDate, selectDate, selectedCalendar, selectedOccurrence, setNotice, settleEditorSave, syncEditorDates, type AppState, type EditorState,
} from "./state";
import {
  cursorBar, disableKittyKeyboard, disableMouse, disablePaste, enableKittyKeyboard, enableMouse, enablePaste,
  enterAlt, hideCursor, leaveAlt, resetCursorColor, setCursorColor, showCursor,
} from "./terminal";
import { theme } from "./theme";
import { inputWindow, nextGrapheme, previousGrapheme, width } from "./text";

const state = createState();
loadPreferences(state);
let client: DaemonClient;
let running = true;
let terminalReady = false;
let renderTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let noticeTimer: ReturnType<typeof setTimeout> | null = null;
const pending = new Map<string, string>();
const promptController = new PromptController();
const statusTimer = setInterval(() => scheduleRender(), 1000);

function scheduleRender(immediate = false): void {
  if (!running) return;
  if (immediate) {
    if (renderTimer) clearTimeout(renderTimer);
    renderTimer = null;
    render(state);
    return;
  }
  if (renderTimer) return;
  renderTimer = setTimeout(() => { renderTimer = null; render(state); }, 16);
}

function notice(text: string, kind: "info" | "success" | "warning" | "error" = "info"): void {
  setNotice(state, text, kind);
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { state.notice = null; scheduleRender(); }, 5000);
  scheduleRender();
}

function track(reqId: string, message: string): void { pending.set(reqId, message); }

function applyRevision(revision: number): boolean {
  if (revision <= state.database.revision) return false;
  if (revision !== state.database.revision + 1) {
    client.bootstrap();
    return false;
  }
  state.database.revision = revision;
  return true;
}

function settle(reqId: string): void {
  const message = pending.get(reqId);
  if (!message) return;
  pending.delete(reqId);
  notice(message, "success");
}

function onClientEvent(event: ClientEvent): void {
  if (event.type === "route_status") {
    state.connected = event.state === "connected";
    if (event.state === "failed" && state.editor?.saving) {
      state.editor.saving = undefined;
      state.editor.error = "Connection lost. Save status is unknown; check the day before retrying.";
    }
    if (event.state === "connected") state.remoteAlias = event.mode === "remote" ? event.alias ?? null : null;
    if (event.state === "connected") {
      state.notice = null;
      scheduleRender();
    } else notice(event.message, event.state === "failed" ? "error" : "warning");
    return;
  }
  switch (event.type) {
    case "bootstrap":
      state.database = event.database;
      state.connected = true;
      state.selectedCalendarIndex = Math.min(state.selectedCalendarIndex, Math.max(0, event.database.calendars.length - 1));
      state.selectedEventIndex = Math.min(state.selectedEventIndex, Math.max(0, eventsOnSelectedDate(state).length - 1));
      scheduleRender();
      return;
    case "event_created":
      if (applyRevision(event.revision)) state.database.events.push(event.event);
      settleEditorSave(state, event.reqId, event.event);
      settle(event.reqId);
      scheduleRender();
      return;
    case "event_updated": {
      if (applyRevision(event.revision)) {
        const index = state.database.events.findIndex(item => item.id === event.event.id);
        if (index === -1) state.database.events.push(event.event); else state.database.events[index] = event.event;
      }
      settleEditorSave(state, event.reqId, event.event);
      settle(event.reqId);
      scheduleRender();
      return;
    }
    case "event_deleted":
      if (!applyRevision(event.revision)) return;
      state.database.events = state.database.events.filter(item => item.id !== event.id);
      state.selectedEventIndex = Math.min(state.selectedEventIndex, Math.max(0, eventsOnSelectedDate(state).length - 1));
      settle(event.reqId);
      scheduleRender();
      return;
    case "calendar_created":
      if (!applyRevision(event.revision)) return;
      state.database.calendars.push(event.calendar);
      state.selectedCalendarIndex = state.database.calendars.length - 1;
      settle(event.reqId);
      scheduleRender();
      return;
    case "calendar_updated": {
      if (!applyRevision(event.revision)) return;
      const index = state.database.calendars.findIndex(item => item.id === event.calendar.id);
      if (index !== -1) state.database.calendars[index] = event.calendar;
      settle(event.reqId);
      scheduleRender();
      return;
    }
    case "calendar_deleted":
      if (!applyRevision(event.revision)) return;
      state.database.calendars = state.database.calendars.filter(item => item.id !== event.id);
      scheduleRender();
      return;
    case "error":
      if (event.reqId) pending.delete(event.reqId);
      if (event.reqId && state.editor?.saving === event.reqId) {
        state.editor.saving = undefined;
        state.editor.error = event.message;
      }
      notice(event.message, "error");
      return;
    case "pong": case "ack": case "daemon_shutdown": return;
  }
}

function scheduleReconnect(): void {
  state.connected = false;
  scheduleRender();
  if (reconnectTimer || !running) return;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try { await client.connect(); }
    catch { scheduleReconnect(); }
  }, 1000);
}

function openNewEditor(kind: CalendarItemKind = "event"): void {
  if (state.database.calendars.length === 0) { notice("No calendar is available.", "error"); return; }
  state.editor = createEditor(state);
  setEditorItemKind(state.editor, kind);
}

function editSelected(): void {
  const occurrence = selectedOccurrence(state);
  if (!occurrence) { openNewEditor(); return; }
  state.editor = createEditor(state, occurrence.event);
}

function completeSelected(completed?: boolean): void {
  const occurrence = selectedOccurrence(state);
  if (!occurrence) { notice("No event is selected.", "warning"); return; }
  const done = completed ?? !eventIsCompleted(occurrence.event, occurrence.startDate);
  track(client.completeEvent(occurrence.event.id, done, occurrence.startDate), `${done ? "Completed" : "Reopened"} “${occurrence.event.title}”.`);
}

function confirmDelete(): void {
  const occurrence = selectedOccurrence(state);
  if (!occurrence) { notice("No event is selected.", "warning"); return; }
  state.confirmDelete = occurrence.event;
}

function createEvent(draft: EventDraft): void {
  const calendar = selectedCalendar(state) ?? state.database.calendars[0];
  if (!calendar) { notice("No calendar is available.", "error"); return; }
  const reqId = client.createEvent({ ...draft, calendarId: draft.calendarId ?? calendar.id });
  track(reqId, `Created “${draft.title}”.`);
}

function saveEditor(editor: EditorState): void {
  if (editor.saving) return;
  try {
    if (!client.connected) throw new Error("Offline. Your draft is kept here; reconnect before saving.");
    const draft = editorDraft(state, editor);
    editor.error = undefined;
    editor.saveDate = editor.originalDate === draft.startDate ? state.selectedDate : draft.startDate;
    if (editor.kind === "edit" && editor.eventId) {
      const patch: EventPatch = {
        ...draft,
        startTime: draft.startTime ?? null,
        endTime: draft.endTime ?? null,
        location: draft.location ?? null,
        notes: draft.notes ?? null,
        recurrence: draft.recurrence ?? null,
      };
      const reqId = client.updateEvent(editor.eventId, patch);
      editor.saving = reqId;
      track(reqId, `Updated “${draft.title}”.`);
    } else {
      editor.saving = client.createEvent(draft);
      track(editor.saving, `Created “${draft.title}”.`);
    }
  } catch (error) {
    editor.error = error instanceof Error ? error.message : String(error);
    notice(editor.error, "error");
  }
}

function cycleView(): void {
  const views: CalendarView[] = ["month", "week", "agenda"];
  state.view = views[(views.indexOf(state.view) + 1) % views.length]!;
}

function execute(action: CommandAction): void {
  switch (action.type) {
    case "none": return;
    case "quit": cleanup(); return;
    case "help": state.helpOpen = true; return;
    case "today": selectDate(state, todayKey()); return;
    case "goto": selectDate(state, action.date); return;
    case "view": state.view = action.view; return;
    case "new": action.draft ? createEvent(action.draft) : openNewEditor(action.kind); return;
    case "edit": editSelected(); return;
    case "delete": confirmDelete(); return;
    case "complete": completeSelected(action.completed); return;
    case "reload": client.bootstrap(); notice("Reloading canonical calendar…"); return;
    case "ssh_status": client.routeStatus(); return;
    case "ssh_connect": void client.switchSsh(action.alias); return;
    case "ssh_cancel": void client.useLocal(); return;
    case "calendar_new": {
      const reqId = client.createCalendar(action.name, action.color);
      track(reqId, `Created calendar “${action.name}”.`);
      return;
    }
    case "calendar_toggle": {
      const calendar = state.database.calendars.find(item => item.name.toLowerCase() === action.name.toLowerCase());
      if (!calendar) { notice(`Calendar not found: ${action.name}`, "error"); return; }
      const reqId = client.updateCalendar(calendar.id, { visible: !calendar.visible });
      track(reqId, `${calendar.visible ? "Hid" : "Showed"} “${calendar.name}”.`);
      return;
    }
    case "search": {
      const query = action.query.toLowerCase();
      const match = state.database.events.find(event => `${event.title} ${event.location ?? ""} ${event.notes ?? ""}`.toLowerCase().includes(query));
      if (!match) { notice(`No event matches “${action.query}”.`, "warning"); return; }
      selectDate(state, match.startDate);
      state.view = "agenda";
      const index = eventsOnSelectedDate(state).findIndex(item => item.event.id === match.id);
      state.selectedEventIndex = Math.max(0, index);
      notice(`Found “${match.title}”.`, "success");
      return;
    }
    case "error": notice(action.message, "error"); return;
  }
}

function insertText(editor: EditorState, text: string): void {
  const current = editor.fields[editor.active]!;
  const inserted = current.key === "notes" ? text.replace(/\r\n?/g, "\n") : text.replace(/[\r\n]+/g, " ");
  current.value = current.value.slice(0, editor.cursor) + inserted + current.value.slice(editor.cursor);
  editor.cursor += inserted.length;
}

function moveEditorField(editor: EditorState, amount: number): void {
  syncEditorDates(editor);
  editor.active = (editor.active + amount + editor.fields.length + 2) % (editor.fields.length + 2);
  editor.cursor = editor.fields[editor.active]?.value.length ?? 0;
}

function handleEditorKey(key: KeyEvent): void {
  const editor = state.editor!;
  if (editor.saving) return;
  if (key.type === "ctrl-s") { saveEditor(editor); return; }
  if (key.type === "tab") { moveEditorField(editor, 1); return; }
  if (key.type === "backtab") { moveEditorField(editor, -1); return; }
  if (editor.active >= editor.fields.length) {
    if (key.type === "enter") {
      if (editor.active === editor.fields.length) saveEditor(editor); else state.editor = null;
    } else if (key.type === "escape") { editor.active = 0; editor.mode = "normal"; }
    else if (key.type === "left" || key.char === "h" || key.char === "k") moveEditorField(editor, -1);
    else if (key.type === "right" || key.char === "l" || key.char === "j") moveEditorField(editor, 1);
    return;
  }
  if (key.type === "up") { moveEditorField(editor, -1); return; }
  if (key.type === "down") { moveEditorField(editor, 1); return; }
  const current = () => editor.fields[editor.active]!;
  if (current().key === "itemKind" && (key.type === "left" || key.type === "right" || key.type === "enter" || key.char === " " || (editor.mode === "normal" && (key.char === "h" || key.char === "l")))) {
    setEditorItemKind(editor, editorItemKind(editor) === "event" ? "deadline" : "event");
    return;
  }
  if (current().key === "itemKind" && (key.type === "char" || key.type === "paste" || key.type === "backspace" || key.type === "delete")) {
    if (key.char === "d") setEditorItemKind(editor, "deadline");
    else if (key.char === "e") setEditorItemKind(editor, "event");
    else if (key.char === "j" && editor.mode === "normal") moveEditorField(editor, 1);
    else if (key.char === "k" && editor.mode === "normal") moveEditorField(editor, -1);
    else if (key.char === "q" && editor.mode === "normal") state.editor = null;
    else if ((key.char === "i" || key.char === "a") && editor.mode === "normal") editor.mode = "insert";
    return;
  }
  if (editor.mode === "insert") {
    if (key.type === "escape") { editor.mode = "normal"; editor.cursor = Math.max(0, Math.min(editor.cursor, current().value.length - 1)); return; }
    if (key.type === "enter") { moveEditorField(editor, 1); return; }
    if (key.type === "char" && key.char) { insertText(editor, key.char); return; }
    if (key.type === "paste" && key.text) { insertText(editor, key.text); return; }
    if (key.type === "left") editor.cursor = previousGrapheme(current().value, editor.cursor);
    if (key.type === "right") editor.cursor = nextGrapheme(current().value, editor.cursor);
    if (key.type === "home") editor.cursor = 0;
    if (key.type === "end") editor.cursor = current().value.length;
    if (key.type === "backspace" && editor.cursor > 0) {
      const previous = previousGrapheme(current().value, editor.cursor);
      current().value = current().value.slice(0, previous) + current().value.slice(editor.cursor);
      editor.cursor = previous;
    }
    if (key.type === "delete" && editor.cursor < current().value.length) {
      current().value = current().value.slice(0, editor.cursor) + current().value.slice(nextGrapheme(current().value, editor.cursor));
    }
    return;
  }
  if (key.type === "escape" || (key.type === "char" && key.char === "q")) { state.editor = null; return; }
  if (key.type === "enter") { saveEditor(editor); return; }
  if (key.type !== "char" || !key.char) return;
  switch (key.char) {
    case "i": editor.mode = "insert"; return;
    case "a": editor.cursor = Math.min(current().value.length, editor.cursor + 1); editor.mode = "insert"; return;
    case "j": moveEditorField(editor, 1); return;
    case "k": moveEditorField(editor, -1); return;
    case "h": editor.cursor = previousGrapheme(current().value, editor.cursor); return;
    case "l": editor.cursor = nextGrapheme(current().value, editor.cursor); return;
    case "0": editor.cursor = 0; return;
    case "$": editor.cursor = current().value.length; return;
    case "x": {
      const end = nextGrapheme(current().value, editor.cursor);
      current().value = current().value.slice(0, editor.cursor) + current().value.slice(end);
      return;
    }
  }
}

function handlePromptKey(key: KeyEvent): void {
  const prompt = state.prompt!;
  const result = promptController.handle(prompt, key, state);
  if (result === "submit") {
    const text = prompt.text;
    state.prompt = null;
    focusCalendar(state);
    execute(runCommand(text, state));
  } else if (result === "close") focusCalendar(state);
}

function moveSelectedEvent(amount: number): void {
  const events = eventsOnSelectedDate(state);
  if (!events.length) return;
  state.selectedEventIndex = state.dayOpen
    ? moveTimelineSelection(daySchedule(events, state.selectedDate).rows, state.selectedEventIndex, amount)
    : (state.selectedEventIndex + amount + events.length) % events.length;
  state.detailScroll = 0;
  state.dayTimelineScroll = null;
}

function handleDayKey(key: KeyEvent): void {
  if (key.type === "ctrl-d") { state.detailScroll += 5; return; }
  if (key.type === "ctrl-u") { state.detailScroll = Math.max(0, state.detailScroll - 5); return; }
  if (key.type === "escape") { state.dayOpen = false; return; }
  if (key.type === "up") { moveSelectedEvent(-1); return; }
  if (key.type === "down") { moveSelectedEvent(1); return; }
  if (key.type === "left") { moveDate(state, -1); return; }
  if (key.type === "right") { moveDate(state, 1); return; }
  if (key.type === "enter") {
    if (selectedOccurrence(state)) editSelected();
    return;
  }
  if (key.type !== "char" || !key.char) return;
  switch (key.char) {
    case "j": case "J": moveSelectedEvent(1); return;
    case "k": case "K": moveSelectedEvent(-1); return;
    case "h": moveDate(state, -1); return;
    case "l": moveDate(state, 1); return;
    case "[": selectDate(state, addMonths(state.selectedDate, -1)); return;
    case "]": selectDate(state, addMonths(state.selectedDate, 1)); return;
    case "t": selectDate(state, todayKey()); return;
    case "n": case "a": openNewEditor(); return;
    case "e": if (selectedOccurrence(state)) editSelected(); return;
    case ";": completeSelected(); return;
    case "d": confirmDelete(); return;
    case "/": case ":": focusPrompt(state, "/"); return;
    case "i": focusPrompt(state); return;
    case "?": state.helpOpen = true; return;
    case "q": state.dayOpen = false; return;
  }
}

function handleNormalKey(key: KeyEvent): void {
  if (state.focus === "sidebar" && (key.type === "left" || key.type === "right")) {
    if (key.type === "right") focusCalendar(state);
    return;
  }
  if (state.focus === "sidebar" && (key.type === "up" || key.type === "down")) {
    state.selectedCalendarIndex = Math.max(0, Math.min(state.database.calendars.length - 1, state.selectedCalendarIndex + (key.type === "up" ? -1 : 1)));
    return;
  }
  if (key.type === "left") { moveDate(state, -1); return; }
  if (key.type === "right") { moveDate(state, 1); return; }
  if (key.type === "up") { moveDate(state, -7); return; }
  if (key.type === "down") { moveDate(state, 7); return; }
  if (key.type === "ctrl-f") { selectDate(state, addMonths(state.selectedDate, 1)); return; }
  if (key.type === "ctrl-b") { selectDate(state, addMonths(state.selectedDate, -1)); return; }
  if (key.type !== "char" && key.type !== "enter") return;
  const char = key.type === "enter" ? "enter" : key.char!;
  if (state.focus === "sidebar") {
    if (char === "j") state.selectedCalendarIndex = Math.min(state.database.calendars.length - 1, state.selectedCalendarIndex + 1);
    else if (char === "k") state.selectedCalendarIndex = Math.max(0, state.selectedCalendarIndex - 1);
    else if (char === "enter" || char === " ") {
      const calendar = selectedCalendar(state);
      if (calendar) track(client.updateCalendar(calendar.id, { visible: !calendar.visible }), `${calendar.visible ? "Hid" : "Showed"} “${calendar.name}”.`);
    } else if (char === "l") focusCalendar(state);
    else if (char === "i" || char === "a") focusPrompt(state);
    else if (char === "/" || char === ":") focusPrompt(state, "/");
    else if (char === "q") cleanup();
    return;
  }
  if (state.pendingKeys === "g") {
    state.pendingKeys = "";
    if (char === "g") { selectDate(state, todayKey()); return; }
  }
  switch (char) {
    case "g": state.pendingKeys = "g"; return;
    case "h": moveDate(state, -1); return;
    case "l": moveDate(state, 1); return;
    case "j": moveDate(state, 7); return;
    case "k": moveDate(state, -7); return;
    case "[": selectDate(state, addMonths(state.selectedDate, -1)); return;
    case "]": selectDate(state, addMonths(state.selectedDate, 1)); return;
    case "t": selectDate(state, todayKey()); return;
    case "J": moveSelectedEvent(1); return;
    case "K": moveSelectedEvent(-1); return;
    case "n": case "a": openNewEditor(); return;
    case "e": editSelected(); return;
    case ";": completeSelected(); return;
    case "enter": state.dayOpen = true; return;
    case "d": confirmDelete(); return;
    case "v": cycleView(); return;
    case "/": case ":": focusPrompt(state, "/"); return;
    case "i": focusPrompt(state); return;
    case "?": state.helpOpen = true; return;
    case "q": cleanup(); return;
  }
}

function handleKey(key: KeyEvent): void {
  if (key.type === "ctrl-shift-r") {
    const requested = client.restartDaemon();
    notice(requested ? "Restarting cald…" : "Cannot restart cald while disconnected.", requested ? "info" : "error");
    scheduleRender(true);
    return;
  }
  if (key.type === "ctrl-c") { cleanup(); return; }
  if (state.confirmDelete) {
    if (key.type === "char" && key.char?.toLowerCase() === "y") {
      const event = state.confirmDelete;
      state.confirmDelete = null;
      track(client.deleteEvent(event.id), `Deleted “${event.title}”.`);
    } else if (key.type === "escape" || (key.type === "char" && key.char?.toLowerCase() === "n")) state.confirmDelete = null;
  } else if (state.helpOpen) {
    if (key.type === "escape" || (key.type === "char" && (key.char === "?" || key.char === "q"))) state.helpOpen = false;
  } else if (state.editor) handleEditorKey(key);
  else {
    const result = handleFocusKey(state, key);
    if (result === "new") openNewEditor();
    else if (result !== "handled") {
      if (isPromptFocused(state)) handlePromptKey(key);
      else if (state.dayOpen && state.focus === "calendar") handleDayKey(key);
      else handleNormalKey(key);
    }
  }
  scheduleRender();
}

function clickPrompt(col: number): void {
  focusPrompt(state);
  const prompt = state.prompt!;
  const window = inputWindow(prompt.text, prompt.cursor, state.cols - 5);
  let position = window.start;
  while (position < prompt.text.length && width(prompt.text.slice(window.start, nextGrapheme(prompt.text, position))) <= col - 6) position = nextGrapheme(prompt.text, position);
  prompt.cursor = position;
  prompt.selectionAnchor = undefined;
  scheduleRender();
}

function handleMouse(event: MouseEvent): void {
  if (state.helpOpen) return;
  if (isPromptFocused(state) && !state.editor && !state.confirmDelete) {
    if (state.prompt.completion && (event.button === 64 || event.button === 65)) {
      cycleCompletion(state.prompt, event.button === 64 ? -1 : 1);
      scheduleRender(); return;
    }
    if (event.action === "press" && event.button === 0) {
      const prompt = state.prompt;
      const hit = state.layout.actions.find(hit => hit.row === event.row && event.col >= hit.left && event.col <= hit.right && hit.action.startsWith("complete:"));
      if (hit && prompt.completion) {
        const index = Number(hit.action.slice(9));
        prompt.completion.selection = (index + prompt.completion.items.length - 1) % prompt.completion.items.length;
        cycleCompletion(prompt, 1);
        prompt.completion = null;
        scheduleRender();
        return;
      } else if (event.row === state.rows - STATUSLINE_HEIGHT - 1) {
        clickPrompt(event.col);
        return;
      }
    }
  }
  if (state.confirmDelete) {
    if (event.action === "press" && event.button === 0) {
      const hit = state.layout.actions.find(hit => hit.row === event.row && event.col >= hit.left && event.col <= hit.right);
      if (hit?.action === "confirm-delete") handleKey({ type: "char", char: "y" });
      if (hit?.action === "cancel-delete") handleKey({ type: "escape" });
    }
    return;
  }
  if (state.editor) {
    if (state.editor.saving || event.action !== "press" || event.button !== 0) return;
    const editor = state.editor;
    const action = state.layout.actions.find(hit => hit.row === event.row && event.col >= hit.left && event.col <= hit.right);
    if (action?.action === "save") { saveEditor(editor); scheduleRender(); return; }
    if (action?.action === "cancel") { state.editor = null; scheduleRender(); return; }
    const field = state.layout.editorFields.find(hit => hit.row === event.row && event.col >= hit.left && event.col <= hit.right);
    if (field) {
      syncEditorDates(editor);
      const item = editor.fields[field.index]!;
      if (item.key === "itemKind") {
        editor.active = field.index;
        setEditorItemKind(editor, editorItemKind(editor) === "event" ? "deadline" : "event");
        scheduleRender(); return;
      }
      const oldCursor = editor.active === field.index ? editor.cursor : 0;
      const displayed = item.value.replace(/\n/g, "↵");
      const window = inputWindow(displayed, oldCursor, field.right - field.left + 1);
      let position = window.start;
      const start = window.start;
      while (position < item.value.length && width(displayed.slice(start, nextGrapheme(displayed, position))) <= event.col - field.left) position = nextGrapheme(displayed, position);
      editor.active = field.index; editor.cursor = position;
      scheduleRender();
    }
    return;
  }
  if (event.action === "press" && event.button === 0) {
    if (event.row === state.rows - STATUSLINE_HEIGHT - 1) {
      clickPrompt(event.col); return;
    }
    const calendarHit = state.layout.calendarRows.find(hit => hit.row === event.row && event.col <= state.layout.sidebarWidth);
    if (calendarHit) {
      const index = state.database.calendars.findIndex(calendar => calendar.id === calendarHit.calendarId);
      if (index !== -1) {
        state.selectedCalendarIndex = index;
        focusSidebar(state);
        if (event.col <= 3) {
          const calendar = state.database.calendars[index]!;
          track(client.updateCalendar(calendar.id, { visible: !calendar.visible }), `${calendar.visible ? "Hid" : "Showed"} “${calendar.name}”.`);
        }
      }
      scheduleRender(); return;
    }
    if (event.col < state.layout.mainLeft && event.row >= state.layout.bodyTop && event.row <= state.layout.bodyBottom) {
      focusSidebar(state); scheduleRender(); return;
    }
    if (event.col >= state.layout.mainLeft && event.row < state.rows - STATUSLINE_HEIGHT - 2) {
      focusCalendar(state); scheduleRender();
    }
    const hit = state.layout.actions.find(hit => hit.row === event.row && event.col >= hit.left && event.col <= hit.right);
    if (hit) {
      switch (hit.action) {
        case "new": openNewEditor(); break;
        case "edit": if (selectedOccurrence(state)) editSelected(); break;
        case "delete": confirmDelete(); break;
        case "complete": completeSelected(); break;
        case "back": state.dayOpen = false; break;
        case "day": state.dayOpen = true; break;
        case "today": selectDate(state, todayKey()); break;
        case "previous": case "next": {
          const direction = hit.action === "previous" ? -1 : 1;
          selectDate(state, state.dayOpen ? addDays(state.selectedDate, direction) : state.view === "month" ? addMonths(state.selectedDate, direction) : addDays(state.selectedDate, direction * 7));
          break;
        }
        case "month": case "week": case "agenda": state.dayOpen = false; state.view = hit.action; break;
      }
      scheduleRender(); return;
    }
  }
  if ((event.button === 64 || event.button === 65) && event.col < state.layout.mainLeft) {
    state.selectedCalendarIndex = Math.max(0, Math.min(state.database.calendars.length - 1, state.selectedCalendarIndex + (event.button === 64 ? -1 : 1)));
    scheduleRender(); return;
  }
  if (state.dayOpen) {
    if (event.button === 64 || event.button === 65) {
      const list = state.layout.dayList;
      if (list && event.col >= list.left && event.col <= list.right && event.row >= list.top && event.row <= list.bottom) {
        const timeline = state.layout.dayTimeline;
        if (timeline) state.dayTimelineScroll = Math.max(0, Math.min(timeline.maxScroll, timeline.scroll + (event.button === 64 ? -3 : 3)));
      }
      else state.detailScroll = Math.max(0, state.detailScroll + (event.button === 64 ? -3 : 3));
    } else if (event.action === "press" && event.button === 0) {
      const hit = state.layout.eventRows.find(hit => hit.row === event.row && event.col >= hit.left && event.col <= hit.right);
      if (hit) { state.selectedEventIndex = hit.index; state.detailScroll = 0; }
    }
    scheduleRender(); return;
  }
  if (event.button === 64) { selectDate(state, addMonths(state.selectedDate, -1)); scheduleRender(); return; }
  if (event.button === 65) { selectDate(state, addMonths(state.selectedDate, 1)); scheduleRender(); return; }
  if (event.action !== "press" || event.button !== 0) return;
  const eventHit = state.layout.eventRows.find(hit => hit.row === event.row && event.col >= hit.left && event.col <= hit.right);
  if (eventHit?.date) {
    selectDate(state, eventHit.date);
    state.selectedEventIndex = Math.max(0, eventsOnSelectedDate(state).findIndex(item => item.event.id === eventHit.eventId));
    state.dayOpen = true; scheduleRender(); return;
  }
  const cell = state.layout.monthCells.find(hit => event.row >= hit.top && event.row <= hit.bottom && event.col >= hit.left && event.col <= hit.right);
  if (cell) {
    if (cell.date === state.selectedDate) state.dayOpen = true;
    else selectDate(state, cell.date);
    focusCalendar(state); scheduleRender();
  }
}

function setupTerminal(): void {
  process.stdout.write(enterAlt + hideCursor + enablePaste + enableKittyKeyboard + enableMouse + setCursorColor(theme.cursorColor));
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  terminalReady = true;
}

function restoreTerminal(): void {
  if (!terminalReady) return;
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdout.write(disableMouse + disableKittyKeyboard + disablePaste + showCursor + resetCursorColor + leaveAlt);
  terminalReady = false;
}

let cleaned = false;
function cleanup(): void {
  if (cleaned) return;
  cleaned = true;
  running = false;
  if (renderTimer) clearTimeout(renderTimer);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (noticeTimer) clearTimeout(noticeTimer);
  clearInterval(statusTimer);
  try { savePreferences(state); } catch { /* terminal restoration is more important */ }
  client?.disconnect();
  restoreTerminal();
  process.exit(0);
}

async function main(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Whale Cal requires an interactive terminal.");
  client = new DaemonClient(onClientEvent);
  client.onDisconnect(scheduleReconnect);
  await client.connect();
  setupTerminal();
  const inputBuffer = new InputBuffer();
  process.stdin.on("data", (chunk: Buffer) => {
    const ready = inputBuffer.feed(chunk);
    if (ready === null) return;
    for (const event of parseInput(ready)) {
      if (event.type === "mouse") handleMouse(event);
      else if (event.event !== "release") handleKey(event);
    }
  });
  process.stdout.on("resize", () => {
    state.cols = process.stdout.columns || state.cols;
    state.rows = process.stdout.rows || state.rows;
    invalidateFrame();
    scheduleRender(true);
  });
  render(state);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, cleanup);
process.on("exit", () => { try { savePreferences(state); } catch {} restoreTerminal(); });

main().catch(error => {
  restoreTerminal();
  console.error(`\n  ✗ ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
