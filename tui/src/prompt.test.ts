import { expect, test } from "bun:test";
import { commandCompletions, refreshCompletion } from "./completion";
import { PromptController } from "./prompt";
import { createState, type PromptState } from "./state";
import type { KeyType } from "./input";
import { buildFrame } from "./render";

function editor(text: string, mode: "normal" | "insert" = "insert") {
  const state = createState();
  const p: PromptState = { text, cursor: mode === "insert" ? text.length : 0, mode };
  state.prompt = p;
  const controller = new PromptController();
  const key = (type: KeyType) => controller.handle(p, { type }, state);
  const chars = (text: string) => { for (const char of text) controller.handle(p, { type: "char", char }, state); };
  return { state, p, controller, key, chars };
}

test("slash popup appears immediately and cycles live previews both ways", () => {
  const { state, p, key } = editor("/");
  refreshCompletion(p, state);
  expect(p.completion!.items.length).toBeGreaterThan(5);
  key("tab"); expect(p.text).toBe("/help");
  key("tab"); expect(p.text).toBe("/today");
  key("backtab"); expect(p.text).toBe("/help");
  key("up"); expect(p.text).toBe("/quit");
  key("escape"); expect(p.mode).toBe("normal"); expect(p.text).toBe("/quit"); expect(p.completion).toBeNull();
});

test("argument completion follows command completion without losing the argument", () => {
  const { p, key, chars } = editor("/vi");
  key("tab"); expect(p.text).toBe("/view");
  chars(" "); key("tab"); expect(p.text).toBe("/view month");
  key("down"); expect(p.text).toBe("/view week");
  expect(key("enter")).toBe("submit");
});

test("calendar names with spaces, subcommands, SSH aliases, and mid-token completion", () => {
  const state = createState();
  state.database.calendars = [{ id: "demo", name: "Whale Cal Demo", color: "#fff", visible: true, createdAt: "", updatedAt: "" }];
  expect(commandCompletions("/calendar t", 11, state)[0]!.value).toBe("/calendar toggle");
  const text = "/calendar toggle Whale";
  expect(commandCompletions(text, text.length, state)[0]!.value).toBe("/calendar toggle Whale Cal Demo");
  expect(commandCompletions("/ssh ho", 7, state, () => ["home", "host"])).toHaveLength(2);
  expect(commandCompletions("/viw week", 3, state)[0]!.value).toBe("/view week");
});

test("history restores an unfinished draft and is distinct from popup selection", () => {
  const { p, key, controller, state } = editor("/today");
  key("enter");
  const draft: PromptState = { text: "/search unfinished", cursor: 18, mode: "insert" };
  controller.handle(draft, { type: "ctrl-p" }, state);
  expect(draft.text).toBe(p.text);
  controller.handle(draft, { type: "ctrl-n" }, state);
  expect(draft.text).toBe("/search unfinished");
});

test("normal operators, counts, text objects, yank, undo and redo", () => {
  const { p, chars, key } = editor("one two three", "normal");
  chars("2dw"); expect(p.text).toBe("three");
  chars("u"); expect(p.text).toBe("one two three");
  key("ctrl-r"); expect(p.text).toBe("three");
  chars("ciw"); expect(p.text).toBe(""); expect(p.mode).toBe("insert");
  chars("new"); key("escape"); chars("0yy$p"); expect(p.text).toBe("newnew");
});

test("visual deletion, find, and replacement use grapheme-safe editing", () => {
  const { p, chars } = editor("A👩‍💻B C", "normal");
  chars("lvld"); expect(p.text).toBe("A C");
  chars("0fCrZ"); expect(p.text).toBe("A Z");
});

test("insert line/word deletion and yank restore work with Unicode", () => {
  const { p, key } = editor("hello 東京");
  key("ctrl-w"); expect(p.text).toBe("hello ");
  key("ctrl-y"); expect(p.text).toBe("hello 東京");
  key("ctrl-a"); key("ctrl-k"); expect(p.text).toBe("");
  key("ctrl-y"); expect(p.text).toBe("hello 東京");
});

test("operator counts multiply and change-word preserves the following space", () => {
  const e = editor("one two three four five six seven", "normal");
  e.chars("2d3w"); expect(e.p.text).toBe("seven");
  const c = editor("one two", "normal");
  c.chars("cwNEW"); expect(c.p.text).toBe("NEW two");
});

test("simple delimiter objects and line motions work in normal mode", () => {
  const e = editor("prefix (inside) suffix", "normal");
  e.chars("f(lci("); expect(e.p.text).toBe("prefix () suffix");
  expect(e.p.mode).toBe("insert");
  e.key("escape"); e.chars("Ggg"); expect(e.p.cursor).toBe(0);
});

test("completion popup keeps prompt, status and mouse targets separate", () => {
  const { state } = editor("/");
  state.cols = 54; state.rows = 18;
  const frame = buildFrame(state);
  expect(frame.rows).toHaveLength(18);
  expect(frame.rows[15]).toContain("❯");
  expect(frame.rows[16]).toContain("Next Event:");
  expect(frame.rows[17]).toContain("Happens in:");
  expect(state.layout.actions.filter(hit => hit.action.startsWith("complete:")).every(hit => hit.row < 15)).toBe(true);
  expect(frame.cursor).toContain("16;");
});
