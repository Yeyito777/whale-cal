/**
 * Connection reuse for /ssh and --ssh: every session to an alias shares one
 * OpenSSH connection through a private ControlMaster socket, kept for
 * SSH_CONTROL_PERSIST after its last session, so a later launch or reconnect
 * skips the handshake (most of a cold start).
 *
 * The socket lives in `<runtime>/ssh/` (mode 0700), or a private per-user
 * directory under the system temp dir (or /tmp, as macOS's is itself long)
 * when that path is too long for a Unix socket. Anything running as this user can open sessions through it without
 * authenticating while it exists — which that user could already do with the
 * same SSH keys and agent. See README.md#connection-reuse.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeDir } from "@whale-cal/shared/paths";
import { spawnSshProxy, type SshConnectionReuse, type SshConnector, type SshFallback, type SshProcess } from "./ssh-transport";

export const SSH_CONTROL_PERSIST = "10m";
/** A session through an existing master without a pong by then also tries a fresh connection. */
export const SSH_MASTER_FALLBACK_MS = 2_500;
/**
 * ssh binds the master at the path plus a 17-character temporary suffix and
 * renames it; sun_path holds 104 bytes on macOS.
 */
const MAX_CONTROL_PATH_BYTES = 80;

/** A directory only this user can enter, or null when it can't be made so. */
function privateDirectory(path: string): string | null {
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const info = lstatSync(path);
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (!info.isDirectory() || (uid !== null && info.uid !== uid)) return null;
    if ((info.mode & 0o077) !== 0) chmodSync(path, 0o700);
    return path;
  } catch {
    return null;
  }
}

const usable = (path: string) => Buffer.byteLength(path) <= MAX_CONTROL_PATH_BYTES && !/[\s"'\\]/.test(path);

/** The private control socket for `alias`, or null to connect without reuse. */
export function sshControlPath(alias: string, runtime = runtimeDir(), temps = [tmpdir(), "/tmp"]): string | null {
  if (process.platform === "win32") return null;
  const preferred = join(runtime, "ssh", `${alias}.sock`);
  if (usable(preferred)) return privateDirectory(join(runtime, "ssh")) ? preferred : null;
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  const name = createHash("sha256").update(`${runtime}\0${alias}`).digest("hex").slice(0, 16);
  for (const temp of temps) {
    const directory = join(temp, `whale-cal-ssh-${uid}`);
    const path = join(directory, `${name}.sock`);
    if (usable(path) && privateDirectory(directory)) return path;
  }
  return null;
}

function reuseFor(alias: string): SshConnectionReuse | null {
  const controlPath = sshControlPath(alias);
  return controlPath ? { controlPath, persist: SSH_CONTROL_PERSIST } : null;
}

/** Sessions spawned onto a master that already existed (it may have lost its connection). */
const viaExistingMaster = new WeakSet<SshProcess>();

/** `ssh ALIAS cald proxy` through this alias's shared connection, creating it if needed. */
export function spawnReusingSshProxy(alias: string): SshProcess {
  const reuse = reuseFor(alias);
  const existing = reuse !== null && existsSync(reuse.controlPath);
  const process = spawnSshProxy(alias, reuse ?? undefined);
  if (existing) viaExistingMaster.add(process);
  return process;
}

/** Ask this alias's master to exit; its sessions close. Fire and forget. */
export function closeSshMaster(alias: string): void {
  const controlPath = sshControlPath(alias);
  if (!controlPath || !existsSync(controlPath)) return;
  try {
    const child = spawn("ssh", ["-o", `ControlPath=${controlPath.replaceAll("%", "%%")}`, "-O", "exit", alias], {
      stdio: "ignore", detached: true, windowsHide: true,
    });
    child.on("error", () => {});
    child.unref();
  } catch { /* nothing to close */ }
}

/**
 * For a session riding an existing master: a fresh, unshared connection after
 * SSH_MASTER_FALLBACK_MS. A master whose own connection died (a laptop that
 * slept) accepts sessions that never answer until its keepalive gives up. When
 * the fresh one wins, the old master is told to exit so the next connection
 * makes a healthy one.
 */
export function sshProbeFallback(alias: string, primary: SshProcess): SshFallback | null {
  if (!viaExistingMaster.has(primary)) return null;
  return {
    afterMs: SSH_MASTER_FALLBACK_MS,
    spawn: target => spawnSshProxy(target),
    onUsed: () => closeSshMaster(alias),
  };
}

/** Shared connections, with the early `--ssh` launch process handed to the first session. */
export function reusingSshConnector(takeEarly: (alias: string) => SshProcess | null = () => null): SshConnector {
  return {
    spawn: alias => takeEarly(alias) ?? spawnReusingSshProxy(alias),
    fallback: sshProbeFallback,
  };
}
