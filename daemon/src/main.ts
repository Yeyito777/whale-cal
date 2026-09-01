import { connect } from "node:net";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { pidPath, runtimeDir, socketPath, isWindows } from "@whale-cal/shared/paths";
import { DAEMON_RESTART_EXIT_CODE } from "@whale-cal/shared/lifecycle";
import { DaemonServer } from "./server";
import { CalendarStore } from "./store";
import { createHandler } from "./handler";
import { runIpcProxy } from "./ipc-proxy";
import { log } from "./log";

const SOCKET = socketPath();
const PID = pidPath();

function probe(timeoutMs = 700): Promise<boolean> {
  if (!isWindows && !existsSync(SOCKET)) return Promise.resolve(false);
  return new Promise(resolve => {
    const socket = connect(SOCKET);
    let buffer = "";
    let done = false;
    const finish = (result: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once("connect", () => socket.write(`${JSON.stringify({ type: "probe", reqId: "status" })}\n`));
    socket.on("data", chunk => {
      buffer += chunk.toString("utf8");
      if (buffer.includes("\n")) {
        try { finish(JSON.parse(buffer.slice(0, buffer.indexOf("\n"))).type === "pong"); }
        catch { finish(false); }
      }
    });
    socket.once("error", () => finish(false));
  });
}

async function alreadyRunning(): Promise<boolean> {
  if (await probe()) return true;
  if (existsSync(PID)) {
    try {
      const pid = Number(readFileSync(PID, "utf8"));
      if (Number.isInteger(pid) && pid > 0) process.kill(pid, 0);
      else throw new Error("invalid pid");
    } catch {
      try { unlinkSync(PID); } catch { /* stale */ }
    }
  }
  if (!isWindows && existsSync(SOCKET)) {
    try { unlinkSync(SOCKET); } catch { /* stale */ }
  }
  return false;
}

async function start(): Promise<void> {
  mkdirSync(runtimeDir(), { recursive: true });
  if (await alreadyRunning()) {
    console.error("cald is already running");
    process.exit(1);
  }
  writeFileSync(PID, String(process.pid), { mode: 0o600 });
  const store = new CalendarStore();
  let handler: ReturnType<typeof createHandler> | null = null;
  const server = new DaemonServer(SOCKET, (client, command) => handler?.(client, command));
  let stopping = false;
  const stop = async (code = 0) => {
    if (stopping) return;
    stopping = true;
    server.broadcast({ type: "daemon_shutdown" });
    await server.stop();
    try { unlinkSync(PID); } catch { /* best effort */ }
    process.exit(code);
  };
  handler = createHandler(server, store, { requestRestart: () => void stop(DAEMON_RESTART_EXIT_CODE) });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => void stop());
  process.on("uncaughtException", error => { log("error", error.stack ?? error.message); void stop(1); });
  process.on("unhandledRejection", error => { log("error", String(error)); void stop(1); });
  process.on("exit", () => { try { unlinkSync(PID); } catch { /* best effort */ } });
  await server.start();
  log("info", `cald: started pid=${process.pid}`);
}

const command = process.argv[2];
if (command === "proxy") {
  runIpcProxy(SOCKET).catch(error => { console.error(error.message); process.exit(1); });
} else if (command === "status") {
  probe().then(running => {
    console.log(running ? `cald is running (${SOCKET})` : "cald is not running");
    process.exit(running ? 0 : 1);
  });
} else if (command) {
  console.error(`Unknown cald command: ${command}`);
  process.exit(2);
} else {
  start().catch(error => { console.error(`cald: ${error.message}`); process.exit(1); });
}
