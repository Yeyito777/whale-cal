import {
  addDays, endOfWeek, formatEventTime, formatLongDate, formatMonthYear, formatShortDate,
  monthMatrix, occurrencesForRange, startOfWeek, todayKey, weekdayLabels,
} from "@whale-cal/shared/dates";
import type { Calendar, DateKey, EventOccurrence } from "@whale-cal/shared/types";
import { COMMANDS } from "./commands";
import { cursorAt, flushFrame, overlayAt } from "./frame";
import {
  eventsOnSelectedDate, selectedCalendar, selectedOccurrence, type AppState, type EditorState, type Notice,
} from "./state";
import { eventColor, theme } from "./theme";
import { cursorBar, cursorBlock } from "./terminal";
import { center, pad, truncate, width } from "./text";

function segment(content: string, target: number, bg = theme.appBg): string {
  const clipped = width(content) > target ? truncate(content, target) : content;
  const patched = clipped.replaceAll(theme.reset, `${theme.reset}${bg}`);
  return `${bg}${patched}${" ".repeat(Math.max(0, target - width(clipped)))}${theme.reset}`;
}

function putOverlayRow(rows: string[], row: number, left: number, target: number, content: string): void {
  if (row < 0 || row >= rows.length) return;
  rows[row] = overlayAt(rows[row]!, left, segment(content, target));
}

function noticeColor(kind: Notice["kind"]): string {
  return kind === "error" ? theme.error : kind === "warning" ? theme.warning : kind === "success" ? theme.success : theme.muted;
}

function calendarFor(state: AppState, id: string): Calendar | undefined {
  return state.database.calendars.find(calendar => calendar.id === id);
}

function eventLabel(state: AppState, occurrence: EventOccurrence, max: number): string {
  const event = occurrence.event;
  const calendar = calendarFor(state, event.calendarId);
  const time = event.startTime ? `${event.startTime} ` : "";
  const repeat = event.recurrence ? "↻ " : "";
  const plain = truncate(`${time}${repeat}${event.title}`, Math.max(0, max - 2));
  return `${eventColor(calendar?.color ?? "#1d9bf0")}• ${plain}${theme.reset}`;
}

function renderTopbar(state: AppState): string {
  const leftPlain = ` Whale Cal — ${formatMonthYear(state.selectedDate)}`;
  const left = ` ${theme.bold}Whale Cal${theme.boldOff} — ${formatMonthYear(state.selectedDate)}`;
  const route = state.remoteAlias ? `SSH:${state.remoteAlias}` : "local";
  const status = state.connected ? "● synced" : "○ offline";
  const rightPlain = `${status} — ${route} — ${state.view} `;
  const right = `${state.connected ? theme.success : theme.error}${status}${theme.text} — ${route} — ${state.view} `;
  const availableLeft = Math.max(0, state.cols - width(rightPlain));
  const shownLeft = width(leftPlain) > availableLeft ? ` ${theme.bold}Whale Cal${theme.boldOff}` : left;
  const spaces = Math.max(0, state.cols - width(shownLeft) - width(rightPlain));
  return `${theme.topbarBg}${theme.text}${shownLeft}${" ".repeat(spaces)}${right}${theme.reset}`;
}

