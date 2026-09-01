import { addDays, addMonths, occurrencesForRange, todayKey } from "@whale-cal/shared/dates";
import type { CalendarEvent, CalendarView, EventDraft, EventPatch } from "@whale-cal/shared/types";
import { DaemonClient, type ClientEvent } from "./client";
import { completeCommand, runCommand, type CommandAction } from "./commands";
import { invalidateFrame } from "./frame";
import { InputBuffer, parseInput, type KeyEvent, type MouseEvent } from "./input";
import { loadPreferences, savePreferences } from "./preferences";
import { render } from "./render";
import {
  createEditor, createState, cyclePanelFocus, editorDraft, eventsOnSelectedDate, exitPromptAndCycleFocus,
  moveDate, selectDate, selectedCalendar, selectedOccurrence, setNotice, type AppState, type EditorState,
} from "./state";
import {
  cursorBar, disableKittyKeyboard, disableMouse, disablePaste, enableKittyKeyboard, enableMouse, enablePaste,
  enterAlt, hideCursor, leaveAlt, resetCursorColor, setCursorColor, showCursor,
} from "./terminal";
import { theme } from "./theme";
import { nextGrapheme, previousGrapheme } from "./text";

const state = createState();
loadPreferences(state);
let client: DaemonClient;
let running = true;
let terminalReady = false;
let renderTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let noticeTimer: ReturnType<typeof setTimeout> | null = null;
const pending = new Map<string, string>();
const commandHistory: string[] = [];
let commandHistoryIndex = 0;

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
    if (event.state === "connected") state.remoteAlias = event.mode === "remote" ? event.alias ?? null : null;
    notice(event.message, event.state === "failed" ? "error" : event.state === "switching" ? "warning" : "success");
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
      if (!applyRevision(event.revision)) return;
      state.database.events.push(event.event);
      settle(event.reqId);
      scheduleRender();
      return;
    case "event_updated": {
      if (!applyRevision(event.revision)) return;
      const index = state.database.events.findIndex(item => item.id === event.event.id);
      if (index === -1) state.database.events.push(event.event); else state.database.events[index] = event.event;
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

function openNewEditor(): void {
  if (state.database.calendars.length === 0) { notice("No calendar is available.", "error"); return; }
  state.editor = createEditor(state);
  state.prompt = null;
}

function editSelected(): void {
  const occurrence = selectedOccurrence(state);
  if (!occurrence) { openNewEditor(); return; }
  state.editor = createEditor(state, occurrence.event);
  state.prompt = null;
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
  try {
    const draft = editorDraft(state, editor);
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
      track(reqId, `Updated “${draft.title}”.`);
    } else createEvent(draft);
    selectDate(state, draft.startDate);
    state.editor = null;
  } catch (error) { notice(error instanceof Error ? error.message : String(error), "error"); }
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
    case "new": action.draft ? createEvent(action.draft) : openNewEditor(); return;
    case "edit": editSelected(); return;
    case "delete": confirmDelete(); return;
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
  current.value = current.value.slice(0, editor.cursor) + text.replace(/[\r\n]+/g, " ") + current.value.slice(editor.cursor);
  editor.cursor += text.replace(/[\r\n]+/g, " ").length;
}

function moveEditorField(editor: EditorState, amount: number): void {
  editor.active = (editor.active + amount + editor.fields.length) % editor.fields.length;
  editor.cursor = editor.fields[editor.active]!.value.length;
}

