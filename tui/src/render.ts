import {
  addDays, endOfWeek, deadlineIsOverdue, eventIsCompleted, formatItemTime, formatLongDate, formatMonthYear, formatShortDate,
  monthMatrix, occurrencesForRange, startOfWeek, todayKey, weekdayLabels,
} from "@whale-cal/shared/dates";
import type { Calendar, DateKey, EventOccurrence } from "@whale-cal/shared/types";
import { COMMANDS } from "./commands";
import { isPromptFocused } from "./focus";
import { stylePromptText } from "./prompt-style";
import { daySchedule, durationLabel, scheduleNow, scheduleWindow } from "./day-schedule";
import { refreshCompletion } from "./completion";
import { completionMenu } from "./completion-menu";
import { renderStatusline, STATUSLINE_HEIGHT } from "./statusline";
import { cursorAt, flushFrame, overlayAt } from "./frame";
import {
  editorItemKind, eventsOnSelectedDate, selectedCalendar, selectedOccurrence, type AppState, type EditorState, type Notice, visibleEvents,
} from "./state";
import { eventColor, theme } from "./theme";
import { cursorBar, cursorBlock } from "./terminal";
import { center, inputWindow, pad, truncate, width, wrapText } from "./text";

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
  const time = event.kind === "deadline" ? event.startTime ? `Due ${event.startTime} ` : "Due " : event.startTime ? `${event.startTime} ` : "";
  const repeat = event.recurrence ? "↻ " : "";
  const plain = truncate(`${time}${repeat}${event.title}`, Math.max(0, max - 2));
  if (eventIsCompleted(event, occurrence.startDate)) return `${theme.muted}✓ ${theme.strike}${plain}${theme.strikeOff}${theme.reset}`;
  const color = deadlineIsOverdue(event, occurrence.startDate) ? theme.warning : eventColor(calendar?.color ?? "#1d9bf0");
  return `${color}${event.kind === "deadline" ? "◆" : "•"} ${plain}${theme.reset}`;
}

function renderTopbar(state: AppState): string {
  const route = state.remoteAlias ? `SSH:${state.remoteAlias}` : "local";
  const status = state.connected ? "● synced" : "○ offline";
  const title = ` ${theme.accent}${theme.bold}Whale Cal${theme.boldOff}${theme.muted} · ${formatMonthYear(state.selectedDate)}`;
  const right = truncate(`${status} · ${route}`, Math.max(0, state.cols - width(title) - 3));
  return segment(`${title}${" ".repeat(Math.max(1, state.cols - width(title) - width(right) - 1))}${theme.muted}${right} `, state.cols, theme.sidebarBg);
}

function renderToolbar(state: AppState): string {
  let line = " ";
  const action = (label: string, key: string, active = false) => {
    const text = ` ${label} `;
    const left = width(line) + 1;
    if (left + width(text) > state.cols) return;
    line += `${active ? theme.sidebarSelBg + theme.text : theme.appBg + theme.muted}${text}${theme.reset} `;
    state.layout.actions.push({ action: key, left, right: left + width(text) - 1, row: 2 });
  };
  action("‹", "previous"); action("Today", "today"); action("›", "next");
  for (const view of ["month", "week", "agenda"]) action(view[0]!.toUpperCase() + view.slice(1), view, !state.dayOpen && state.view === view);
  if (state.dayOpen && state.cols >= 80) action("Day", "day", true);
  action("+ Event", "new");
  if (state.dayOpen) {
    const selected = selectedOccurrence(state);
    if (selected) action(eventIsCompleted(selected.event, selected.startDate) ? "Reopen" : "Done", "complete");
    action("Edit", "edit"); action("Delete", "delete"); action("Back", "back");
  }
  return segment(line, state.cols);
}

