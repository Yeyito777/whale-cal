import { isDateKey } from "@whale-cal/shared/dates";
import { parseQuickAdd } from "@whale-cal/shared/quick-add";
import type { CalendarView, EventDraft } from "@whale-cal/shared/types";
import type { AppState } from "./state";

export type CommandAction =
  | { type: "none" }
  | { type: "quit" }
  | { type: "help" }
  | { type: "today" }
  | { type: "goto"; date: string }
  | { type: "view"; view: CalendarView }
  | { type: "new"; draft?: EventDraft }
  | { type: "edit" }
  | { type: "delete" }
  | { type: "ssh_status" }
  | { type: "ssh_connect"; alias: string }
  | { type: "ssh_cancel" }
  | { type: "reload" }
  | { type: "calendar_new"; name: string; color?: string }
  | { type: "calendar_toggle"; name: string }
  | { type: "search"; query: string }
  | { type: "error"; message: string };

export const COMMANDS = [
  ["/help", "show keys and commands"], ["/today", "jump to today"], ["/goto", "select YYYY-MM-DD"],
  ["/view", "month, week, or agenda"], ["/new", "quick-create an event"], ["/edit", "edit selected event"],
  ["/delete", "delete selected event"], ["/search", "find an event"], ["/calendar", "new/toggle calendars"],
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
      if (!(["month", "week", "agenda"] as string[]).includes(args[0] ?? "")) return { type: "error", message: "Usage: /view month|week|agenda" };
      return { type: "view", view: args[0] as CalendarView };
    case "/new":
      if (!rest) return { type: "new" };
      try { return { type: "new", draft: parseQuickAdd(rest, { selectedDate: state.selectedDate }) }; }
      catch (error) { return { type: "error", message: error instanceof Error ? error.message : String(error) }; }
    case "/edit": return { type: "edit" };
    case "/delete": return { type: "delete" };
    case "/reload": return { type: "reload" };
    case "/search":
      if (!rest) return { type: "error", message: "Usage: /search words" };
      return { type: "search", query: rest };
    case "/ssh":
      if (!args[0]) return { type: "ssh_status" };
      if (args.length > 1) return { type: "error", message: "Usage: /ssh [alias|cancel]" };
      return args[0]!.toLowerCase() === "cancel" ? { type: "ssh_cancel" } : { type: "ssh_connect", alias: args[0]! };
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
