import { describe, expect, test } from "bun:test";
import { buildFrame } from "./render";
import { createEditor, createState } from "./state";
import { stripAnsi, width } from "./text";

function fixture(cols = 120, rows = 36) {
  const state = createState();
  Object.assign(state, { cols, rows, connected: true, notice: null, selectedDate: "2026-09-15" });
  state.database.calendars = [{ id: "work", name: "Work", color: "#c792ea", visible: true, createdAt: "", updatedAt: "" }];
  state.database.events = Array.from({ length: 24 }, (_, i) => ({
    id: `event-${i}`, title: `Event ${String(i).padStart(2, "0")}`, calendarId: "work", startDate: "2026-09-15", endDate: "2026-09-15",
    startTime: `${String(i).padStart(2, "0")}:00`, notes: "A long note with real paragraphs.\n\n" + "Readable details with 東京 and 👩‍💻. ".repeat(40), createdAt: "", updatedAt: "",
  }));
  return state;
}

// Simulate the absolute-column overlays used by the retained terminal frame.
function painted(line: string): string {
  const cells: string[] = [];
  let column = 0;
  for (const token of line.split(/(\x1b\[[0-?]*[ -/]*[@-~])/)) {
    const move = /^\x1b\[(\d+)G$/.exec(token);
    if (move) { column = Number(move[1]) - 1; continue; }
    if (token.startsWith("\x1b")) continue;
    for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(token)) {
      if (cells[column] === "" && column > 0) cells[column - 1] = " ";
      if (width(cells[column] ?? "") === 2) cells[column + 1] = " ";
      cells[column++] = segment;
      if (width(segment) === 2) cells[column++] = "";
    }
  }
  return cells.join("");
}

describe("calendar layouts", () => {
  test("month uses complete grid, five weeks for September, and preserves overflow counts", () => {
    const state = fixture();
    const frame = buildFrame(state);
    expect(state.layout.monthCells).toHaveLength(35);
    expect(frame.rows.some(row => stripAnsi(row).includes("┼"))).toBe(true);
    expect(frame.rows.some(row => stripAnsi(row).includes("more"))).toBe(true);
    expect(frame.rows.every(row => width(row) <= state.cols)).toBe(true);
    expect(stripAnsi(frame.rows[0]!)).toContain("synced");
    expect(stripAnsi(frame.rows.at(-1)!)).not.toContain("synced");
  });

  for (const [cols, rows] of [[54, 18], [80, 24], [120, 36], [160, 48]] as const) {
    test(`day and editor fit ${cols}×${rows} and expose clickable targets`, () => {
      const state = fixture(cols, rows);
      state.dayOpen = true;
      state.selectedEventIndex = 23;
      let frame = buildFrame(state);
      expect(frame.rows).toHaveLength(rows);
      expect(state.layout.eventRows.some(hit => hit.index === 23)).toBe(true);
      expect(frame.rows.map(painted).join("\n")).toContain("Event 23");
      expect(frame.rows.map(painted).every(row => width(row) <= cols)).toBe(true);
      state.detailScroll = 10000;
      buildFrame(state);
      expect(state.detailScroll).toBeLessThan(10000);
      state.editor = createEditor(state, state.database.events[23]);
      state.editor.cursor = state.editor.fields[0]!.value.length;
      frame = buildFrame(state);
      const screen = frame.rows.map(painted);
      expect(screen.every(row => width(row) <= cols)).toBe(true);
      expect(screen.join("\n")).not.toContain("INSERT");
      expect(screen.join("\n")).toContain("Save");
      expect(screen.at(-2)).toContain("Next Event:");
      expect(screen.at(-1)).toContain("Happens in:");
      expect(screen.at(-3)).toBe("─".repeat(cols));
      expect(screen.at(-4)).toContain("❯");
      expect(screen.at(-5)).toBe("─".repeat(cols));
      expect(state.layout.actions.some(hit => hit.action === "save")).toBe(true);
      expect(state.layout.editorFields.every(hit => hit.row < rows - 1)).toBe(true);
      expect(frame.cursor).toContain("H");
    });
  }

  test("empty day is readable without opening an editor", () => {
    const state = fixture();
    state.database.events = [];
    state.dayOpen = true;
    const text = buildFrame(state).rows.map(painted).join("\n");
    expect(text).toContain("Nothing scheduled");
    expect(state.editor).toBeNull();
  });

  test("tiny terminals have a safe resize screen and no stale hit targets", () => {
    const state = fixture(32, 8);
    state.editor = createEditor(state);
    const frame = buildFrame(state);
    expect(frame.rows).toHaveLength(8);
    expect(frame.rows.every(row => width(row) <= 32)).toBe(true);
    expect(state.layout.actions).toEqual([]);
  });
});