function renderSidebar(state: AppState, height: number, target: number): string[] {
  const inner = target - 1;
  const border = state.focus === "sidebar" ? theme.borderFocused : theme.borderUnfocused;
  const rows = Array.from({ length: height }, () => segment("", inner, theme.sidebarBg) + `${theme.appBg}${border}│${theme.reset}`);
  const put = (row: number, content: string, active = false) => {
    if (row < height) rows[row] = segment(content, inner, active ? theme.sidebarSelBg : theme.sidebarBg) + `${theme.appBg}${border}│${theme.reset}`;
  };
  put(0, `${theme.text}${theme.bold} Calendars${theme.boldOff}`);
  put(1, `${theme.muted} ${state.database.calendars.filter(calendar => calendar.visible).length} visible`);
  const capacity = Math.max(1, height - 3);
  const start = Math.max(0, Math.min(state.selectedCalendarIndex - Math.floor(capacity / 2), state.database.calendars.length - capacity));
  for (let i = start; i < Math.min(state.database.calendars.length, start + capacity); i++) {
    const calendar = state.database.calendars[i]!;
    const selected = i === state.selectedCalendarIndex && state.focus === "sidebar";
    put(3 + i - start, `${selected ? theme.accent + "▸" : " "} ${calendar.visible ? eventColor(calendar.color) + "●" : theme.muted + "○"} ${calendar.visible ? theme.text : theme.muted}${truncate(calendar.name, inner - 5)}`, selected);
    if (3 + i - start < height) state.layout.calendarRows.push({ calendarId: calendar.id, row: state.layout.bodyTop + 3 + i - start });
  }
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

/** Today is a solid accent badge, independent of the selected-day background. */
function todayHeader(label: string, target: number): string {
  return segment(`${theme.text}${theme.bold}${center(label, target)}${theme.boldOff}`, target, theme.topbarBg);
}

function renderMonth(state: AppState, widthValue: number, height: number, absoluteLeft: number): string[] {
  const rows = Array.from({ length: height }, () => segment("", widthValue));
  if (height < 2) return rows;
  const widths = columnWidths(widthValue);
  const join = `${theme.appBg}${theme.borderUnfocused}│${theme.reset}`;
  rows[0] = weekdayLabels(1).map((label, i) => segment(`${theme.muted}${center(label, widths[i]!)}`, widths[i]!)).join(join);
  const matrix = monthMatrix(state.selectedDate, 1).filter(week => week.some(day => day.slice(0, 7) === state.selectedDate.slice(0, 7)));
  const available = height - 1;
  const separators = available >= matrix.length * 2;
  const cellHeight = available - (separators ? matrix.length - 1 : 0);
  const occurrences = occurrencesForRange(visibleEvents(state), matrix[0]![0]!, matrix.at(-1)![6]!);
  const today = todayKey();
  let row = 1;
  for (let week = 0; week < matrix.length; week++) {
    const weekHeight = Math.floor(cellHeight / matrix.length) + (week < cellHeight % matrix.length ? 1 : 0);
    const dates = matrix[week]!;
    const perDay = dates.map(date => occurrences.filter(event => event.startDate <= date && event.endDate >= date));
    let left = absoluteLeft;
    for (let day = 0; day < 7; day++) {
      if (weekHeight) state.layout.monthCells.push({ date: dates[day]!, left, right: left + widths[day]! - 1,
        top: state.layout.bodyTop + row, bottom: state.layout.bodyTop + row + weekHeight - 1 });
      left += widths[day]! + 1;
    }
    for (let line = 0; line < weekHeight; line++, row++) {
      rows[row] = dates.map((date, day) => {
        const size = widths[day]!;
        const events = perDay[day]!;
        let content = "";
        if (line === 0) {
          const color = date === state.selectedDate ? theme.text + theme.bold
            : date.slice(0, 7) === state.selectedDate.slice(0, 7) ? theme.text : theme.muted;
          const count = weekHeight === 1 && events.length ? ` · ${events.length}` : "";
          const number = Number(date.slice(8));
          if (date === today) {
            const label = `${number} Today${count}`;
            return todayHeader(width(label) <= size ? label : `${number}${count}`, size);
          }
          content = `${color} ${number}${count}${theme.boldOff}`;
        } else if (line === weekHeight - 1 && events.length > weekHeight - 1) {
          content = `${theme.muted} +${events.length - line + 1} more`;
        } else if (events[line - 1]) content = ` ${eventLabel(state, events[line - 1]!, size - 1)}`;
        return selectedCellContent(content, size, date === state.selectedDate);
      }).join(join);
    }
    if (separators && week < matrix.length - 1) rows[row++] = `${theme.appBg}${theme.borderUnfocused}${widths.map(size => "─".repeat(size)).join("┼")}${theme.reset}`;
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
    if (key === today) return todayHeader(width(title + " Today") <= widths[i]! ? title + " Today" : title, widths[i]!);
    return selectedCellContent(`${theme.text}${center(title, widths[i]!)}`, widths[i]!, key === state.selectedDate);
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
      const badge = currentDate === todayKey() ? todayHeader("Today", 7) + " " : " ";
      rows[row++] = segment(`${badge}${currentDate === state.selectedDate ? theme.accent : theme.text}${theme.bold}${formatLongDate(currentDate)}${theme.boldOff}`, widthValue);
      if (row >= height) break;
    }
    const isSelected = occurrence.startDate <= state.selectedDate && occurrence.endDate >= state.selectedDate
      && eventsOnSelectedDate(state)[state.selectedEventIndex]?.id === occurrence.id;
    const time = formatItemTime(occurrence.event).padEnd(13);
    const calendar = calendarFor(state, occurrence.event.calendarId);
    state.layout.eventRows.push({ index: 0, date: occurrence.startDate, eventId: occurrence.event.id, row: state.layout.bodyTop + row, left: state.layout.mainLeft, right: state.cols });
    const done = eventIsCompleted(occurrence.event, occurrence.startDate);
    const label = truncate(occurrence.event.title, Math.max(0, widthValue - width(`   ${time} ● `)));
    const overdue = deadlineIsOverdue(occurrence.event, occurrence.startDate);
    const title = done ? `${theme.muted}✓ ${theme.strike}${label}${theme.strikeOff}` : `${overdue ? theme.warning : eventColor(calendar?.color ?? "#1d9bf0")}${occurrence.event.kind === "deadline" ? "◆" : "●"} ${overdue ? theme.warning : theme.text}${label}`;
    rows[row++] = segment(`${isSelected ? " ▸" : "  "} ${theme.muted}${time} ${title}`, widthValue, isSelected ? theme.sidebarSelBg : theme.appBg);
    if (occurrence.event.location && row < height) rows[row++] = segment(`${theme.muted}                  @ ${occurrence.event.location}`, widthValue);
  }
  if (occurrences.length === 0 && height > 2) rows[2] = segment(`${theme.muted} No upcoming events.`, widthValue);
  return rows;
}