function handleEditorKey(key: KeyEvent): void {
  const editor = state.editor!;
  if (key.type === "ctrl-s") { saveEditor(editor); return; }
  if (key.type === "tab") { moveEditorField(editor, 1); return; }
  if (key.type === "backtab") { moveEditorField(editor, -1); return; }
  const current = () => editor.fields[editor.active]!;
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
  if (prompt.mode === "normal" && (key.type === "ctrl-j" || key.type === "ctrl-k")) {
    exitPromptAndCycleFocus(state);
    return;
  }
  if (key.type === "enter") {
    const text = prompt.text;
    state.prompt = null;
    if (text.trim()) { commandHistory.push(text); commandHistoryIndex = commandHistory.length; }
    execute(runCommand(text, state));
    return;
  }
  if (key.type === "tab") {
    const completed = completeCommand(prompt.text, state);
    if (completed) { prompt.text = completed; prompt.cursor = completed.length; }
    return;
  }
  if (key.type === "up" && commandHistory.length) {
    commandHistoryIndex = Math.max(0, commandHistoryIndex - 1);
    prompt.text = commandHistory[commandHistoryIndex] ?? ""; prompt.cursor = prompt.text.length; return;
  }
  if (key.type === "down" && commandHistory.length) {
    commandHistoryIndex = Math.min(commandHistory.length, commandHistoryIndex + 1);
    prompt.text = commandHistory[commandHistoryIndex] ?? ""; prompt.cursor = prompt.text.length; return;
  }
  if (prompt.mode === "normal") {
    if (key.type === "escape") { state.prompt = null; return; }
    if (key.type === "left") prompt.cursor = previousGrapheme(prompt.text, prompt.cursor);
    else if (key.type === "right") prompt.cursor = nextGrapheme(prompt.text, prompt.cursor);
    else if (key.type === "home") prompt.cursor = 0;
    else if (key.type === "end") prompt.cursor = prompt.text.length;
    else if (key.type === "char" && key.char) {
      const isWord = (char: string) => /[A-Za-z0-9_]/.test(char);
      const wordForward = () => {
        let cursor = prompt.cursor;
        while (cursor < prompt.text.length && isWord(prompt.text[cursor]!)) cursor++;
        while (cursor < prompt.text.length && !isWord(prompt.text[cursor]!)) cursor++;
        return cursor;
      };
      const wordBackward = () => {
        let cursor = Math.max(0, prompt.cursor - 1);
        while (cursor > 0 && !isWord(prompt.text[cursor]!)) cursor--;
        while (cursor > 0 && isWord(prompt.text[cursor - 1]!)) cursor--;
        return cursor;
      };
      switch (key.char) {
        case "i": prompt.mode = "insert"; return;
        case "a": prompt.cursor = nextGrapheme(prompt.text, prompt.cursor); prompt.mode = "insert"; return;
        case "I": prompt.cursor = 0; prompt.mode = "insert"; return;
        case "A": prompt.cursor = prompt.text.length; prompt.mode = "insert"; return;
        case "h": prompt.cursor = previousGrapheme(prompt.text, prompt.cursor); return;
        case "l": prompt.cursor = nextGrapheme(prompt.text, prompt.cursor); return;
        case "0": prompt.cursor = 0; return;
        case "$": prompt.cursor = prompt.text.length; return;
        case "w": prompt.cursor = wordForward(); return;
        case "b": prompt.cursor = wordBackward(); return;
        case "x": {
          const end = nextGrapheme(prompt.text, prompt.cursor);
          prompt.text = prompt.text.slice(0, prompt.cursor) + prompt.text.slice(end);
          return;
        }
        case "X": {
          const previous = previousGrapheme(prompt.text, prompt.cursor);
          prompt.text = prompt.text.slice(0, previous) + prompt.text.slice(prompt.cursor);
          prompt.cursor = previous;
          return;
        }
        case "D": prompt.text = prompt.text.slice(0, prompt.cursor); return;
        case "C": prompt.text = prompt.text.slice(0, prompt.cursor); prompt.mode = "insert"; return;
      }
    }
    return;
  }
  if (key.type === "escape") {
    prompt.mode = "normal";
    prompt.cursor = previousGrapheme(prompt.text, prompt.cursor);
    return;
  }
  if (key.type === "char" && key.char) {
    prompt.text = prompt.text.slice(0, prompt.cursor) + key.char + prompt.text.slice(prompt.cursor);
    prompt.cursor += key.char.length;
  } else if (key.type === "paste" && key.text) {
    const text = key.text.replace(/[\r\n]+/g, " ");
    prompt.text = prompt.text.slice(0, prompt.cursor) + text + prompt.text.slice(prompt.cursor);
    prompt.cursor += text.length;
  } else if (key.type === "left") prompt.cursor = previousGrapheme(prompt.text, prompt.cursor);
  else if (key.type === "right") prompt.cursor = nextGrapheme(prompt.text, prompt.cursor);
  else if (key.type === "home") prompt.cursor = 0;
  else if (key.type === "end") prompt.cursor = prompt.text.length;
  else if (key.type === "ctrl-u") { prompt.text = prompt.text.slice(prompt.cursor); prompt.cursor = 0; }
  else if (key.type === "backspace" && prompt.cursor > 0) {
    const previous = previousGrapheme(prompt.text, prompt.cursor);
    prompt.text = prompt.text.slice(0, previous) + prompt.text.slice(prompt.cursor); prompt.cursor = previous;
  } else if (key.type === "delete" && prompt.cursor < prompt.text.length) {
    prompt.text = prompt.text.slice(0, prompt.cursor) + prompt.text.slice(nextGrapheme(prompt.text, prompt.cursor));
  }
}

