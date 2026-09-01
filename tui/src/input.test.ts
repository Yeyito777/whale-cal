import { describe, expect, test } from "bun:test";
import { InputBuffer, parseInput } from "./input";

describe("terminal input", () => {
  test("parses Vim characters, controls, and arrows", () => {
    expect(parseInput("jk\x13\x1b[A")).toEqual([
      { type: "char", char: "j" }, { type: "char", char: "k" }, { type: "ctrl-s" }, { type: "up" },
    ]);
  });

  test("preserves Kitty release events so callers do not type twice", () => {
    expect(parseInput("\x1b[110;1:3u")).toEqual([{ type: "char", char: "n", event: "release" }]);
  });

  test("distinguishes Ctrl+Shift+R through the Kitty keyboard protocol", () => {
    expect(parseInput("\x1b[114;6u")).toEqual([{ type: "ctrl-shift-r", event: "press" }]);
  });

  test("keeps multiline bracketed paste as one event", () => {
    expect(parseInput("\x1b[200~one\ntwo\x1b[201~")).toEqual([{ type: "paste", text: "one\ntwo" }]);
  });

  test("buffers a paste split across terminal chunks", () => {
    const buffer = new InputBuffer();
    expect(buffer.feed(Buffer.from("\x1b[200~one"))).toBeNull();
    expect(buffer.feed(Buffer.from("two\x1b[201~"))).toBe("\x1b[200~onetwo\x1b[201~");
  });
});