function renderSidebar(state: AppState, height: number, target: number): string[] {
  const rows = Array.from({ length: height }, () => "");
  const inner = target - 1;
  const border = state.focus === "sidebar" ? theme.borderFocused : theme.borderUnfocused;
  const put = (index: number, content: string, bg = theme.sidebarBg) => {
    if (index < 0 || index >= height) return;
    rows[index] = segment(content, inner, bg) + `${theme.appBg}${border}│${theme.reset}`;
  };
  const header = state.remoteAlias ? ` Calendars — ${truncate(state.remoteAlias, 11)}` : " Calendars";
  put(0, `${theme.text}${theme.bold}${header}${theme.boldOff}`);
  put(1, `${border}${"─".repeat(inner - 1)}┤`);
  state.layout.calendarRows = [];
  let cursor = 2;
  for (let index = 0; index < state.database.calendars.length && cursor < height; index++, cursor++) {
    const calendar = state.database.calendars[index]!;
    const selected = index === state.selectedCalendarIndex;
    const icon = calendar.visible ? "●" : "○";
    const text = `${selected && state.focus === "sidebar" ? "▸" : " "} ${eventColor(calendar.color)}${icon}${theme.reset} ${truncate(calendar.name, inner - 6)}`;
    put(cursor, text, selected && state.focus === "sidebar" ? theme.sidebarSelBg : theme.sidebarBg);
    state.layout.calendarRows.push({ calendarId: calendar.id, row: cursor + state.layout.bodyTop });
  }
  if (cursor < height) put(cursor++, `${theme.muted} ${state.database.events.length} event${state.database.events.length === 1 ? "" : "s"}`);
  if (cursor < height) put(cursor++, `${theme.muted}${"─".repeat(Math.max(0, inner - 2))}`);
  if (cursor < height) put(cursor++, `${theme.bold} ${truncate(formatShortDate(state.selectedDate), inner - 2)}${theme.boldOff}`);

  const selected = eventsOnSelectedDate(state);
  if (selected.length === 0 && cursor < height) put(cursor++, `${theme.muted}  No events`);
  for (let index = 0; index < selected.length && cursor < height; index++, cursor++) {
    const pointer = index === state.selectedEventIndex ? "▸" : " ";
    const occurrence = selected[index]!;
    put(cursor, `${pointer} ${eventLabel(state, occurrence, inner - 2)}`, index === state.selectedEventIndex ? theme.sidebarSelBg : theme.sidebarBg);
  }
  const active = selectedOccurrence(state);
  if (active && cursor + 1 < height) {
    put(cursor++, `${theme.muted}${"─".repeat(Math.max(0, inner - 2))}`);
    put(cursor++, `${theme.command} ${truncate(formatEventTime(active.event), inner - 2)}`);
    if (active.event.location && cursor < height) put(cursor++, `${theme.muted} @ ${truncate(active.event.location, inner - 4)}`);
    if (active.event.recurrence && cursor < height) put(cursor++, `${theme.goal} ↻ ${active.event.recurrence.frequency}`);
    if (active.event.notes && cursor < height) put(cursor++, `${theme.muted} ${truncate(active.event.notes.replace(/\s+/g, " "), inner - 2)}`);
  }
  while (cursor < height) put(cursor++, "");
  return rows;
}

function columnWidths(total: number): number[] {
  const content = Math.max(7, total - 6);
  const base = Math.floor(content / 7), extra = content % 7;
  return Array.from({ length: 7 }, (_, index) => base + (index < extra ? 1 : 0));
}

function selectedCellContent(content: string, target: number, selected: boolean): string {
  return segment(content, target, selected ? theme.sidebarSelBg : theme.appBg);
}

function renderMonth(state: AppState, widthValue: number, height: number, absoluteLeft: number): string[] {
  const rows = Array.from({ length: height }, () => segment("", widthValue));
  if (height <= 0 || widthValue <= 0) return rows;
  rows[0] = segment(`${theme.bold} ${formatMonthYear(state.selectedDate)}${theme.boldOff}  ${theme.muted}${formatLongDate(state.selectedDate)}`, widthValue);
  if (height === 1) return rows;
  const widths = columnWidths(widthValue);
  rows[1] = weekdayLabels(1).map((label, index) => segment(`${theme.muted}${center(label, widths[index]!)}`, widths[index]!)).join(`${theme.appBg}${theme.borderUnfocused}│${theme.reset}`);
  const matrix = monthMatrix(state.selectedDate, 1);
  const selectedMonth = state.selectedDate.slice(0, 7);
  const today = todayKey();
  const bodyHeight = Math.max(0, height - 2);
  const baseHeight = Math.floor(bodyHeight / 6), remainder = bodyHeight % 6;
  state.layout.monthCells = [];
  let outputRow = 2;
  for (let week = 0; week < 6; week++) {
    const weekHeight = baseHeight + (week < remainder ? 1 : 0);
    const dates = matrix[week]!;
    for (let line = 0; line < weekHeight; line++, outputRow++) {
      let left = absoluteLeft;
      const cells: string[] = [];
      for (let day = 0; day < 7; day++) {
        const key = dates[day]!, cellWidth = widths[day]!;
        const isSelected = key === state.selectedDate;
        if (line === 0) {
          let dateText = String(Number(key.slice(8)));
          if (key === today) dateText = `${theme.accent}${theme.bold}${dateText}${theme.boldOff}`;
          else if (!key.startsWith(selectedMonth)) dateText = `${theme.muted}${dateText}`;
          cells.push(selectedCellContent(` ${dateText}`, cellWidth, isSelected));
          state.layout.monthCells.push({
            date: key, left, right: left + cellWidth - 1,
            top: state.layout.bodyTop + outputRow, bottom: state.layout.bodyTop + outputRow + Math.max(0, weekHeight - 1),
          });
        } else {
          const occurrences = occurrencesForRange(
            state.database.events.filter(event => state.database.calendars.find(calendar => calendar.id === event.calendarId)?.visible), key, key,
          );
          const occurrence = occurrences[line - 1];
          const more = line === weekHeight - 1 && occurrences.length > line;
          const content = more
            ? `${theme.muted} +${occurrences.length - line + 1} more`
            : occurrence ? ` ${eventLabel(state, occurrence, cellWidth - 1)}` : "";
          cells.push(selectedCellContent(content, cellWidth, isSelected));
        }
        left += cellWidth + 1;
      }
      if (outputRow < rows.length) rows[outputRow] = cells.join(`${theme.appBg}${theme.borderUnfocused}│${theme.reset}`);
    }
  }
  return rows;
}

