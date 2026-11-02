import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { sshControlPath } from "./ssh-mux";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
/** Under /tmp: macOS's own temp dir is too long to hold a control socket. */
function scratch(): string {
  const root = mkdtempSync("/tmp/sshmux-");
  roots.push(root);
  return root;
}

describe("SSH control sockets", () => {
  test("live per alias in a private directory under the runtime dir", () => {
    const runtime = join(scratch(), "rt");
    expect(sshControlPath("whale", runtime, [scratch()])).toBe(join(runtime, "ssh", "whale.sock"));
    expect(statSync(join(runtime, "ssh")).mode & 0o777).toBe(0o700);
  });

  test("a runtime path too long for a Unix socket moves to a private per-user temp directory", () => {
    const runtime = join(scratch(), "a-very-long-worktree-name".repeat(4), "config", "runtime");
    const temp = scratch();
    const path = sshControlPath("whale", runtime, [temp])!;
    expect(path.startsWith(temp)).toBe(true);
    expect(Buffer.byteLength(path)).toBeLessThanOrEqual(80);
    expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
    // Distinct per alias and per runtime directory.
    expect(sshControlPath("box", runtime, [temp])).not.toBe(path);
    expect(sshControlPath("whale", `${runtime}2`, [temp])).not.toBe(path);
  });

  test("a temp dir too long for the socket falls through to the next", () => {
    const runtime = join(scratch(), "a-very-long-worktree-name".repeat(4), "config", "runtime");
    const long = join(scratch(), "x".repeat(60)), short = scratch();
    expect(sshControlPath("whale", runtime, [long, short])!.startsWith(short)).toBe(true);
    expect(sshControlPath("whale", runtime, [long])).toBeNull();
  });

  test("a directory with spaces, which ssh_config can't take unquoted, also moves", () => {
    const temp = scratch();
    expect(sshControlPath("whale", join(scratch(), "with space"), [temp])!.startsWith(temp)).toBe(true);
  });
});
