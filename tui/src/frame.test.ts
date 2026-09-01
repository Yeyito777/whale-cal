import { expect, test } from "bun:test";
import { overlayAt } from "./frame";

test("row overlays retain the complete underlying row", () => {
  expect(overlayAt("calendar grid", 12, "event editor")).toBe("calendar grid\x1b[12Gevent editor");
});