function renderWeek(state: AppState, widthValue: number, height: number, absoluteLeft: number): string[] {
  const rows = Array.from({ length: height }, () => segment("", widthValue));
  const first = startOfWeek(state.selectedDate, 1), last = endOfWeek(state.selectedDate, 1);
  rows[0] = segment(`${theme.bold} Week${theme.boldOff}  ${formatShortDate(first)} — ${formatShortDate(last)}`, widthValue);
  if (height < 2) return rows;
  const widths = columnWidths(widthValue), today = todayKey();
  const dates = Array.from({ length: 7 }, (_, i) => addDays(first, i));
  rows[1] = dates.map((key, i) => {
    const title = `${weekdayLabels(1)[i]} ${Number(key.slice(8))}`;
    const styled = key === today ? `${theme.accent}${theme.bold}${title}` : title;
    return selectedCellContent(center(styled, widths[i]!), widths[i]!, key === state.selectedDate);
  }).join(`${theme.appBg}${theme.borderUnfocused}│${theme.reset}`);
  state.layout.monthCells = [];
  let left = absoluteLeft;
  for (let i = 0; i < 7; i++) {
    state.layout.monthCells.push({ date: dates[i]!, left, right: left + widths[i]! - 1, top: state.layout.bodyTop + 1, bottom: state.layout.bodyTop + height - 1 });
    left += widths[i]! + 1;
  }
  const perDay = dates.map(key => occurrencesForRange(
    state.database.events.filter(event => calendarFor(state, event.calendarId)?.visible), key, key,
  ));
  for (let row = 2; row < height; row++) {
    rows[row] = dates.map((key, i) => {
      const occurrence = perDay[i]![row - 2];
      const content = occurrence ? ` ${eventLabel(state, occurrence, widths[i]! - 1)}` : "";
      return selectedCellContent(content, widths[i]!, key === state.selectedDate);
    }).join(`${theme.appBg}${theme.borderUnfocused}│${theme.reset}`);
  }
  return rows;
}

function renderAgenda(state: AppState, widthValue: number, height: number): string[] {
  const rows = Array.from({ length: height }, () => segment("", widthValue));
  rows[0] = segment(`${theme.bold} Agenda${theme.boldOff}  ${theme.muted}from ${formatLongDate(state.selectedDate)}`, widthValue);
  const end = addDays(state.selectedDate, Math.max(30, height));
  const occurrences = occurrencesForRange(
    state.database.events.filter(event => calendarFor(state, event.calendarId)?.visible), state.selectedDate, end,
  );
  let row = 1, currentDate = "";
  for (const occurrence of occurrences) {
    if (row >= height) break;
    if (occurrence.startDate !== currentDate) {
      currentDate = occurrence.startDate;
      rows[row++] = segment(`${currentDate === state.selectedDate ? theme.accent : theme.text}${theme.bold} ${formatLongDate(currentDate)}${theme.boldOff}`, widthValue);
      if (row >= height) break;
    }
    const isSelected = occurrence.startDate <= state.selectedDate && occurrence.endDate >= state.selectedDate
      && eventsOnSelectedDate(state)[state.selectedEventIndex]?.id === occurrence.id;
    const time = formatEventTime(occurrence.event).padEnd(13);
    const calendar = calendarFor(state, occurrence.event.calendarId);
    rows[row++] = segment(`${isSelected ? " ▸" : "  "} ${theme.muted}${time} ${eventColor(calendar?.color ?? "#1d9bf0")}● ${theme.text}${occurrence.event.title}`, widthValue, isSelected ? theme.sidebarSelBg : theme.appBg);
    if (occurrence.event.location && row < height) rows[row++] = segment(`${theme.muted}                  @ ${occurrence.event.location}`, widthValue);
  }
  if (occurrences.length === 0 && height > 2) rows[2] = segment(`${theme.muted} No upcoming events. Press n to create one.`, widthValue);
  return rows;
}

