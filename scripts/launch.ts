import { spawn } from "node:child_process";
import { connect } from "node:net";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { isWindows, socketPath } from "../shared/src/paths";
import { offerEarlySshProcess } from "../tui/src/early-ssh";
import { LAUNCH_USAGE, parseLaunchArgs, type LaunchOptions } from "../tui/src/launch-args";
import { spawnReusingSshProxy } from "../tui/src/ssh-mux";

const root = resolve(import.meta.dir, "..");

function probe(timeoutMs = 350): Promise<boolean> {
  const path = socketPath();
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
    socket.once("connect", () => socket.write(`${JSON.stringify({ type: "probe", reqId: "launcher" })}\n`));
    socket.on("data", chunk => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try { finish(JSON.parse(buffer.slice(0, newline)).type === "pong"); } catch { finish(false); }
    });
    socket.once("error", () => finish(false));
  });
}

async function ensureDaemon(): Promise<void> {
  if (await probe()) return;
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

const args = process.argv.slice(2);
let launch: LaunchOptions;
try { launch = parseLaunchArgs(args); }
catch (error) {
  console.error(`whale-cal: ${error instanceof Error ? error.message : String(error)}\n\n${LAUNCH_USAGE}`);
  process.exit(2);
}
if (launch.showHelp) { console.log(LAUNCH_USAGE); process.exit(0); }
if (launch.sshAlias) {
  // SSH starts before the TUI's modules load, so its handshake overlaps them.
  offerEarlySshProcess(launch.sshAlias, spawnReusingSshProxy(launch.sshAlias));
  // The local daemon is only the fallback for a failed or cancelled switch: never wait for it.
  ensureDaemon().catch(() => {});
} else await ensureDaemon();
// In-process: a second Bun runtime would only add its startup to every launch.
await import("../tui/src/main");
