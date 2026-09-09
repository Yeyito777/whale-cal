import { addDays, todayKey } from "@whale-cal/shared/dates";
import { COMMANDS } from "./commands";
import { loadSshAliases } from "./ssh-aliases";
import type { AppState, PromptState } from "./state";

export interface CompletionItem { label: string; description: string; value: string; cursor: number }
export interface CompletionState { items: CompletionItem[]; selection: number }

export function commandCompletions(text: string, cursor: number, state: AppState, aliases = loadSshAliases): CompletionItem[] {
  const before = text.slice(0, cursor);
  if (!before.startsWith("/")) return [];
  const moveGroup = /^\/group move .+ ->\s*/i.exec(before);
  if (moveGroup) {
    const start = moveGroup[0].length, fragment = before.slice(start).toLowerCase();
    return (state.database.groups ?? []).filter(group => group.name.toLowerCase().startsWith(fragment)).map(group => ({ label: group.name, description: "Destination group", value: text.slice(0, start) + group.name, cursor: start + group.name.length }));
  }
  let start = 0, end = text.indexOf(" ");
  if (end < 0) end = text.length;
  let fragment = before;
  let options: ReadonlyArray<readonly [string, string]> = COMMANDS;
  if (/^\/\S+\s/.test(before)) {
    const providers: Array<[string, () => ReadonlyArray<readonly [string, string]>]> = [
      ["/group move ", () => state.database.calendars.map(c => [c.name + " -> ", "Move calendar into a group"] as const)],
      ["/group ungroup ", () => state.database.calendars.filter(c => c.groupId).map(c => [c.name, "Remove from group"] as const)],
      ["/group rename ", () => (state.database.groups ?? []).map(g => [g.name + " -> ", "Rename group"] as const)],
      ["/group delete ", () => (state.database.groups ?? []).map(g => [g.name, "Remove group; preserve calendars"] as const)],
      ["/group ", () => [["new", "Create group"], ["move", "Move calendar into group"], ["ungroup", "Remove calendar from group"], ["rename", "Rename group"], ["delete", "Remove group; preserve calendars"]]],
      ["/calendar toggle ", () => state.database.calendars.map(c => [c.name, c.visible ? "Visible calendar" : "Hidden calendar"] as const)],
      ["/calendar ", () => [["new", "Create a calendar"], ["toggle", "Show or hide a calendar"]]],
      ["/view ", () => [["month", "Month grid"], ["week", "Week overview"], ["agenda", "Upcoming events"]]],
      ["/ssh ", () => [...aliases().map(alias => [alias, "SSH calendar daemon"] as const), ["cancel", "Return to local calendar"]]],
      ["/goto ", () => [...new Set([state.selectedDate, todayKey(), addDays(todayKey(), 1)])].map(date => [date, "Jump to date"] as const)],
      ["/new ", () => [["today", "New event today"], ["tomorrow", "New event tomorrow"], ...["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map(day => [day, "New event on this weekday"] as const)]],
      ["/deadline ", () => [["today", "Due today"], ["tomorrow", "Due tomorrow"], ...["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map(day => [day, "Due on this weekday"] as const)]],
      ["/search ", () => [...new Set(state.database.events.map(e => e.title))].map(title => [title, "Find event"] as const)],
    ];
    const provider = providers.find(([prefix]) => before.toLowerCase().startsWith(prefix));
    if (!provider) return [];
    start = provider[0].length;
    fragment = before.slice(start);
    options = provider[1]();
    end = provider[0] === "/calendar toggle " || provider[0] === "/search " || provider[0].startsWith("/group ") && provider[0] !== "/group " ? text.length : text.indexOf(" ", start);
    if (end < 0) end = text.length;
  }
  return options.filter(([label]) => label.toLowerCase().startsWith(fragment.toLowerCase())).map(([label, description]) => {
    const suffix = text.slice(end);
    const replacement = label;
    return { label, description, value: text.slice(0, start) + replacement + suffix, cursor: start + replacement.length };
  });
}

export function refreshCompletion(prompt: PromptState, state: AppState): void {
  if (prompt.mode !== "insert") { prompt.completion = null; prompt.completionText = undefined; return; }
  if (prompt.completionText === prompt.text && prompt.completionCursor === prompt.cursor) return;
  prompt.completionText = prompt.text;
  prompt.completionCursor = prompt.cursor;
  const items = commandCompletions(prompt.text, prompt.cursor, state);
  prompt.completion = items.length ? { items, selection: -1 } : null;
}

export function cycleCompletion(prompt: PromptState, amount: number): boolean {
  const menu = prompt.completion;
  if (!menu?.items.length) return false;
  menu.selection = menu.selection < 0 ? (amount > 0 ? 0 : menu.items.length - 1)
    : (menu.selection + amount + menu.items.length) % menu.items.length;
  const item = menu.items[menu.selection]!;
  prompt.text = item.value; prompt.cursor = item.cursor;
  prompt.completionText = prompt.text; prompt.completionCursor = prompt.cursor;
  return true;
}
