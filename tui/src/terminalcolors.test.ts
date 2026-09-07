import { expect, test } from "bun:test";
import { color } from "./terminalcolors";

test("ANSI-16 keeps Whale's muted foreground and inactive borders visible", () => {
  expect(color(38, "#646464", "16")).toBe("\x1b[90m");
  expect(color(38, "#555555", "16")).toBe("\x1b[90m");
  expect(color(38, "#ffffff", "16")).toBe("\x1b[97m");
  expect(color(48, "#00050f", "16")).toBe("\x1b[40m");
  expect(color(48, "#4f5258", "16")).toBe("\x1b[100m");
});

test("256-color gray ramp preserves muted contrast without graying out dark blues", () => {
  expect(color(38, "#646464", "256")).toBe("\x1b[38;5;241m");
  expect(color(38, "#555555", "256")).toBe("\x1b[38;5;240m");
  expect(color(48, "#090d35", "256")).toBe("\x1b[48;5;17m");
  expect(color(38, "#ffffff", "256")).toBe("\x1b[38;5;231m");
});

test("truecolor retains Whale's exact white and command blue", () => {
  expect(color(38, "#ffffff", "truecolor")).toBe("\x1b[38;2;255;255;255m");
  expect(color(38, "#aed6fe", "truecolor")).toBe("\x1b[38;2;174;214;254m");
});