function titledOverlayBorder(title: string, boxWidth: number): string {
  const label = ` ${truncate(title, boxWidth - 4)} `;
  const fill = Math.max(0, boxWidth - width(label) - 2);
  const left = Math.floor(fill / 2);
  return `${theme.borderFocused}┌${"─".repeat(left)}${theme.bold}${label}${theme.boldOff}${theme.borderFocused}${"─".repeat(fill - left)}┐`;
}

function framedOverlayRow(content: string, boxWidth: number, bg = theme.appBg): string {
  return `${theme.borderFocused}│${segment(content, boxWidth - 2, bg)}${theme.borderFocused}│`;
}

function recurrenceLabel(occurrence: EventOccurrence): string | null {
  const recurrence = occurrence.event.recurrence;
  if (!recurrence) return null;
  let label = recurrence.interval === 1 ? recurrence.frequency : `${recurrence.frequency} / ${recurrence.interval}`;
  if (recurrence.until) label += ` until ${recurrence.until}`;
  if (recurrence.count) label += ` · ${recurrence.count} times`;
  return label;
}

function renderDayOverlay(state: AppState, rows: string[]): void {
  state.layout.eventRows = [];
  const occurrences = eventsOnSelectedDate(state);
  const selected = selectedOccurrence(state);
  const left = state.layout.mainLeft;
  const totalWidth = state.cols - left + 1;
  const top = state.layout.bodyTop - 1;
  const height = state.layout.bodyBottom - state.layout.bodyTop + 1;
  const split = totalWidth >= 96;
  const listWidth = split ? Math.floor(totalWidth * 0.46) : totalWidth;
  const listHeight = split ? height : Math.min(Math.max(6, Math.floor(height * 0.42)), height);
  const detailWidth = split ? totalWidth - listWidth - 1 : totalWidth;
  const detailHeight = split ? height : height - listHeight - 1;
  state.layout.dayList = { left, right: left + listWidth - 1, top: top + 1, bottom: top + listHeight };
  for (let row = 0; row < height; row++) putOverlayRow(rows, top + row, left, totalWidth, "");
  const putList = (row: number, content: string, active = false) => {
    if (row < listHeight) putOverlayRow(rows, top + row, left, listWidth, segment(content, listWidth, active ? theme.sidebarSelBg : theme.appBg));
  };
  const todayBadge = state.selectedDate === todayKey() ? todayHeader("Today", 7) + " " : " ";
  putList(0, `${todayBadge}${theme.text}${theme.bold}${formatLongDate(state.selectedDate)}${theme.boldOff}`);
  const schedule = daySchedule(occurrences, state.selectedDate);
  const now = scheduleNow(schedule.rows, state.selectedDate);
  const missingEnds = occurrences.filter(({ event }) => event.kind !== "deadline" && event.startTime && !event.endTime).length;
  const listTop = now && missingEnds ? 4 : 3;
  const capacity = Math.max(1, listHeight - listTop);
  const start = scheduleWindow(schedule.rows, state.selectedEventIndex, capacity);
  const range = schedule.rows.length > capacity ? ` · ${start + 1}–${Math.min(schedule.rows.length, start + capacity)} / ${schedule.rows.length}` : "";
  const deadlines = occurrences.filter(({ event }) => event.kind === "deadline").length;
  const events = occurrences.length - deadlines;
  const counts = [events || !deadlines ? `${events} event${events === 1 ? "" : "s"}` : "", deadlines ? `${deadlines} deadline${deadlines === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
  putList(1, `${theme.muted} ${counts} · ${durationLabel(schedule.freeMinutes)} free${range}`);
  if (!occurrences.length) putList(2, `${theme.muted} Nothing scheduled. A little breathing room.`);
  if (now) {
    const context = now.rows.map(item => item.kind === "free" ? "Free time" : occurrences[item.eventIndex]!.event.title).join(" + ");
    putList(2, `${theme.accent}${theme.bold} Now ${now.time}${theme.boldOff}${theme.text} · ${context}`);
  }
  if (missingEnds) putList(now ? 3 : 2, `${theme.muted} ${missingEnds} missing end time${missingEnds === 1 ? "" : "s"} · excluded from free-time total`);
  for (let i = start; i < Math.min(schedule.rows.length, start + capacity); i++) {
    const item = schedule.rows[i]!;
    const row = listTop + i - start;
    const current = now?.rows.includes(item) ?? false;
    const timeStyle = current ? theme.accent + theme.bold : theme.muted;
    const nowTag = current ? `${theme.accent}${theme.bold}Now${theme.boldOff} ` : "";
    if (item.kind === "free") {
      putList(row, `${timeStyle}   ${pad(item.time, 13)}${theme.boldOff} ${nowTag}${theme.success}○ Free${theme.muted} · ${durationLabel(item.end - item.start)}`);
      continue;
    }
    const occurrence = occurrences[item.eventIndex]!;
    const active = item.eventIndex === state.selectedEventIndex;
    const calendar = calendarFor(state, occurrence.event.calendarId);
    const title = truncate(occurrence.event.title, listWidth - 21 - (current ? 4 : 0));
    const done = eventIsCompleted(occurrence.event, occurrence.startDate);
    const overdue = deadlineIsOverdue(occurrence.event, occurrence.startDate);
    const styledTitle = done ? `${theme.muted}✓ ${theme.strike}${title}${theme.strikeOff}` : `${overdue ? theme.warning : eventColor(calendar?.color ?? "#1d9bf0")}${occurrence.event.kind === "deadline" ? "◆" : "●"} ${overdue ? theme.warning : theme.text}${title}`;
    const content = `${active ? theme.accent : theme.muted} ${active ? "▸" : " "} ${timeStyle}${pad(item.time, 13)}${theme.boldOff} ${nowTag}${styledTitle}`;
    putList(row, content, active);
    state.layout.eventRows.push({ index: item.eventIndex, left, right: left + listWidth - 1, row: top + row + 1 });
  }
  if (split) {
    for (let row = 0; row < height; row++) putOverlayRow(rows, top + row, left + listWidth, 1, `${theme.borderUnfocused}│`);
  } else if (listHeight < height) putOverlayRow(rows, top + listHeight, left, totalWidth, `${theme.borderUnfocused}${"─".repeat(totalWidth)}`);
  const details: string[] = [];
  const add = (text: string, color = theme.text) => details.push(...wrapText(text, detailWidth - 4).map(line => `  ${color}${line}`));
  if (selected) {
    const event = selected.event;
    const calendar = calendarFor(state, event.calendarId);
    const done = eventIsCompleted(event, selected.startDate);
    const overdue = deadlineIsOverdue(event, selected.startDate);
    add(event.title, theme.bold + (done ? theme.muted + theme.strike : overdue ? theme.warning : theme.text));
    details.push(theme.strikeOff + theme.boldOff);
    if (done) add("✓ Completed", theme.muted);
    if (event.kind === "deadline") add(overdue ? "◆ Deadline · Overdue" : "◆ Deadline", overdue ? theme.warning : theme.muted);
    add(`${formatItemTime(event)}  ·  ${selected.startDate === selected.endDate ? selected.startDate : selected.startDate + " — " + selected.endDate}`);
    if (event.kind === "deadline") add("Due point only · does not reserve time.", theme.muted);
    else if (event.startTime && !event.endTime) add("End time not set; no duration reserved in the free-time calculation.", theme.muted);
    add(`● ${calendar?.name ?? "Unknown calendar"}`, eventColor(calendar?.color ?? "#1d9bf0"));
    if (event.location) { details.push(""); add("Location", theme.muted); add(event.location); }
    const recurrence = recurrenceLabel(selected);
    if (recurrence) { details.push(""); add("Repeats", theme.muted); add(recurrence); }
    if (event.notes) { details.push(""); add("Notes", theme.muted); add(event.notes); }
  } else { add("Your day is open", theme.bold + theme.text); details.push(theme.boldOff); add("Add an event when you’re ready.", theme.muted); }
  const contentHeight = Math.max(0, detailHeight - 1);
  state.detailScroll = Math.max(0, Math.min(state.detailScroll, details.length - contentHeight));
  const detailTop = split ? top : top + listHeight + 1;
  const detailLeft = split ? left + listWidth + 1 : left;
  for (let i = 0; i < contentHeight; i++) putOverlayRow(rows, detailTop + i, detailLeft, detailWidth, details[state.detailScroll + i] ?? "");
  if (details.length > contentHeight && detailHeight > 0) putOverlayRow(rows, detailTop + detailHeight - 1, detailLeft, detailWidth,
    `${theme.muted}  ${state.detailScroll + 1}–${Math.min(details.length, state.detailScroll + contentHeight)} / ${details.length}`);
}

function renderEditorOverlay(state: AppState, rows: string[], editor: EditorState): { row: number; col: number } | null {
  const boxWidth = Math.min(82, state.cols - 6);
  const valueWidth = boxWidth - 17;
  const errorRows = state.rows >= 19 ? 1 : 0;
  const visibleCount = Math.min(editor.fields.length, Math.max(1, state.rows - STATUSLINE_HEIGHT - 7 - errorRows));
  const fieldStart = Math.max(0, Math.min(editor.active - visibleCount + 1, editor.fields.length - visibleCount));
  const boxHeight = visibleCount + 3 + errorRows;
  const top = Math.max(1, Math.floor((state.rows - STATUSLINE_HEIGHT - 2 - boxHeight) / 2));
  const left = Math.max(1, Math.floor((state.cols - boxWidth) / 2) + 1);
  const put = (row: number, content: string) => putOverlayRow(rows, row, left, boxWidth, content);
  const itemKind = editorItemKind(editor);
  put(top, titledOverlayBorder(`${editor.kind === "create" ? "New" : "Edit"} ${itemKind}`, boxWidth));
  let cursor: { row: number; col: number } | null = null;
  for (let index = fieldStart; index < fieldStart + visibleCount; index++) {
    const item = editor.fields[index]!;
    const active = index === editor.active;
    const window = inputWindow(item.value.replace(/\n/g, "↵"), active ? editor.cursor : 0, valueWidth);
    const placeholder = item.key === "startTime" ? itemKind === "deadline" ? "Date only" : "All day" : item.key === "endTime" ? "HH:MM" : item.key === "title" ? itemKind === "deadline" ? "Deadline title" : "Event title" : "Optional";
    const display = item.value ? pad(window.text, valueWidth) : `${theme.muted}${pad(placeholder, valueWidth)}`;
    const fieldStyle = active ? theme.sidebarSelBg + theme.text : theme.appBg + theme.text;
    const fieldRow = top + 1 + index - fieldStart;
    put(fieldRow, `${theme.borderFocused}│${fieldStyle} ${theme.muted}${pad(item.label, 10)} ${theme.borderFocused}│${fieldStyle} ${display} ${theme.appBg}${theme.borderFocused}│`);
    state.layout.editorFields.push({ index, left: left + 15, right: left + boxWidth - 3, row: fieldRow + 1 });
    if (active && !editor.saving) cursor = { row: fieldRow + 1, col: left + 15 + window.column };
  }
  const errorRow = top + visibleCount + 1;
  if (errorRows) put(errorRow, framedOverlayRow(`${theme.error} ${truncate(editor.error ?? "", boxWidth - 4)}`, boxWidth));
  const actionsRow = errorRow + errorRows;
  let actions = " ";
  for (const [index, label] of [editor.saving ? "Saving…" : "Save", "Cancel"].entries()) {
    const text = ` ${label} `;
    const actionLeft = left + 1 + width(actions);
    actions += `${editor.active === editor.fields.length + index ? theme.sidebarSelBg : theme.appBg}${index === 0 ? theme.accent + theme.bold : theme.muted}${text}${theme.reset}  `;
    state.layout.actions.push({ action: index === 0 ? "save" : "cancel", left: actionLeft, right: actionLeft + width(text) - 1, row: actionsRow + 1 });
  }
  if (!errorRows && editor.error) actions += `${theme.error}${truncate(editor.error, Math.max(0, boxWidth - 3 - width(actions)))}`;
  put(actionsRow, framedOverlayRow(actions, boxWidth));
  put(actionsRow + 1, `${theme.borderFocused}└${"─".repeat(boxWidth - 2)}┘`);
  return cursor;
}

function renderHelpOverlay(state: AppState, rows: string[]): void {
  const content = [
    ["h j k l", "move by day / week"], ["[  ]", "previous / next month"], ["t or gg", "today"],
    ["Enter", "open selected day"], ["n / a", "new event"], ["e", "edit selected event"],
    ["d", "delete selected event"], [";", "done / unfinished"], ["J / K", "next / previous event"], ["v", "cycle view"],
    ["/", "open command prompt"],
    ["Ctrl+J/K", "sidebar / main panel"], ["Ctrl+N", "calendar / prompt"],
    ["Ctrl+P", "new event"], ["Ctrl+S", "toggle sidebar"], ["Ctrl+Shift+R", "restart cald"],
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
  put(top, titledOverlayBorder("Delete event?", boxWidth));
  put(top + 1, `${theme.error}│${theme.text}${center(truncate(event.title, boxWidth - 6), boxWidth - 2)}${theme.error}│`);
  put(top + 2, `${theme.error}│${theme.muted}${center(event.recurrence ? "This deletes the entire recurring series." : formatLongDate(event.startDate), boxWidth - 2)}${theme.error}│`);
  const buttons = " Delete    Cancel ";
  const buttonLeft = left + 1 + Math.floor((boxWidth - 2 - width(buttons)) / 2);
  put(top + 3, `${theme.error}│${center(`${theme.error} Delete    ${theme.text}Cancel `, boxWidth - 2)}${theme.error}│`);
  state.layout.actions.push({ action: "confirm-delete", row: top + 4, left: buttonLeft, right: buttonLeft + 7 });
  state.layout.actions.push({ action: "cancel-delete", row: top + 4, left: buttonLeft + 10, right: buttonLeft + 16 });
  put(top + 4, `${theme.error}└${"─".repeat(boxWidth - 2)}┘`);
}

function renderPromptSeparator(state: AppState, borderColor: string): string {
  if (!state.notice || state.cols < 4) return segment(`${borderColor}${"─".repeat(state.cols)}`, state.cols);
  const text = truncate(state.notice.text, state.cols - 3);
  const trailing = "─".repeat(Math.max(0, state.cols - width(text) - 3));
  return segment(`${borderColor}─ ${noticeColor(state.notice.kind)}${text} ${borderColor}${trailing}`, state.cols);
}

function promptRendering(state: AppState): { line: string; cursor: { row: number; col: number } | null } {
  const row = state.rows - STATUSLINE_HEIGHT - 1;
  const focused = isPromptFocused(state);
  if (!state.prompt) {
    const pending = state.pendingKeys ? ` ${state.pendingKeys}` : "";
    return { line: segment(`${theme.muted} N ❯${pending}`, state.cols), cursor: null };
  }
  const modeLabel = state.prompt.mode === "insert" ? "I" : "N";
  const modeColor = !focused ? theme.muted : state.prompt.mode === "insert" ? theme.vimInsert : theme.vimNormal;
  const prefix = ` ${modeLabel} ❯ `, max = Math.max(1, state.cols - width(prefix));
  const window = inputWindow(state.prompt.text, state.prompt.cursor, max);
  const shown = stylePromptText(state.prompt, window, focused);
  return {
    line: segment(`${modeColor} ${modeLabel} ${focused ? theme.accent : theme.muted}❯ ${shown}`, state.cols),
    cursor: focused ? { row, col: width(prefix) + window.column + 1 } : null,
  };
}

function renderCompletion(state: AppState, rows: string[]): void {
  if (!isPromptFocused(state) || !state.prompt || state.editor || state.helpOpen || state.confirmDelete) return;
  refreshCompletion(state.prompt, state);
  const menu = state.prompt.completion;
  if (!menu) return;
  const popup = completionMenu(menu, state.cols, state.rows - STATUSLINE_HEIGHT - 2);
  for (const [i, content] of popup.rows.entries()) {
    const row = popup.top + i;
    putOverlayRow(rows, row - 1, 1, popup.width, content);
    state.layout.actions.push({ action: `complete:${popup.start + i}`, left: 1, right: popup.width, row });
  }
}

export function buildFrame(state: AppState): { rows: string[]; cursor: string } {
  if (state.focus === "sidebar" && (!state.sidebarOpen || state.cols < 76)) state.focus = "calendar";
  const rows = Array.from({ length: state.rows }, () => segment("", state.cols));
  if (state.cols < 54 || state.rows < 18) {
    state.layout.dayList = undefined;
    rows[Math.floor(state.rows / 2)] = segment(`${theme.muted}${truncate("Resize terminal to at least 54 × 18", state.cols)}`, state.cols);
    state.layout.actions = []; state.layout.eventRows = []; state.layout.editorFields = []; state.layout.monthCells = []; state.layout.calendarRows = [];
    return { rows, cursor: cursorAt(1, 1, cursorBlock, false) };
  }
  rows[0] = renderTopbar(state);
  const footerTop = Math.max(3, state.rows - STATUSLINE_HEIGHT - 2);
  const bodyTop = 3;
  const bodyHeight = Math.max(0, footerTop - bodyTop);
  const sidebarWidth = state.sidebarOpen && state.cols >= 76 ? Math.min(31, Math.floor(state.cols * 0.32)) : 0;
  const mainWidth = state.cols - sidebarWidth;
  state.layout = { sidebarWidth, calendarRows: [], monthCells: [], mainLeft: sidebarWidth + 1, bodyTop, bodyBottom: footerTop - 1, actions: [], eventRows: [], editorFields: [] };
  rows[1] = renderToolbar(state);
  const sidebar = sidebarWidth ? renderSidebar(state, bodyHeight, sidebarWidth) : [];
  const main = state.dayOpen ? Array.from({ length: bodyHeight }, () => segment("", mainWidth))
    : state.view === "month" ? renderMonth(state, mainWidth, bodyHeight, sidebarWidth + 1)
    : state.view === "week" ? renderWeek(state, mainWidth, bodyHeight, sidebarWidth + 1)
      : renderAgenda(state, mainWidth, bodyHeight);
  for (let index = 0; index < bodyHeight; index++) rows[bodyTop - 1 + index] = (sidebar[index] ?? "") + (main[index] ?? segment("", mainWidth));

  const prompt = promptRendering(state);
  const borderColor = isPromptFocused(state) ? theme.accent : theme.borderUnfocused;
  rows[state.rows - STATUSLINE_HEIGHT - 3] = renderPromptSeparator(state, borderColor);
  rows[state.rows - STATUSLINE_HEIGHT - 2] = prompt.line;
  rows[state.rows - STATUSLINE_HEIGHT - 1] = segment(`${borderColor}${"─".repeat(state.cols)}`, state.cols);
  for (const [index, line] of renderStatusline(state).entries()) rows[state.rows - STATUSLINE_HEIGHT + index] = line;

  let overlayCursor: { row: number; col: number } | null = null;
  if (state.dayOpen) renderDayOverlay(state, rows);
  if (state.editor || state.helpOpen || state.confirmDelete) {
    for (let i = bodyTop - 1; i < footerTop - 1; i++) rows[i] = `${theme.muted}${rows[i]!.replace(/\x1b\[[0-9;]*m/g, theme.appBg + theme.muted)}${theme.reset}`;
  }
  if (state.helpOpen) renderHelpOverlay(state, rows);
  if (state.confirmDelete) renderDeleteOverlay(state, rows);
  if (state.editor) overlayCursor = renderEditorOverlay(state, rows, state.editor);
  renderCompletion(state, rows);
  const cursor = overlayCursor
    ? cursorAt(overlayCursor.row, overlayCursor.col, state.editor?.mode === "insert" ? cursorBar : cursorBlock)
    : prompt.cursor ? cursorAt(prompt.cursor.row, prompt.cursor.col, state.prompt?.mode === "normal" ? cursorBlock : cursorBar)
      : cursorAt(1, 1, cursorBlock, false);
  return { rows, cursor };
}

export function render(state: AppState): void {
  state.cols = process.stdout.columns || state.cols || 80;
  state.rows = process.stdout.rows || state.rows || 24;
  flushFrame(buildFrame(state));
}
