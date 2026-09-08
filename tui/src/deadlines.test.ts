import { expect, test } from "bun:test";
import { createEditor, createState, editorDraft, editorItemKind, setEditorItemKind } from "./state";
import { buildFrame } from "./render";
import { nextDeadline, renderStatusline } from "./statusline";
import { runCommand } from "./commands";
import { commandCompletions } from "./completion";
import { theme } from "./theme";
import { width } from "./text";

function fixture() {
  const state = createState();
  state.selectedDate = "2026-09-09"; state.cols = 120; state.rows = 36; state.notice = null;
  state.database.calendars = [{ id: "work", name: "Work", visible: true, color: "#1d9bf0", createdAt: "", updatedAt: "" }];
  state.database.events = [{ id: "due", kind: "deadline", title: "Submit quiz", calendarId: "work", startDate: "2026-09-09", endDate: "2026-09-09", startTime: "15:05", createdAt: "", updatedAt: "" }];
  return state;
}

test("deadline creation and quick-add expose an explicit type and reject time ranges", () => {
  const s = fixture();
  expect(runCommand("/deadline", s)).toEqual({ type: "new", kind: "deadline" });
  expect(runCommand("/deadline 2026-09-09 15:05 Submit quiz", s)).toMatchObject({ type: "new", draft: { kind: "deadline", startTime: "15:05", title: "Submit quiz" } });
  expect(runCommand("/deadline 15:00-16:00 Wrong", s).type).toBe("error");
  expect(commandCompletions("/dead", 5, s)[0]!.value).toBe("/deadline");
  expect(commandCompletions("/deadline tom", 13, s)[0]!.value).toBe("/deadline tomorrow");
});

test("editor type changes are reversible and hide irrelevant duration fields", () => {
  const s = fixture(); const editor = createEditor(s);
  editor.fields.find(f => f.key === "title")!.value = "Submit quiz";
  editor.fields.find(f => f.key === "startTime")!.value = "15:05";
  editor.fields.find(f => f.key === "endTime")!.value = "16:00";
  setEditorItemKind(editor, "deadline");
  expect(editorItemKind(editor)).toBe("deadline");
  expect(editor.fields.some(f => f.key === "endTime" || f.key === "endDate")).toBe(false);
  expect(editor.fields.find(f => f.key === "startTime")!.label).toBe("Due time");
  expect(editorDraft(s, editor)).toMatchObject({ kind: "deadline", startTime: "15:05", endDate: s.selectedDate });
  expect(editorDraft(s, editor).endTime).toBeUndefined();
  setEditorItemKind(editor, "event");
  expect(editorDraft(s, editor).endTime).toBe("16:00");
  const existing = createEditor(s, s.database.events[0]);
  expect(editorItemKind(existing)).toBe("deadline");
});

test("both editor types fit small terminals and scroll active fields above the prompt", () => {
  const s = fixture(); s.cols = 54; s.rows = 18;
  for (const kind of ["event", "deadline"] as const) {
    s.editor = createEditor(s); setEditorItemKind(s.editor, kind);
    for (let i = 0; i < s.editor.fields.length; i++) {
      s.editor.active = i;
      const frame = buildFrame(s);
      expect(s.layout.editorFields.some(f => f.index === i)).toBe(true);
      expect(s.layout.editorFields.every(f => f.row < 14)).toBe(true);
      expect(s.layout.actions.find(a => a.action === "save")!.row).toBeLessThan(14);
      expect(frame.rows[13]).not.toContain("│");
      expect(frame.rows[13]).toContain("─".repeat(54));
    }
  }
});

test("deadline rendering is distinct across views and does not warn about an unknown duration", () => {
  const s = fixture();
  for (const view of ["month", "week", "agenda"] as const) {
    s.view = view;
    const frame = buildFrame(s);
    expect(frame.rows.join("\n")).toContain("◆");
    expect(frame.rows.join("\n")).toContain("Due 15:05");
    expect(frame.rows.every(row => width(row) <= s.cols)).toBe(true);
  }
  s.dayOpen = true;
  let frame = buildFrame(s);
  expect(frame.rows.join("\n")).toContain("1 deadline · 24h free");
  expect(frame.rows.join("\n")).not.toContain("missing end time");
  expect(frame.rows.join("\n")).toContain("does not reserve time");
  s.database.events[0]!.completed = true;
  frame = buildFrame(s);
  expect(frame.rows.join("\n")).toContain(theme.strike);
  expect(frame.rows.join("\n")).not.toContain("Overdue");
});

test("next-event status respects due times, date-only day boundaries, recurrence and completion", () => {
  const s = fixture(); s.connected = true;
  const due = s.database.events[0]!;
  delete due.startTime;
  const noon = new Date("2026-09-09T12:00:00").getTime();
  expect(nextDeadline([due], noon)?.date).toBe("2026-09-09");
  const status = renderStatusline(s, noon).join("\n");
  expect(status).toContain("Next Deadline:"); expect(status).toContain("0d12h0m");
  due.recurrence = { frequency: "weekly", interval: 1, count: 3 };
  due.completedDates = ["2026-09-09"];
  expect(nextDeadline([due], noon)?.date).toBe("2026-09-16");
});
