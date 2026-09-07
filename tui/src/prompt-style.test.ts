import { afterEach, beforeEach, expect, test } from "bun:test";
import { commandRange, stylePromptText } from "./prompt-style";
import { createEditor, createState, type PromptState } from "./state";
import { focusCalendar, focusPrompt, handleFocusKey } from "./focus";
import { buildFrame } from "./render";
import { inputWindow, stripAnsi, width } from "./text";
import { theme } from "./theme";

// Headless runners may collapse distinct Whale colors to the same ANSI-16
// color. Exercise the real RGB palette so semantic color assertions are useful.
const originalTheme = { ...theme };
beforeEach(() => Object.assign(theme, {
  text: "\x1b[38;2;255;255;255m", command: "\x1b[38;2;174;214;254m",
  muted: "\x1b[38;2;100;100;100m", accent: "\x1b[38;2;29;155;240m",
  vimNormal: "\x1b[38;2;72;202;228m", vimInsert: "\x1b[38;2;46;196;182m",
  borderUnfocused: "\x1b[38;2;85;85;85m", selectionBg: "\x1b[48;2;79;82;88m",
  appBg: "\x1b[48;2;0;5;15m",
}));
afterEach(() => Object.assign(theme, originalTheme));

function styled(text: string, focused = true) {
  const p: PromptState = { text, cursor: text.length, mode: "insert" };
  return stylePromptText(p, { text, start: 0 }, focused);
}

test("ordinary prompt text is explicitly white, with only recognized commands highlighted", () => {
  expect(styled("Lunch with Maya")).toContain(theme.text + "Lunch with Maya");
  expect(styled("Lunch with Maya")).not.toContain(theme.command);
  expect(styled("/search Lunch with Maya")).toContain(theme.command + "/search" + theme.text + " Lunch with Maya");
  expect(styled("/new tomorrow Lunch")).toContain(theme.command + "/new" + theme.text + " tomorrow Lunch");
  for (const text of ["/not-a-command", "/tod", "https://example.com", "Meet /today", "notes /search text"]) {
    expect(commandRange(text)).toBeNull();
    expect(styled(text)).not.toContain(theme.command);
  }
});

test("command aliases and subcommands follow parser case rules; free-form arguments stay white", () => {
  for (const text of ["/q", "/exit", "/h", "/HELP"]) expect(styled(text)).toContain(theme.command + text);
  expect(styled("/view week")).toContain(theme.command + "/view week");
  expect(styled("/view WEEK")).toContain(theme.command + "/view" + theme.text + " WEEK");
  expect(styled("  /calendar NEW Work")).toContain(theme.command + "/calendar NEW" + theme.text + " Work");
  expect(styled("/ssh whale")).toContain(theme.command + "/ssh" + theme.text + " whale");
});

test("unfocused drafts are muted, including commands and selections", () => {
  const p: PromptState = { text: "/search hello", cursor: 10, mode: "normal", selectionAnchor: 0 };
  expect(stylePromptText(p, { text: p.text, start: 0 }, false)).toBe(theme.muted + p.text);
});

test("Unicode scrolling and visual selection preserve syntax colors without background leakage", () => {
  const p: PromptState = { text: "/search 東京 👩‍💻 lunch", cursor: 8, mode: "normal", selectionAnchor: 2 };
  const window = { text: p.text.slice(3), start: 3 };
  const result = stylePromptText(p, window, true);
  expect(stripAnsi(result)).toBe(window.text);
  expect(result).toContain(theme.selectionBg + theme.command + "arch");
  expect(result).toContain(theme.text + " 東");
  expect(result).toEndWith(theme.appBg);
  p.cursor = p.text.length;
  p.selectionAnchor = undefined;
  const scrolled = inputWindow(p.text, p.cursor, 12);
  const shown = stylePromptText(p, scrolled, true);
  expect(stripAnsi(shown)).toBe(scrolled.text);
  expect(shown).not.toContain(theme.command);
  expect(width(shown)).toBeLessThanOrEqual(12);
});

test("prompt borders, glyph, mode and text all reflect actual focus, including modal overlays", () => {
  const state = createState(); state.cols = 100; state.rows = 30; state.notice = null;
  const assertDisabled = () => {
    const frame = buildFrame(state);
    expect(frame.rows[25]).toContain(theme.borderUnfocused);
    expect(frame.rows[27]).toContain(theme.borderUnfocused);
    const line = frame.rows[26]!;
    expect(line).toContain(theme.muted);
    for (const color of [theme.accent, theme.command, theme.vimInsert, theme.vimNormal, theme.text, theme.selectionBg]) expect(line).not.toContain(color);
    expect(state.layout.actions.some(a => a.action.startsWith("complete:"))).toBe(false);
  };
  assertDisabled(); // Empty, inactive prompt.
  focusPrompt(state, "/search hello");
  let frame = buildFrame(state);
  expect(frame.rows[25]).toContain(theme.accent);
  expect(frame.rows[27]).toContain(theme.accent);
  expect(frame.rows[26]).toContain(theme.accent + "❯");
  expect(frame.rows[26]).toContain(theme.text + " hello");
  focusCalendar(state); assertDisabled();
  focusPrompt(state);
  handleFocusKey(state, { type: "ctrl-s" }); assertDisabled();
  handleFocusKey(state, { type: "ctrl-s" });
  frame = buildFrame(state);
  expect(frame.rows[26]).toContain(theme.vimNormal);
  state.editor = createEditor(state); assertDisabled();
  state.editor = null; state.helpOpen = true; assertDisabled();
  state.helpOpen = false;
  state.confirmDelete = { id: "e", calendarId: "c", title: "Event", startDate: state.selectedDate, endDate: state.selectedDate, createdAt: "", updatedAt: "" };
  assertDisabled();
});