function renderEditorOverlay(state: AppState, rows: string[], editor: EditorState): { row: number; col: number } | null {
  const boxWidth = Math.max(44, Math.min(76, state.cols - 4));
  const valueWidth = boxWidth - 17;
  const boxHeight = editor.fields.length + 3;
  const top = Math.max(2, Math.floor((state.rows - boxHeight) / 2) + 1);
  const left = Math.max(1, Math.floor((state.cols - boxWidth) / 2) + 1);
  const put = (row: number, content: string) => putOverlayRow(rows, row, left, boxWidth, content);
  const title = editor.kind === "create" ? " New event " : " Edit event ";
  put(top - 1, `${theme.borderFocused}┌${center(`${theme.bold}${title}${theme.boldOff}`, boxWidth - 2)}┐`);
  let cursor: { row: number; col: number } | null = null;
  for (let index = 0; index < editor.fields.length; index++) {
    const item = editor.fields[index]!;
    const active = index === editor.active;
    const prefix = `│ ${pad(item.label, 10)} │ `;
    const value = truncate(item.value.replace(/\n/g, "↵"), valueWidth);
    const body = `${prefix}${pad(value, valueWidth)} │`;
    put(top + index, `${active ? theme.sidebarSelBg + theme.text : theme.appBg + theme.muted}${body}${theme.reset}${theme.borderFocused}`);
    if (active) cursor = { row: top + 1 + index, col: left + width(prefix) + Math.min(editor.cursor, valueWidth - 1) };
  }
  put(top + editor.fields.length, `${theme.borderFocused}├${"─".repeat(boxWidth - 2)}┤`);
  const mode = editor.mode === "insert" ? "-- INSERT --" : "-- NORMAL --";
  put(top + 1 + editor.fields.length, `${theme.borderFocused}└${center(`${editor.mode === "insert" ? theme.vimInsert : theme.vimNormal}${mode}`, boxWidth - 2)}${theme.borderFocused}┘`);
  return cursor;
}

function renderHelpOverlay(state: AppState, rows: string[]): void {
  const content = [
    ["h j k l", "move by day / week"], ["[  ]", "previous / next month"], ["t or gg", "today"],
    ["n / a", "new event"], ["e / Enter", "edit selected event"], ["d", "delete selected event"],
    ["J / K", "next / previous event"], ["v", "cycle view"], ["/", "open command prompt"],
    ["Ctrl+J/K", "cycle panel focus"], ["Ctrl+S", "toggle sidebar"], ["Ctrl+Shift+R", "restart cald"],
    ["q / Ctrl+C", "quit"],
  ];
  const boxWidth = Math.max(48, Math.min(68, state.cols - 4));
  const height = content.length + 6;
  const top = Math.max(2, Math.floor((state.rows - height) / 2) + 1);
  const left = Math.max(1, Math.floor((state.cols - boxWidth) / 2) + 1);
  const put = (row: number, content: string) => putOverlayRow(rows, row, left, boxWidth, content);
  put(top - 1, `${theme.borderFocused}┌${center(`${theme.bold} Whale Cal help `, boxWidth - 2)}┐`);
  put(top, `${theme.borderFocused}│${theme.muted}${center("Vim-first local calendar", boxWidth - 2)}${theme.borderFocused}│`);
  let row = top + 1;
  for (const [key, action] of content) put(row++, `${theme.borderFocused}│ ${theme.command}${pad(key!, 14)} ${theme.text}${pad(action!, boxWidth - 19)} ${theme.borderFocused}│`);
  put(row++, `${theme.borderFocused}├${"─".repeat(boxWidth - 2)}┤`);
  put(row++, `${theme.borderFocused}│${theme.muted}${center("Slash commands", boxWidth - 2)}${theme.borderFocused}│`);
  const commandText = COMMANDS.map(([name]) => name).join("  ");
  put(row++, `${theme.borderFocused}│ ${theme.command}${pad(truncate(commandText, boxWidth - 4), boxWidth - 4)} ${theme.borderFocused}│`);
  put(row, `${theme.borderFocused}└${center(`${theme.muted}Esc or ? to close`, boxWidth - 2)}${theme.borderFocused}┘`);
}

