import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

export interface SshProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  readonly pid?: number;
  once(event: string, listener: (...args: any[]) => void): this;
  on(event: string, listener: (...args: any[]) => void): this;
  off(event: string, listener: (...args: any[]) => void): this;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface SshConnectionReuse {
  /** Private control socket for this alias (see ssh-mux.ts). */
  controlPath: string;
  /** How long the shared connection outlives its last session, e.g. "10m". */
  persist: string;
}

/** A fresh connection raced against a session whose shared master may be dead (see ssh-mux.ts). */
export interface SshFallback {
  /** Without a pong by then, the fresh connection starts (or at once if the first fails). */
  afterMs: number;
  spawn(alias: string): SshProcess;
  /** The fresh connection won. */
  onUsed?(): void;
}

/** How the client reaches `cald proxy` over SSH. */
export interface SshConnector {
  spawn(alias: string): SshProcess;
  fallback?(alias: string, primary: SshProcess): SshFallback | null;
}

/**
 * `ssh … ALIAS cald proxy`. With `reuse`, sessions share one connection through
 * a private ControlMaster socket, so a later connect skips OpenSSH's handshake;
 * otherwise every connection is fresh and never joins a master.
 */
export function sshProxyArgs(alias: string, reuse?: SshConnectionReuse): string[] {
  return [
    "-T", "-C", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
    // A suspended laptop can leave TCP apparently connected long after its
    // network is gone. Bound that silence so the reconnect loop runs instead
    // of waiting for the OS TCP timeout.
    "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
    // Never join a master whose keepalive policy we cannot control: either
    // none, or our own, created with the options above.
    ...(reuse
      ? ["-o", "ControlMaster=auto", "-o", `ControlPath=${reuse.controlPath.replaceAll("%", "%%")}`, "-o", `ControlPersist=${reuse.persist}`]
      : ["-o", "ControlPath=none"]),
    alias, "cald", "proxy",
  ];
}

export function spawnSshProxy(alias: string, reuse?: SshConnectionReuse): SshProcess {
  return spawn("ssh", sshProxyArgs(alias, reuse), { stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true });
}

export function validateSshAlias(alias: string): string | null {
  if (!alias) return "SSH alias cannot be empty.";
  if (alias.length > 255) return "SSH alias is too long.";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(alias)) return "SSH alias may contain only letters, numbers, dots, underscores, and hyphens.";
  return null;
}
