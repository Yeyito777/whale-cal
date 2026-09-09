import { addMonths, deadlineIsOverdue, eventIsCompleted, todayKey } from "@whale-cal/shared/dates";
import { deadlineKey } from "./deadline-list";
import { deadlinesInView, type AppState } from "./state";
import { eventColor, theme } from "./theme";
import { pad, truncate, width, wrapText } from "./text";

export function renderDeadlines(state: AppState, columns: number, height: number): string[] {
  const items = deadlinesInView(state), selected = items[state.deadlineIndex];
  const split = columns >= 100, listWidth = split ? Math.floor(columns * 0.64) : columns;
  const styled = (text: string, size: number, bg = theme.appBg) => `${bg}${pad(truncate(text, size), size)}${theme.reset}`;
  const rows = Array.from({ length: height }, () => styled("", columns));
  const left = state.layout.mainLeft, top = state.layout.bodyTop;
  const controls = (row: number, choices: Array<[string, string, boolean?]>) => {
    let line = " ";
    for (const [label, action, active] of choices) {
      const text = ` ${label} `, column = width(line);
      if (column + width(text) > columns) break;
      line += `${active ? theme.sidebarSelBg + theme.text : theme.appBg + theme.muted}${text}${theme.reset} `;
      state.layout.actions.push({ action, left: left + column, right: left + column + width(text) - 1, row: top + row });
    }
    rows[row] = styled(line, columns);
  };
  rows[0] = styled(` ${theme.bold}${theme.text}Deadlines${theme.boldOff}${theme.muted} · ${items.length} ${state.deadlineFilter} · ${state.deadlineMarkedKeys.length} marked`, columns);
  controls(1, [ ["Pending", "deadline-filter:pending", state.deadlineFilter === "pending"], ["Completed", "deadline-filter:completed", state.deadlineFilter === "completed"], ["All", "deadline-filter:all", state.deadlineFilter === "all"] ]);
  controls(2, [["Done", "deadline-done"], ["Reopen", "deadline-reopen"], ["Mark", "deadline-mark"], ["Mark all", "deadline-mark-all"], ["Clear", "deadline-clear"]]);
  const body = Math.max(0, height - 4);
  const entries: Array<{ text: string; index?: number; title?: boolean }> = [];
  let previous = "";
  for (const [index, item] of items.entries()) {
    const done = eventIsCompleted(item.event, item.startDate);
    const overdue = deadlineIsOverdue(item.event, item.startDate);
    const group = done ? "Completed" : overdue ? "Overdue" : item.startDate === todayKey() ? "Today" : "Upcoming";
    if (group !== previous) { entries.push({ text: ` ${group === "Overdue" ? theme.warning : theme.muted}${group}` }); previous = group; }
    const calendar = state.database.calendars.find(c => c.id === item.event.calendarId);
    const color = done ? theme.muted : eventColor(calendar?.color ?? "#1d9bf0");
    entries.push({ index, title: true, text: ` ${state.deadlineMarkedKeys.includes(deadlineKey(item)) ? theme.accent + "●" : " "} ${color}${done ? "✓" : "○"} ${done ? theme.strike : ""}${item.event.title}${theme.strikeOff}` });
    entries.push({ index, text: `     ${overdue ? theme.warning : theme.muted}${item.startDate} · ${item.event.startTime ?? "end of day"}${item.event.recurrence ? " · ↻" : ""} · ${calendar?.name ?? "Calendar"}` });
  }
  const anchor = Math.max(0, entries.findIndex(entry => entry.index === state.deadlineIndex));
  const scroll = Math.max(0, Math.min(Math.max(0, entries.length - body), anchor - Math.min(2, Math.max(0, body - 2))));
  const details: string[] = [];
  if (selected && split) {
    const room = columns - listWidth - 3;
    details.push(...wrapText(selected.event.title, room), "", `${selected.startDate} · ${selected.event.startTime ?? "end of day"}`, eventIsCompleted(selected.event, selected.startDate) ? "✓ Completed" : deadlineIsOverdue(selected.event, selected.startDate) ? "Overdue" : "Pending", "");
    if (selected.event.recurrence) details.push("Repeating deadline", "Completion affects this occurrence.", "Editing changes the series.", "");
    if (selected.event.location) details.push(...wrapText(selected.event.location, room), "");
    if (selected.event.notes) details.push(...wrapText(selected.event.notes, room));
  }
  for (let row = 0; row < body; row++) {
    const entry = entries[scroll + row];
    const bg = entry?.index === state.deadlineIndex ? theme.sidebarSelBg : theme.appBg;
    const text = entry?.text ?? (row === 0 && !items.length ? `${theme.muted} No ${state.deadlineFilter === "all" ? "" : state.deadlineFilter + " "}deadlines in visible calendars.` : "");
    rows[4 + row] = styled(text, listWidth, bg) + (split ? styled(`${theme.borderUnfocused}│ ${theme.text}${details[row] ?? ""}`, columns - listWidth) : "");
    if (entry?.index !== undefined) {
      state.layout.eventRows.push({ index: entry.index, left, right: left + listWidth - 1, row: top + 4 + row });
      if (entry.title) state.layout.actions.push({ action: `deadline-toggle:${entry.index}`, left: left + 3, right: left + 4, row: top + 4 + row });
    }
  }
  rows[3] = styled(`${theme.muted} ${items.length ? `${state.deadlineIndex + 1}/${items.length} · ` : ""}Recurring through ${addMonths(todayKey(), 12)}`, columns);
  return rows;
}
