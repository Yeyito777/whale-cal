import { isDateKey } from "@whale-cal/shared/dates";
import { parseQuickAdd } from "@whale-cal/shared/quick-add";
import type { CalendarItemKind, CalendarView, EventDraft } from "@whale-cal/shared/types";
import type { AppState } from "./state";

export type CommandAction =
  | { type: "none" }
  | { type: "quit" }
  | { type: "help" }
  | { type: "today" }
  | { type: "goto"; date: string }
  | { type: "view"; view: CalendarView }
  | { type: "new"; kind?: CalendarItemKind; draft?: EventDraft }
  | { type: "edit" }
  | { type: "delete" }
  | { type: "complete"; completed: boolean }
  | { type: "ssh_status" }
  | { type: "ssh_connect"; alias: string }
  | { type: "ssh_cancel" }
  | { type: "reload" }
  | { type: "calendar_new"; name: string; color?: string }
  | { type: "calendar_toggle"; name: string }
  | { type: "group_new"; name: string }
  | { type: "group_rename"; id: string; name: string }
  | { type: "group_delete"; id: string }
  | { type: "calendar_group"; id: string; groupId: string | null }
  | { type: "search"; query: string }
  | { type: "error"; message: string };

export const COMMANDS = [
  ["/help", "show keys and commands"], ["/today", "jump to today"], ["/goto", "select YYYY-MM-DD"],
  ["/deadline", "create a deadline, not a time block"],
  ["/view", "month, week, agenda, or deadlines"], ["/new", "quick-create an event"], ["/edit", "edit selected event"],
  ["/delete", "delete selected event"], ["/search", "find an event"], ["/calendar", "new/toggle calendars"],
  ["/done", "mark selected event done"], ["/undone", "mark selected event unfinished"],
  ["/group", "organize calendars into groups"],
  ["/ssh", "route through a remote cald"], ["/reload", "reload canonical state"], ["/quit", "leave the TUI"],
] as const;

export function runCommand(text: string, state: AppState): CommandAction {
  const trimmed = text.trim();
  if (!trimmed) return { type: "none" };
  const [name, ...args] = trimmed.split(/\s+/);
  const rest = trimmed.slice(name!.length).trim();
  switch (name!.toLowerCase()) {
    case "/q": case "/quit": case "/exit": return { type: "quit" };
    case "/h": case "/help": return { type: "help" };
    case "/today": return { type: "today" };
    case "/goto":
      if (!args[0] || !isDateKey(args[0])) return { type: "error", message: "Usage: /goto YYYY-MM-DD" };
      return { type: "goto", date: args[0] };
    case "/view":
      if (!(["month", "week", "agenda", "deadlines"] as string[]).includes(args[0] ?? "")) return { type: "error", message: "Usage: /view month|week|agenda|deadlines" };
      return { type: "view", view: args[0] as CalendarView };
    case "/new": case "/deadline": {
      const kind = name!.toLowerCase() === "/deadline" ? "deadline" : "event";
      if (!rest) return kind === "event" ? { type: "new" } : { type: "new", kind };
      try {
        const draft = parseQuickAdd(rest, { selectedDate: state.selectedDate });
        if (kind === "deadline" && draft.endTime) throw new Error("A deadline has a due time, not a time range.");
        return { type: "new", draft: { ...draft, kind } };
      }
      catch (error) { return { type: "error", message: error instanceof Error ? error.message : String(error) }; }
    }
    case "/edit": return { type: "edit" };
    case "/delete": return { type: "delete" };
    case "/done": return { type: "complete", completed: true };
    case "/undone": return { type: "complete", completed: false };
    case "/reload": return { type: "reload" };
    case "/search":
      if (!rest) return { type: "error", message: "Usage: /search words" };
      return { type: "search", query: rest };
    case "/ssh":
      if (!args[0]) return { type: "ssh_status" };
      if (args.length > 1) return { type: "error", message: "Usage: /ssh [alias|cancel]" };
      return args[0]!.toLowerCase() === "cancel" ? { type: "ssh_cancel" } : { type: "ssh_connect", alias: args[0]! };
    case "/group": {
      const operation = args.shift()?.toLowerCase();
      const value = args.join(" ").trim();
      const resolve = <T extends { id: string; name: string }>(items: T[], query: string): T | undefined => {
        const direct = items.find(item => item.id === query);
        if (direct) return direct;
        const matches = items.filter(item => item.name.toLowerCase() === query.toLowerCase());
        return matches.length === 1 ? matches[0] : undefined;
      };
      const groups = state.database.groups ?? [];
      if ((operation === "new" || operation === "create") && value) return { type: "group_new", name: value };
      if (operation === "move" || operation === "rename") {
        const parts = value.split(/\s+->\s+/);
        if (parts.length !== 2 || !parts[0] || !parts[1]) return { type: "error", message: operation === "move" ? "Usage: /group move CALENDAR -> GROUP" : "Usage: /group rename GROUP -> NEW NAME" };
        if (operation === "move") {
          const calendar = resolve(state.database.calendars, parts[0]), group = resolve(groups, parts[1]);
          return calendar && group ? { type: "calendar_group", id: calendar.id, groupId: group.id } : { type: "error", message: "Calendar or group not found (or ambiguous); use its ID." };
        }
        const group = resolve(groups, parts[0]);
        return group ? { type: "group_rename", id: group.id, name: parts[1] } : { type: "error", message: "Group not found (or ambiguous); use its ID." };
      }
      if (operation === "ungroup") {
        const calendar = resolve(state.database.calendars, value);
        return calendar ? { type: "calendar_group", id: calendar.id, groupId: null } : { type: "error", message: "Calendar not found (or ambiguous); use its ID." };
      }
      if (operation === "delete") {
        const group = resolve(groups, value);
        return group ? { type: "group_delete", id: group.id } : { type: "error", message: "Group not found (or ambiguous); use its ID." };
      }
      return { type: "error", message: "Use /group new NAME, move CALENDAR -> GROUP, ungroup CALENDAR, rename GROUP -> NAME, or delete GROUP (calendars preserved)." };
    }
    case "/calendar": {
      const sub = args.shift()?.toLowerCase();
      if (sub === "new") {
        const maybeColor = args.at(-1)?.match(/^#[0-9a-f]{6}$/i)?.[0];
        if (maybeColor) args.pop();
        const calendarName = args.join(" ").trim();
        return calendarName ? { type: "calendar_new", name: calendarName, ...(maybeColor ? { color: maybeColor } : {}) }
          : { type: "error", message: "Usage: /calendar new NAME [#rrggbb]" };
      }
      if (sub === "toggle") {
        const calendarName = args.join(" ").trim();
        return calendarName ? { type: "calendar_toggle", name: calendarName }
          : { type: "error", message: "Usage: /calendar toggle NAME" };
      }
      return { type: "error", message: "Usage: /calendar new NAME [#rrggbb] | /calendar toggle NAME" };
    }
    default: return { type: "error", message: `Unknown command: ${name}` };
  }
}