function renderDeleteOverlay(state: AppState, rows: string[]): void {
  const event = state.confirmDelete;
  if (!event) return;
  const boxWidth = Math.max(42, Math.min(68, state.cols - 4)), top = Math.floor(state.rows / 2) - 2;
  const left = Math.floor((state.cols - boxWidth) / 2) + 1;
  const put = (row: number, content: string) => putOverlayRow(rows, row, left, boxWidth, content);
  put(top, `${theme.error}┌${center(" Delete event? ", boxWidth - 2)}┐`);
  put(top + 1, `${theme.error}│${theme.text}${center(truncate(event.title, boxWidth - 6), boxWidth - 2)}${theme.error}│`);
  put(top + 2, `${theme.error}│${theme.muted}${center(event.recurrence ? "This deletes the entire recurring series." : formatLongDate(event.startDate), boxWidth - 2)}${theme.error}│`);
  put(top + 3, `${theme.error}│${center(`${theme.warning}y${theme.text} delete    ${theme.command}n${theme.text} cancel`, boxWidth - 2)}${theme.error}│`);
  put(top + 4, `${theme.error}└${"─".repeat(boxWidth - 2)}┘`);
}

function renderPromptSeparator(state: AppState, borderColor: string): string {
  if (!state.notice || state.cols < 4) return segment(`${borderColor}${"─".repeat(state.cols)}`, state.cols);
  const text = truncate(state.notice.text, state.cols - 3);
  const trailing = "─".repeat(Math.max(0, state.cols - width(text) - 3));
  return segment(`${borderColor}─ ${noticeColor(state.notice.kind)}${text} ${borderColor}${trailing}`, state.cols);
}

function promptRendering(state: AppState): { line: string; cursor: { row: number; col: number } | null } {
  const row = state.rows;
  if (!state.prompt) {
    const pending = state.pendingKeys ? ` ${theme.warning}${state.pendingKeys}` : "";
    return { line: segment(`${theme.vimNormal} N ${theme.text}❯${pending}`, state.cols), cursor: null };
  }
  const modeLabel = state.prompt.mode === "insert" ? "I" : "N";
  const modeColor = state.prompt.mode === "insert" ? theme.vimInsert : theme.vimNormal;
  const prefix = ` ${modeLabel} ❯ `, max = Math.max(1, state.cols - width(prefix));
  const start = Math.max(0, state.prompt.cursor - max + 2);
  const shown = state.prompt.text.slice(start, start + max);
  return {
    line: segment(`${modeColor} ${modeLabel} ${theme.text}❯ ${theme.command}${shown}`, state.cols),
    cursor: { row, col: width(prefix) + state.prompt.cursor - start + 1 },
  };
}

export function render(state: AppState): void {
  state.cols = process.stdout.columns || state.cols || 80;
  state.rows = process.stdout.rows || state.rows || 24;
  const rows = Array.from({ length: state.rows }, () => segment("", state.cols));
  rows[0] = renderTopbar(state);
  const footerTop = Math.max(3, state.rows - 1);
  const bodyTop = 2;
  const bodyHeight = Math.max(0, footerTop - bodyTop);
  const sidebarWidth = state.sidebarOpen && state.cols >= 76 ? Math.min(31, Math.floor(state.cols * 0.32)) : 0;
  const mainWidth = state.cols - sidebarWidth;
  state.layout = { sidebarWidth, calendarRows: [], monthCells: [], mainLeft: sidebarWidth + 1, bodyTop, bodyBottom: footerTop - 1 };
  const sidebar = sidebarWidth ? renderSidebar(state, bodyHeight, sidebarWidth) : [];
  const main = state.view === "month" ? renderMonth(state, mainWidth, bodyHeight, sidebarWidth + 1)
    : state.view === "week" ? renderWeek(state, mainWidth, bodyHeight, sidebarWidth + 1)
      : renderAgenda(state, mainWidth, bodyHeight);
  for (let index = 0; index < bodyHeight; index++) rows[bodyTop - 1 + index] = (sidebar[index] ?? "") + (main[index] ?? segment("", mainWidth));

  const prompt = promptRendering(state);
  const borderColor = state.focus === "calendar" ? theme.borderFocused : theme.borderUnfocused;
  rows[state.rows - 2] = renderPromptSeparator(state, borderColor);
  rows[state.rows - 1] = prompt.line;

  let overlayCursor: { row: number; col: number } | null = null;
  if (state.helpOpen) renderHelpOverlay(state, rows);
  if (state.confirmDelete) renderDeleteOverlay(state, rows);
  if (state.editor) overlayCursor = renderEditorOverlay(state, rows, state.editor);
  const cursor = overlayCursor
    ? cursorAt(overlayCursor.row, overlayCursor.col, state.editor?.mode === "insert" ? cursorBar : cursorBlock)
    : prompt.cursor ? cursorAt(prompt.cursor.row, prompt.cursor.col, state.prompt?.mode === "normal" ? cursorBlock : cursorBar)
      : cursorAt(1, 1, cursorBlock, false);
  flushFrame({ rows, cursor });
}
