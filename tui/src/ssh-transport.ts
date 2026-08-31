import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

export interface SshProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  once(event: string, listener: (...args: any[]) => void): this;
  on(event: string, listener: (...args: any[]) => void): this;
  off(event: string, listener: (...args: any[]) => void): this;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export function sshProxyArgs(alias: string): string[] {
  return ["-T", "-C", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", alias, "cald", "proxy"];
}

export function spawnSshProxy(alias: string): SshProcess {
  return spawn("ssh", sshProxyArgs(alias), { stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true });
}

export function validateSshAlias(alias: string): string | null {
  if (!alias) return "SSH alias cannot be empty.";
  if (alias.length > 255) return "SSH alias is too long.";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(alias)) return "SSH alias may contain only letters, numbers, dots, underscores, and hyphens.";
  return null;
}
