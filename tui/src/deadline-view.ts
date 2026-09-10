import { dateFromKey, daysBetween, deadlineIsOverdue, eventIsCompleted, formatMonthYear, todayKey } from "@whale-cal/shared/dates";
import { deadlineKey, deadlineOccurrences } from "./deadline-list";
import { deadlinesInView, visibleEvents, type AppState } from "./state";
import { eventColor, theme } from "./theme";
import { pad, truncate, width, wrapText } from "./text";

const shortDate = (date: string) => dateFromKey(date).toLocaleDateString("en-US", { month: "short", day: "numeric" });

export function renderDeadlines(state: AppState, columns: number, height: number): string[] {
  const items = deadlinesInView(state), selected = items[state.deadlineIndex];
  const today = todayKey(), all = deadlineOccurrences(visibleEvents(state));
  const completed = all.filter(item => eventIsCompleted(item.event, item.startDate)).length;
  // Don't stretch a short title across two thirds of an ultrawide terminal.
  const split = columns >= 100, listWidth = split ? Math.min(98, Math.floor(columns * 0.60)) : columns;
  const styled = (text: string, size: number, bg = theme.appBg) => `${bg}${pad(truncate(text, size), size)}${theme.reset}`;
  const rows = Array.from({ length: height }, () => styled("", columns));
  const left = state.layout.mainLeft, top = state.layout.bodyTop;
  const controls = (row: number, choices: Array<[string, string, boolean?]>) => {
    let line = " ";
    for (const [label, action, active] of choices) {
      const text = ` ${label} `, column = width(line);
      if (column + width(text) > listWidth) break;
      line += `${active ? theme.sidebarSelBg + theme.text : theme.appBg + theme.muted}${text}${theme.reset} `;
      if (action) state.layout.actions.push({ action, left: left + column, right: left + column + width(text) - 1, row: top + row });
    }
    rows[row] = styled(line, listWidth);
  };
  controls(0, [[`Pending ${all.length - completed}`, "deadline-filter:pending", state.deadlineFilter === "pending"], [`Completed ${completed}`, "deadline-filter:completed", state.deadlineFilter === "completed"], ["All", "deadline-filter:all", state.deadlineFilter === "all"]]);
  const marked = state.deadlineMarkedKeys.length;
  const done = selected && eventIsCompleted(selected.event, selected.startDate);
  controls(1, marked
    ? [["Done", "deadline-done"], ["Reopen", "deadline-reopen"], ["Mark", "deadline-mark"], ["Clear", "deadline-clear"], [`${marked} marked`, ""]]
    : [[done ? "Reopen" : "Done", done ? "deadline-reopen" : "deadline-done"], ["Mark", "deadline-mark"], ["Mark all", "deadline-mark-all"]]);
  rows[2] = styled(`${theme.borderUnfocused} ${"─".repeat(Math.max(0, listWidth - 3))}  `, listWidth);
  const bodyTop = 3, body = Math.max(0, height - bodyTop - 1);
  const entries: Array<{ text: string; index?: number; title?: boolean }> = [];
  let previous = "";
  const sideBySideDate = listWidth >= 68;
  const dateWidth = 22, titleWidth = listWidth - (sideBySideDate ? dateWidth + 3 : 2);
  const pair = (a: string, b: string) => pad(a, titleWidth) + (sideBySideDate ? " " + pad(b, dateWidth) + "  " : "  ");
  for (const [index, item] of items.entries()) {
    const done = eventIsCompleted(item.event, item.startDate);
    const overdue = deadlineIsOverdue(item.event, item.startDate);
    const days = daysBetween(today, item.startDate);
    const group = done ? "Completed" : overdue ? "Overdue" : days === 0 ? "Today" : days === 1 ? "Tomorrow" : days < 7 ? "Next seven days" : formatMonthYear(item.startDate);
    if (group !== previous) {
      if (previous) entries.push({ text: "" });
      entries.push({ text: ` ${overdue ? theme.warning : theme.muted}${theme.bold}${group}${theme.boldOff}` });
      previous = group;
    }
    const calendar = state.database.calendars.find(c => c.id === item.event.calendarId);
    const color = done ? theme.muted : eventColor(calendar?.color ?? "#1d9bf0");
    const marker = state.deadlineMarkedKeys.includes(deadlineKey(item)) ? theme.accent + "●" : index === state.deadlineIndex ? theme.text + "▸" : " ";
    const title = truncate(item.event.title, Math.max(1, titleWidth - 6));
    const label = ` ${marker} ${color}${done ? "✓" : "○"} ${done ? theme.muted + theme.strike : theme.text}${title}${theme.strikeOff}`;
    const dateColor = done ? theme.muted : overdue || days === 0 ? theme.warning : theme.text;
    const due = days === 0 ? "Today" : days === 1 ? "Tomorrow" : shortDate(item.startDate) + (item.startDate.slice(0, 4) !== today.slice(0, 4) ? `, ${item.startDate.slice(0, 4)}` : "");
    const when = item.event.startTime ?? "Date only";
    const subtitle = sideBySideDate ? `${calendar?.name ?? "Calendar"}${item.event.recurrence ? " · Repeats" : ""}`
      : `${due} · ${when} · ${calendar?.name ?? "Calendar"}${item.event.recurrence ? " · ↻" : ""}`;
    entries.push({ index, title: true, text: pair(label, `${dateColor}${due}`) });
    entries.push({ index, text: pair(`     ${theme.muted}${truncate(subtitle, Math.max(1, titleWidth - 5))}`, `${theme.muted}${when}${overdue ? " · overdue" : ""}`) });
  }
  const anchor = Math.max(0, entries.findIndex(entry => entry.index === state.deadlineIndex));
  const scroll = Math.max(0, Math.min(Math.max(0, entries.length - body), anchor - Math.min(2, Math.max(0, body - 2))));
  const details: string[] = [];
  const room = Math.min(64, columns - listWidth - 5);
  if (selected && split) {
    const event = selected.event, done = eventIsCompleted(event, selected.startDate), overdue = deadlineIsOverdue(event, selected.startDate);
    const calendar = state.database.calendars.find(c => c.id === event.calendarId);
    details.push(`${theme.muted}DEADLINE`, "", ...wrapText(event.title, room).map(line => `${theme.text}${theme.bold}${line}${theme.boldOff}`), "");
    const field = (label: string, value: string, color = theme.text) => details.push(`${theme.muted}${pad(label, 10)}${color}${value}`);
    field("Due", shortDate(selected.startDate) + `, ${selected.startDate.slice(0, 4)}${event.startTime ? ` · ${event.startTime}` : ""}`);
    field("Status", done ? "Completed" : overdue ? "Overdue" : "Pending", done ? theme.muted : overdue ? theme.warning : theme.text);
    field("Calendar", truncate(calendar?.name ?? "Calendar", Math.max(1, room - 10)));
    if (!event.startTime) details.push(`${theme.muted}No time specified`);
    if (event.recurrence) details.push("", `${theme.muted}Repeating deadline`, ...wrapText("Completion applies to this occurrence; edits affect the series.", room).map(line => theme.muted + line));
    if (event.location) details.push("", `${theme.muted}LOCATION`, ...wrapText(event.location, room).map(line => theme.text + line));
    if (event.notes) details.push("", `${theme.muted}NOTES`, "", ...wrapText(event.notes, room).map(line => theme.text + line));
  }
  const detailHeight = height - 1;
  const maxDetailScroll = Math.max(0, details.length - detailHeight);
  state.detailScroll = Math.max(0, Math.min(state.detailScroll, maxDetailScroll));
  if (split) state.layout.deadlineDetails = { left: left + listWidth, right: left + columns - 1, top, bottom: top + detailHeight - 1, maxScroll: maxDetailScroll };
  for (let row = 0; row < body; row++) {
    const entry = entries[scroll + row];
    const bg = entry?.index === state.deadlineIndex ? theme.sidebarSelBg : theme.appBg;
    const text = entry?.text ?? (row === 0 && !items.length ? `${theme.muted} No ${state.deadlineFilter === "all" ? "" : state.deadlineFilter + " "}deadlines in visible calendars.` : "");
    rows[bodyTop + row] = styled(text, listWidth, bg);
    if (entry?.index !== undefined) {
      state.layout.eventRows.push({ index: entry.index, left, right: left + listWidth - 1, row: top + bodyTop + row });
      if (entry.title) state.layout.actions.push({ action: `deadline-toggle:${entry.index}`, left: left + 3, right: left + 4, row: top + bodyTop + row });
    }
  }
  rows[height - 1] = styled(`${theme.muted} ${items.length ? `${state.deadlineIndex + 1} / ${items.length}` : ""}${all.some(item => item.event.recurrence) ? " · Repeats: next 12 months" : ""}`, listWidth);
  for (let row = 0; row < height; row++) {
    if (split) {
      const text = row === height - 1 ? maxDetailScroll ? `${theme.muted}${state.detailScroll > 0 ? "↑ " : ""}${state.detailScroll < maxDetailScroll ? "More below ↓" : "End of details"}` : "" : details[row + state.detailScroll] ?? "";
      rows[row] = styled(rows[row]!, listWidth) + styled(`${theme.borderUnfocused}│  ${text}`, columns - listWidth);
    } else rows[row] = styled(rows[row]!, columns);
  }
  return rows;
}
