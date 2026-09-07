import { expect, test } from "bun:test";
import { createState } from "./state";
import { buildFrame } from "./render";
import { nextEvent } from "./statusline";
import { theme } from "./theme";
import { runCommand } from "./commands";

function fixture() {
  const state = createState();
  Object.assign(state, { selectedDate: "2026-09-09", cols: 120, rows: 36, notice: null });
  state.database.calendars = [{ id: "work", name: "Work", visible: true, color: "#1d9bf0", createdAt: "", updatedAt: "" }];
  state.database.events = [{ id: "task", title: "Completed homework", calendarId: "work", startDate: "2026-09-09", endDate: "2026-09-09", startTime: "10:00", endTime: "11:00", completed: true, createdAt: "", updatedAt: "" }];
  return state;
}

test("done items are crossed out in month, week, agenda and day views", () => {
  for (const view of ["month", "week", "agenda"] as const) {
    const state = fixture(); state.view = view;
    const text = buildFrame(state).rows.join("\n");
    expect(text).toContain(theme.strike);
    expect(text).toContain(theme.strikeOff);
    expect(text).toContain("✓");
  }
  const state = fixture(); state.dayOpen = true;
  const text = buildFrame(state).rows.join("\n");
  expect(text).toContain(theme.strike + "Completed homework" + theme.strikeOff);
  expect(text).toContain("✓ Completed");
  expect(state.layout.actions.some(a => a.action === "complete")).toBe(true);
  expect(text).toContain("Reopen");
  state.database.events[0]!.completed = false;
  expect(buildFrame(state).rows.join("\n")).not.toContain(theme.strike);
  expect(runCommand("/done", state)).toEqual({ type: "complete", completed: true });
  expect(runCommand("/undone", state)).toEqual({ type: "complete", completed: false });
});

test("only the completed recurring date is crossed out and skipped by next-event status", () => {
  const state = fixture(); const event = state.database.events[0]!;
  event.completed = false;
  event.recurrence = { frequency: "weekly", interval: 1, count: 3 };
  event.completedDates = ["2026-09-09"];
  state.dayOpen = true;
  expect(buildFrame(state).rows.join("\n")).toContain(theme.strike);
  state.selectedDate = "2026-09-16";
  expect(buildFrame(state).rows.join("\n")).not.toContain(theme.strike);
  const now = new Date("2026-09-09T09:00:00").getTime();
  expect(nextEvent([event], now)?.date).toBe("2026-09-16");
  event.completedDates = ["2026-09-09", "2026-09-16", "2026-09-23"];
  expect(nextEvent([event], now)).toBeNull();
  delete event.recurrence; event.completed = true;
  expect(nextEvent([event], now)).toBeNull();
});
