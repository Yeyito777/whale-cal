import { expect, test } from "bun:test";
import { createEditor, createState, editorDraft, settleEditorSave, type EditorState } from "./state";
import { inputWindow, width, wrapText } from "./text";
import { focusPrompt } from "./focus";

function fixture() {
  const state = createState();
  state.database.calendars = [{ id: "personal", name: "Personal", visible: true, color: "#1d9bf0", createdAt: "", updatedAt: "" }];
  state.selectedDate = "2026-09-15";
  state.editor = createEditor(state);
  state.editor.fields[0]!.value = "A draft that must not disappear";
  return state;
}
function set(editor: EditorState, key: string, value: string) { editor.fields.find(field => field.key === key)!.value = value; }

test("editor validates dates and times before sending a save", () => {
  const state = fixture();
  const editor = state.editor!;
  set(editor, "startTime", "1");
  expect(() => editorDraft(state, editor)).toThrow("HH:MM");
  set(editor, "startTime", "14:00"); set(editor, "endTime", "13:00");
  expect(() => editorDraft(state, editor)).toThrow("after");
  set(editor, "endTime", "15:00"); set(editor, "startDate", "2026-02-30");
  expect(() => editorDraft(state, editor)).toThrow("real date");
  set(editor, "startDate", "2026-09-15"); set(editor, "endDate", "2026-09-14");
  expect(() => editorDraft(state, editor)).toThrow("before");
  expect(state.editor).toBe(editor);
  expect(editor.fields[0]!.value).toContain("must not disappear");
});

test("only an acknowledged editor save closes the draft and opens the saved day", () => {
  const state = fixture();
  focusPrompt(state, "/search unfinished");
  const event = { ...editorDraft(state, state.editor!), calendarId: "personal", endDate: "2026-09-15", id: "saved", createdAt: "", updatedAt: "" };
  state.database.events.push(event);
  state.editor!.saving = "request-1";
  settleEditorSave(state, "unrelated", event);
  expect(state.editor).not.toBeNull();
  settleEditorSave(state, "request-1", event);
  expect(state.editor).toBeNull();
  expect(state.dayOpen).toBe(true);
  expect(state.selectedEventIndex).toBe(0);
  expect(state.mainFocus).toBe("calendar");
  expect(state.focus).toBe("calendar");
  expect(state.prompt!.text).toBe("/search unfinished");
});

test("editing a recurring event keeps the inspected occurrence date", () => {
  const state = fixture();
  const event = { id: "repeat", title: "Weekly", calendarId: "personal", startDate: "2026-09-01", endDate: "2026-09-01", recurrence: { frequency: "weekly" as const, interval: 1 }, createdAt: "", updatedAt: "" };
  state.database.events = [event];
  state.editor = createEditor(state, event);
  state.editor.saving = "request";
  state.editor.saveDate = "2026-09-15";
  settleEditorSave(state, "request", event);
  expect(state.selectedDate).toBe("2026-09-15");
});

test("long Unicode fields scroll to the cursor without splitting graphemes", () => {
  const text = "A title 東京 👩‍💻 more words here";
  const window = inputWindow(text, text.length, 12);
  expect(window.column).toBeLessThan(12);
  expect(width(window.text)).toBeLessThanOrEqual(12);
  expect(window.text).toEndWith("here");
  expect(width("👩‍💻")).toBe(2);
});

test("notes wrap rather than truncate, retaining paragraphs", () => {
  const lines = wrapText("First paragraph with more words.\n\n東京 👩‍💻 second paragraph.", 16);
  expect(lines).toContain("");
  expect(lines.join(" ")).toContain("second");
  expect(lines.every(line => width(line) <= 16)).toBe(true);
});

test("single-day dates stay linked, but explicit multi-day end dates are preserved", () => {
  const state = fixture();
  set(state.editor!, "startDate", "2026-09-17");
  expect(editorDraft(state, state.editor!).endDate).toBe("2026-09-17");
  set(state.editor!, "endDate", "2026-09-20");
  set(state.editor!, "startDate", "2026-09-18");
  expect(editorDraft(state, state.editor!).endDate).toBe("2026-09-20");
});