function moveSelectedEvent(amount: number): void {
  const events = eventsOnSelectedDate(state);
  if (!events.length) return;
  state.selectedEventIndex = (state.selectedEventIndex + amount + events.length) % events.length;
}

function handleNormalKey(key: KeyEvent): void {
  if (key.type === "ctrl-s") { state.sidebarOpen = !state.sidebarOpen; if (!state.sidebarOpen) state.focus = "calendar"; return; }
  if (key.type === "ctrl-j" || key.type === "ctrl-k") {
    cyclePanelFocus(state);
    return;
  }
  if (key.type === "ctrl-n" || key.type === "ctrl-f") { selectDate(state, addMonths(state.selectedDate, 1)); return; }
  if (key.type === "ctrl-p" || key.type === "ctrl-b") { selectDate(state, addMonths(state.selectedDate, -1)); return; }
  if (key.type !== "char" && key.type !== "enter") return;
  const char = key.type === "enter" ? "enter" : key.char!;
  if (state.focus === "sidebar") {
    if (char === "j") state.selectedCalendarIndex = Math.min(state.database.calendars.length - 1, state.selectedCalendarIndex + 1);
    else if (char === "k") state.selectedCalendarIndex = Math.max(0, state.selectedCalendarIndex - 1);
    else if (char === "enter" || char === " ") {
      const calendar = selectedCalendar(state);
      if (calendar) track(client.updateCalendar(calendar.id, { visible: !calendar.visible }), `${calendar.visible ? "Hid" : "Showed"} “${calendar.name}”.`);
    } else if (char === "l" || char === "i" || char === "a") state.focus = "calendar";
    else if (char === "/") state.prompt = { text: "/", cursor: 1, mode: "insert" };
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
    case "e": case "enter": editSelected(); return;
    case "d": confirmDelete(); return;
    case "v": cycleView(); return;
    case "/": case ":": state.prompt = { text: "/", cursor: 1, mode: "insert" }; return;
    case "i": state.prompt = { text: "", cursor: 0, mode: "insert" }; return;
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
  else if (state.prompt) handlePromptKey(key);
  else handleNormalKey(key);
  scheduleRender();
}

function handleMouse(event: MouseEvent): void {
  if (state.editor || state.prompt || state.helpOpen || state.confirmDelete) return;
  if (event.button === 64) { selectDate(state, addMonths(state.selectedDate, -1)); scheduleRender(); return; }
  if (event.button === 65) { selectDate(state, addMonths(state.selectedDate, 1)); scheduleRender(); return; }
  if (event.action !== "press" || event.button !== 0) return;
  const calendarHit = state.layout.calendarRows.find(hit => hit.row === event.row && event.col <= state.layout.sidebarWidth);
  if (calendarHit) {
    const index = state.database.calendars.findIndex(calendar => calendar.id === calendarHit.calendarId);
    if (index !== -1) { state.selectedCalendarIndex = index; state.focus = "sidebar"; }
    scheduleRender(); return;
  }
  const cell = state.layout.monthCells.find(hit => event.row >= hit.top && event.row <= hit.bottom && event.col >= hit.left && event.col <= hit.right);
  if (cell) { selectDate(state, cell.date); state.focus = "calendar"; scheduleRender(); }
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
