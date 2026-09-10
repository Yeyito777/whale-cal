import { expect, test } from "bun:test";
import { todayKey } from "@whale-cal/shared/dates";
import { createState, moveDeadlineSelection, setDeadlineFilter } from "./state";
import { buildFrame } from "./render";
import { handleDeadlineScroll, revealDeadline, type DeadlineListViewport } from "./deadline-scroll";
import type { KeyType } from "./input";

function fixture() {
  const s = createState(); s.view = "deadlines"; s.cols = 120; s.rows = 24; s.notice = null;
  s.database.calendars = [{ id: "work", name: "Work", visible: true, color: "#1d9bf0", createdAt: "", updatedAt: "" }];
  s.database.events = Array.from({ length: 40 }, (_, i) => ({ id: String(i), title: `Task ${String(i).padStart(2, "0")}`, kind: "deadline" as const, calendarId: "work", startDate: todayKey(), endDate: todayKey(), createdAt: "", updatedAt: "" }));
  return s;
}

const viewport: DeadlineListViewport = { height: 10, total: 31, entries: Array.from({ length: 15 }, (_, index) => ({ index, key: String(index), top: index * 2 + 1, bottom: index * 2 + 2, revealTop: index === 0 ? 0 : index * 2 + 1 })) };
function scrollState() {
  const s = createState(); s.layout.deadlineList = viewport; s.deadlineIndex = 2; s.deadlineSelectedKey = "2";
  return s;
}

test("normal deadline navigation waits for the bottom edge and doesn't bounce back on the way up", () => {
  const s = fixture(); buildFrame(s);
  const view = s.layout.deadlineList!;
  const last = view.entries.filter(entry => entry.bottom < view.height).at(-1)!;
  for (let index = 1; index <= last.index; index++) {
    moveDeadlineSelection(s, 1); buildFrame(s);
    expect(s.deadlineScroll).toBe(0);
  }
  moveDeadlineSelection(s, 1); buildFrame(s);
  const selected = s.layout.deadlineList!.entries[s.deadlineIndex]!;
  expect(s.deadlineScroll).toBe(selected.bottom - view.height + 1);
  const start = s.deadlineScroll;
  moveDeadlineSelection(s, -1); buildFrame(s);
  expect(s.deadlineScroll).toBe(start);
  buildFrame(s); expect(s.deadlineScroll).toBe(start);
  moveDeadlineSelection(s, -1000); buildFrame(s);
  expect(s.deadlineScroll).toBe(0); // first section heading is visible too
});

test("Ctrl+E/Y scroll a line while selection sticks to its item until it would leave the viewport", () => {
  const s = scrollState();
  expect(handleDeadlineScroll(s, { type: "ctrl-e" })).toBe(true);
  expect(s.deadlineScroll).toBe(1); expect(s.deadlineIndex).toBe(2);
  for (let i = 0; i < 5; i++) handleDeadlineScroll(s, { type: "ctrl-e" });
  expect(s.deadlineScroll).toBe(6); expect(s.deadlineIndex).toBe(3);
  handleDeadlineScroll(s, { type: "ctrl-y" });
  expect(s.deadlineScroll).toBe(5); expect(s.deadlineIndex).toBe(3);
});

test("Ctrl+D/U move selection with half a viewport; Ctrl+F/B overlap two rows and select a page edge", () => {
  const s = scrollState();
  handleDeadlineScroll(s, { type: "ctrl-d" });
  expect(s.deadlineScroll).toBe(5); expect(s.deadlineIndex).toBe(5);
  handleDeadlineScroll(s, { type: "ctrl-u" });
  expect(s.deadlineScroll).toBe(0); expect(s.deadlineIndex).toBe(2);
  handleDeadlineScroll(s, { type: "ctrl-f" });
  expect(s.deadlineScroll).toBe(8); expect(s.deadlineIndex).toBe(4);
  handleDeadlineScroll(s, { type: "ctrl-b" });
  expect(s.deadlineScroll).toBe(0); expect(s.deadlineIndex).toBe(3);
});

test("control scrolling survives rendering, skips headings and keeps complete selected entries visible", () => {
  const s = fixture(); buildFrame(s);
  for (const key of ["ctrl-e", "ctrl-d", "ctrl-f", "ctrl-f", "ctrl-y", "ctrl-u", "ctrl-b"] as KeyType[]) {
    handleDeadlineScroll(s, { type: key });
    const start = s.deadlineScroll;
    buildFrame(s);
    expect(s.deadlineScroll).toBe(start);
    const view = s.layout.deadlineList!, selected = view.entries[s.deadlineIndex]!;
    expect(selected.top).toBeGreaterThanOrEqual(start);
    expect(selected.bottom).toBeLessThan(start + view.height);
    expect(s.layout.eventRows.filter(hit => hit.index === s.deadlineIndex)).toHaveLength(2);
  }
});

test("filters, resize, empty lists and repeated boundary scrolling clamp without stale offsets", () => {
  const s = fixture(); buildFrame(s);
  for (let i = 0; i < 100; i++) handleDeadlineScroll(s, { type: "ctrl-f" });
  buildFrame(s);
  expect(s.deadlineScroll).toBe(s.layout.deadlineList!.total - s.layout.deadlineList!.height);
  s.rows = 120; buildFrame(s); expect(s.deadlineScroll).toBe(0);
  setDeadlineFilter(s, "completed"); buildFrame(s);
  expect(s.deadlineScroll).toBe(0);
  expect(handleDeadlineScroll(s, { type: "ctrl-b" })).toBe(true);
  expect(handleDeadlineScroll(s, { type: "char", char: "j" })).toBe(false);
  expect(revealDeadline(999, { height: 10, total: 0, entries: [] }, 0)).toBe(0);
});
