import { describe, expect, test } from "bun:test";
import { createState, cyclePanelFocus, exitPromptAndCycleFocus } from "./state";

describe("panel focus", () => {
  test("cycles between the calendar and a visible sidebar", () => {
    const state = createState();
    state.cols = 100;

    cyclePanelFocus(state);
    expect(state.focus).toBe("sidebar");
    cyclePanelFocus(state);
    expect(state.focus).toBe("calendar");
  });

  test("exits a normal-mode prompt and returns focus to the sidebar", () => {
    const state = createState();
    state.cols = 100;
    state.prompt = { text: "/today", cursor: 6, mode: "normal" };

    exitPromptAndCycleFocus(state);

    expect(state.prompt).toBeNull();
    expect(state.focus).toBe("sidebar");
  });

  test("exits the prompt without selecting a hidden sidebar", () => {
    const state = createState();
    state.sidebarOpen = false;
    state.prompt = { text: "/today", cursor: 6, mode: "normal" };

    exitPromptAndCycleFocus(state);

    expect(state.prompt).toBeNull();
    expect(state.focus).toBe("calendar");
  });
});
