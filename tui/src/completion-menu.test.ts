import { expect, test } from "bun:test";
import { completionMenu } from "./completion-menu";
import { commandCompletions } from "./completion";
import { createState } from "./state";
import { buildFrame } from "./render";
import { theme } from "./theme";
import { stripAnsi, width } from "./text";

const items = Array.from({ length: 30 }, (_, i) => ({ label: `/cmd${String(i).padStart(2, "0")}`, description: `Description ${i}`, value: `/cmd${i}`, cursor: 6 }));

test("uses Exocortex's borderless ten-row menu, anchored directly above the prompt separator", () => {
  const state = createState();
  const popup = completionMenu({ items: commandCompletions("/", 1, state), selection: -1 }, 110, 28);
  expect(popup.rows).toHaveLength(10);
  expect(popup.top).toBe(18);
  expect(popup.width).toBeLessThan(60);
  const plain = popup.rows.map(stripAnsi);
  expect(plain[0]).toStartWith("  /help");
  expect(plain.at(-1)).toEndWith(" ▼");
  expect(plain.join("\n")).not.toMatch(/[┌┐└┘│]/);
  expect(plain.join("\n")).not.toContain("Suggestions");
  expect(popup.rows[0]).toStartWith(theme.sidebarBg + theme.accent);
  expect(popup.rows[0]).toContain(theme.dim);
  expect(popup.rows.every(row => width(row) === popup.width)).toBe(true);
});

test("centers the selected candidate and uses accent marker, selection background and edge arrows", () => {
  const popup = completionMenu({ items, selection: 15 }, 80, 25);
  expect(popup.start).toBe(10);
  expect(stripAnsi(popup.rows[0]!)).toEndWith(" ▲");
  expect(stripAnsi(popup.rows.at(-1)!)).toEndWith(" ▼");
  expect(stripAnsi(popup.rows[5]!)).toStartWith("▸ /cmd15");
  expect(popup.rows[5]).toStartWith(theme.sidebarSelBg + theme.accent + "▸ " + theme.text);
});

test("sizes argument menus to their contents, handles narrow windows and sanitizes control characters", () => {
  const state = createState();
  const menu = { items: commandCompletions("/view ", 6, state), selection: 0 };
  const popup = completionMenu(menu, 100, 20);
  expect(popup.rows).toHaveLength(4);
  expect(popup.top).toBe(16);
  expect(popup.width).toBeLessThan(40);
  for (const columns of [16, 54, 80]) {
    const narrow = completionMenu({ items: [{ label: "東京👩‍💻\nexample", description: "tab\tand\x1bcontrol", value: "", cursor: 0 }], selection: 0 }, columns, 12);
    expect(narrow.rows.every(row => width(row) <= columns - 2)).toBe(true);
    expect(stripAnsi(narrow.rows[0]!)).not.toMatch(/[\n\t\x1b]/);
  }
});

test("mouse targets align with the borderless menu while the footer remains intact", () => {
  const state = createState();
  state.cols = 80; state.rows = 24;
  state.notice = null;
  state.prompt = { text: "/", cursor: 1, mode: "insert" };
  state.mainFocus = "prompt";
  const frame = buildFrame(state);
  const hits = state.layout.actions.filter(hit => hit.action.startsWith("complete:"));
  expect(hits).toHaveLength(10);
  expect(hits.every(hit => hit.left === 1)).toBe(true);
  expect(hits.at(-1)!.row).toBe(19);
  expect(stripAnsi(frame.rows[19]!)).toBe("─".repeat(80));
  expect(stripAnsi(frame.rows[20]!)).toContain("I ❯ /");
  expect(stripAnsi(frame.rows[21]!)).toBe("─".repeat(80));
  expect(stripAnsi(frame.rows[22]!)).toContain("Next Event:");
});
