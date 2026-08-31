import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadSshAliases } from "./ssh-aliases";

let root: string | null = null;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = null; });

test("discovers concrete aliases through Include", () => {
  root = mkdtempSync(join(tmpdir(), "whale-cal-ssh-"));
  mkdirSync(join(root, "parts"));
  writeFileSync(join(root, "config"), "Host home *.wild !blocked\nInclude parts/*.conf\n");
  writeFileSync(join(root, "parts/work.conf"), "Host work\n  HostName example.test\n");
  expect(loadSshAliases([join(root, "config")], root)).toEqual(["home", "work"]);
});
