import { spawn } from "node:child_process";
import { connect } from "node:net";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { isWindows, socketPath } from "../shared/src/paths";
import { connectionProfile } from "../shared/src/connections";

const root = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
if (args[0] === "--profile") {
  if (!args[1] || args.length !== 2) throw new Error("Usage: whale-cal [--profile NAME]");
  process.env.CAL_PROFILE = args[1];
} else if (args.length) throw new Error("Usage: whale-cal [--profile NAME]");
const profile = connectionProfile();

function probe(timeoutMs = 350): Promise<boolean> {
  const path = profile.socket ?? socketPath();
  if (!isWindows && !existsSync(path)) return Promise.resolve(false);
  return new Promise(resolveProbe => {
    const socket = connect(path);
    let buffer = "", done = false;
    const finish = (result: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolveProbe(result);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once("connect", () => {
      if (profile.token) socket.write(JSON.stringify({ type: "authenticate", reqId: "launcher-auth", token: profile.token }) + "\n");
      socket.write(`${JSON.stringify({ type: "probe", reqId: "launcher" })}\n`);
    });
    socket.on("data", chunk => {
      buffer += chunk.toString();
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try { const event = JSON.parse(line); if (event.reqId === "launcher") finish(event.type === "pong"); } catch { finish(false); }
      }
    });
    socket.once("error", () => finish(false));
  });
}

async function ensureDaemon(): Promise<void> {
  if (await probe()) return;
  if (profile.socket && profile.socket !== socketPath()) throw new Error("Configured socket is unavailable; refusing to start a different daemon.");
  const daemon = spawn(process.execPath, [resolve(root, "scripts/supervise-daemon.ts")], {
    detached: true, stdio: "ignore", cwd: root,
  });
  daemon.unref();
  for (let attempt = 0; attempt < 40; attempt++) {
    await Bun.sleep(50);
    if (await probe()) return;
  }
  throw new Error("cald did not become ready; inspect config/runtime/cald.log");
}

if (!profile.url) await ensureDaemon();
const tui = spawn(process.execPath, [resolve(root, "tui/src/main.ts")], { stdio: "inherit", cwd: root });
tui.once("exit", code => process.exit(code ?? 0));
tui.once("error", error => { console.error(error.message); process.exit(1); });
