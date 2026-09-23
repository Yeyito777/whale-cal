import { describe, expect, test } from "bun:test";
import { createEditor, createState } from "./state";
import { cyclePanelFocus, focusPrompt, handleFocusKey, isPromptFocused } from "./focus";
import { buildFrame } from "./render";
import { PromptController } from "./prompt";
import { parseInput } from "./input";

function fixture() {
  const s = createState(); s.cols = 100; s.rows = 30; s.notice = null;
  return s;
}

describe("Exocortex-style focus", () => {
  test("starts with calendar focus and the optional sidebar closed", () => {
    const s = fixture();
    expect(s.sidebarOpen).toBe(false);
    expect(s.mainFocus).toBe("calendar");
  });

  for (const mode of ["normal", "insert"] as const) {
    for (const key of ["ctrl-j", "ctrl-k"] as const) {
      test(`${key} in ${mode} mode switches panels, preserves draft and inner focus`, () => {
        const s = fixture(); s.sidebarOpen = true;
        focusPrompt(s, "/today"); s.prompt!.mode = mode;
        const draft = s.prompt;
        handleFocusKey(s, { type: key });
        expect(s.focus).toBe("sidebar");
        expect(isPromptFocused(s)).toBe(false);
        expect(s.prompt).toBe(draft);
        expect(s.prompt!.text).toBe("/today");
        expect(s.prompt!.cursor).toBe(6);
        expect(s.prompt!.mode).toBe("normal");
        handleFocusKey(s, { type: key });
        expect(isPromptFocused(s)).toBe(true);
      });

      test(`${key} with sidebar hidden does not leave or erase the prompt`, () => {
        const s = fixture(); focusPrompt(s, "/today"); s.prompt!.mode = mode;
        handleFocusKey(s, { type: key });
        expect(isPromptFocused(s)).toBe(true);
        expect(s.prompt!.mode).toBe(mode);
      });
    }
  }

  test("panel cycling from calendar never enters prompt", () => {
    const s = fixture(); s.sidebarOpen = true;
    cyclePanelFocus(s); cyclePanelFocus(s);
    expect(s.mainFocus).toBe("calendar");
    expect(s.prompt).toBeNull();
  });

  test("Ctrl+N switches calendar/prompt and enters calendar from sidebar", () => {
    const s = fixture(); s.dayOpen = true;
    focusPrompt(s, "draft");
    handleFocusKey(s, { type: "ctrl-n" });
    expect(s.mainFocus).toBe("calendar");
    expect(s.dayOpen).toBe(true);
    handleFocusKey(s, { type: "ctrl-n" });
    expect(isPromptFocused(s)).toBe(true);
    expect(s.prompt!.mode).toBe("insert");
    expect(s.prompt!.text).toBe("draft");
    handleFocusKey(s, { type: "ctrl-s" });
    handleFocusKey(s, { type: "ctrl-n" });
    expect(s.focus).toBe("calendar");
    expect(s.mainFocus).toBe("calendar");
  });

  test("Ctrl+S is global in either prompt mode and restores main inner focus", () => {
    for (const mode of ["normal", "insert"] as const) {
      const s = fixture(); focusPrompt(s, "/"); s.prompt!.mode = mode;
      buildFrame(s);
      handleFocusKey(s, { type: "ctrl-s" });
      expect(s.sidebarOpen).toBe(true);
      expect(s.focus).toBe("sidebar");
      const frame = buildFrame(s);
      expect(s.layout.actions.some(a => a.action.startsWith("complete:"))).toBe(false);
      expect(frame.cursor).toContain("\x1b[?25l");
      handleFocusKey(s, { type: "ctrl-s" });
      expect(s.sidebarOpen).toBe(false);
      expect(isPromptFocused(s)).toBe(true);
      expect(s.prompt!.text).toBe("/");
    }
  });

  test("sidebar opens and cycles focus at any width, preserving the prompt across resize", () => {
    for (const cols of [1, 8, 32, 50, 60, 75, 76, 120]) {
      const s = fixture(); s.cols = cols; focusPrompt(s, "draft");
      s.database.calendars = [{ id: "personal", name: "Personal", color: "#1d9bf0", visible: true, createdAt: "", updatedAt: "" }];
      handleFocusKey(s, { type: "ctrl-s" });
      buildFrame(s);
      expect(s.focus).toBe("sidebar");
      expect(s.layout.sidebarWidth).toBeGreaterThan(0);
      expect(s.layout.sidebarWidth).toBeLessThanOrEqual(cols);
      expect(s.prompt!.text).toBe("draft");
      expect(s.layout.calendarRows.some(hit => hit.calendarId === "personal")).toBe(true);
      cyclePanelFocus(s);
      expect(isPromptFocused(s)).toBe(true);
      cyclePanelFocus(s);
      expect(s.focus).toBe("sidebar");
      s.cols = 40; buildFrame(s);
      expect(s.focus).toBe("sidebar");
      expect(s.layout.sidebarWidth).toBeGreaterThan(0);
      handleFocusKey(s, { type: "ctrl-s" }); buildFrame(s);
      expect(s.layout.sidebarWidth).toBe(0);
      expect(isPromptFocused(s)).toBe(true);
    }
  });

  test("short sidebars don't publish calendar hits over the prompt or footer", () => {
    const s = fixture(); s.cols = 40; s.rows = 8; s.sidebarOpen = true;
    s.database.calendars = [{ id: "personal", name: "Personal", color: "#1d9bf0", visible: true, createdAt: "", updatedAt: "" }];
    buildFrame(s);
    expect(s.layout.calendarRows).toEqual([]);
  });

  test("new-event shortcuts do not erase the prompt or navigate dates", () => {
    const s = fixture(); focusPrompt(s, "draft");
    const date = s.selectedDate;
    expect(handleFocusKey(s, { type: "ctrl-p" })).toBe("new");
    expect(handleFocusKey(s, { type: "ctrl-shift-o" })).toBe("new");
    expect(s.prompt!.text).toBe("draft");
    expect(s.selectedDate).toBe(date);
    expect(parseInput("\x1b[111;6u")[0]?.type).toBe("ctrl-shift-o");
  });

  test("modals retain exclusive key ownership", () => {
    for (const modal of ["help", "editor", "delete"]) {
      const s = fixture();
      if (modal === "help") s.helpOpen = true;
      if (modal === "editor") s.editor = createEditor(s);
      if (modal === "delete") s.confirmDelete = { id: "event", calendarId: "personal", title: "Event", startDate: s.selectedDate, endDate: s.selectedDate, createdAt: "", updatedAt: "" };
      for (const type of ["ctrl-s", "ctrl-j", "ctrl-k", "ctrl-n", "ctrl-p"] as const)
        expect(handleFocusKey(s, { type })).toBeNull();
      expect(s.sidebarOpen).toBe(false);
    }
  });

  test("paste focuses the preserved draft and focus changes cancel pending operators, not undo", () => {
    const s = fixture(); const controller = new PromptController();
    focusPrompt(s, "draft"); const p = s.prompt!;
    controller.handle(p, { type: "char", char: "!" }, s);
    controller.handle(p, { type: "escape" }, s);
    controller.handle(p, { type: "char", char: "d" }, s);
    handleFocusKey(s, { type: "ctrl-s" });
    handleFocusKey(s, { type: "ctrl-s" });
    controller.handle(p, { type: "char", char: "w" }, s);
    expect(p.text).toBe("draft!");
    controller.handle(p, { type: "char", char: "u" }, s);
    expect(p.text).toBe("draft");
    handleFocusKey(s, { type: "ctrl-n" });
    const paste = { type: "paste", text: " hello" } as const;
    handleFocusKey(s, paste);
    controller.handle(p, paste, s);
    expect(isPromptFocused(s)).toBe(true);
    expect(p.text).toContain(" hello");
  });
});
