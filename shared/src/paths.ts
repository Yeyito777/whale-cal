import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

function detectRepoRoot(): string {
  if (process.platform !== "win32" || /^bun(?:\.exe)?$/i.test(basename(process.execPath))) {
    return resolve(import.meta.dir, "../..");
  }
  return dirname(process.execPath || process.argv[0] || process.cwd());
}

const REPO_ROOT = detectRepoRoot();
const CONFIG_ROOT = process.env.CAL_CONFIG_DIR?.trim()
  ? resolve(process.env.CAL_CONFIG_DIR)
  : join(REPO_ROOT, "config");

export const isWindows = process.platform === "win32";

export function repoRoot(): string { return REPO_ROOT; }
export function configDir(): string { return CONFIG_ROOT; }
export function dataDir(): string { return join(CONFIG_ROOT, "data"); }
export function runtimeDir(): string { return join(CONFIG_ROOT, "runtime"); }
export function databasePath(): string { return join(dataDir(), "calendar.json"); }
export function pidPath(): string { return join(runtimeDir(), "cald.pid"); }
export function logPath(): string { return join(runtimeDir(), "cald.log"); }

export function socketPath(): string {
  if (isWindows) return "\\\\.\\pipe\\whale-cald";
  const candidate = join(runtimeDir(), "cald.sock");
  if (Buffer.byteLength(candidate) < 104) return candidate;
  const digest = createHash("sha256").update(candidate).digest("hex").slice(0, 16);
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return join(tmpdir(), `cald-${uid}-${digest}.sock`);
}
