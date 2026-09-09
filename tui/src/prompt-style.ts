import { COMMANDS } from "./commands";
import type { PromptState } from "./state";
import { theme } from "./theme";

const commandNames = new Set<string>([...COMMANDS.map(([name]) => name), "/h", "/q", "/exit"]);
const subcommands: Record<string, readonly string[]> = {
  "/view": ["month", "week", "agenda", "deadlines"],
  "/calendar": ["new", "toggle"],
  "/group": ["new", "create", "move", "ungroup", "rename", "delete"],
  "/ssh": ["cancel"],
};

/** Only real commands at the start of the prompt, never titles, paths or URLs. */
export function commandRange(text: string): { start: number; end: number } | null {
  const match = /^(\s*)(\S+)(?:\s+(\S+))?/.exec(text);
  if (!match || !commandNames.has(match[2]!.toLowerCase())) return null;
  const start = match[1]!.length;
  let end = start + match[2]!.length;
  const arg = match[3];
  const name = match[2]!.toLowerCase();
  // /view arguments are case-sensitive in the command parser.
  if (arg && subcommands[name]?.includes(name === "/view" ? arg : arg.toLowerCase())) end = match[0].length;
  return { start, end };
}

/** Style a grapheme-safe visible window using offsets in the original draft. */
export function stylePromptText(prompt: PromptState, window: { text: string; start: number }, focused: boolean): string {
  if (!focused) return theme.muted + window.text;
  const command = commandRange(prompt.text);
  const selection = prompt.selectionAnchor === undefined ? null : {
    start: Math.min(prompt.selectionAnchor, prompt.cursor),
    end: Math.max(prompt.selectionAnchor, prompt.cursor),
  };
  let result = "", foreground = "", background = "";
  for (const item of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(window.text)) {
    const position = window.start + item.index;
    const fg = command && position >= command.start && position < command.end ? theme.command : theme.text;
    const bg = selection && position >= selection.start && position <= selection.end ? theme.selectionBg : theme.appBg;
    if (bg !== background) { result += bg; background = bg; }
    if (fg !== foreground) { result += fg; foreground = fg; }
    result += item.segment;
  }
  // Selection must not spill into the unused portion of the prompt row.
  return result + theme.appBg;
}
