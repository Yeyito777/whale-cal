import { connect } from "node:net";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { pidPath, runtimeDir, socketPath, isWindows } from "@whale-cal/shared/paths";
import { DAEMON_RESTART_EXIT_CODE } from "@whale-cal/shared/lifecycle";
import { DaemonServer } from "./server";
import { CalendarStore } from "./store";
import { createHandler } from "./handler";
import { runIpcProxy } from "./ipc-proxy";
import { log } from "./log";
import { CalendarHttpServer } from "./http-server";
import { Auth } from "./auth";

const SOCKET = socketPath();
const PID = pidPath();
if (!isWindows) process.umask(0o077);

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
    let alive = false;
    let pid = 0;
    try {
      pid = Number(readFileSync(PID, "utf8"));
      if (Number.isInteger(pid) && pid > 0) { process.kill(pid, 0); alive = true; }
      else throw new Error("invalid pid");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") alive = true;
    }
    if (alive) throw new Error(`PID ${pid} is live but the calendar socket did not respond. Refusing to replace it; inspect ${PID} before removing a stale PID file.`);
    try { unlinkSync(PID); } catch { /* stale */ }
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
  writeFileSync(PID, String(process.pid), { mode: 0o600, flag: "wx" });
  const store = new CalendarStore();
  process.env.TZ = store.snapshot().timeZone;
  let handler: ReturnType<typeof createHandler> | null = null;
  const server = new DaemonServer(SOCKET, (client, command) => handler?.(client, command), process.env.CAL_SOCKET_AUTH === "required");
  const auth = new Auth(store.persistence.sql);
  const authorizeSockets = () => server.authorizeSubscribers(client => {
    if (client.trustedLocal || !client.principal) return true;
    try { auth.authenticate(client.token ?? ""); return true; } catch { return false; }
  });
  const originalBroadcast = server.broadcast.bind(server);
  server.broadcast = (event, exclude) => { authorizeSockets(); originalBroadcast(event, exclude); };
  const authTimer = setInterval(authorizeSockets, 15_000);
  let http: CalendarHttpServer | null = null;
  let stopping = false;
  const stop = async (code = 0) => {
    if (stopping) return;
    stopping = true;
    server.broadcast({ type: "daemon_shutdown" });
    clearInterval(authTimer);
    http?.stop();
    await server.stop();
    store.persistence.close();
    try { unlinkSync(PID); } catch { /* best effort */ }
    process.exit(code);
  };
  handler = createHandler(server, store, { requestRestart: () => void stop(DAEMON_RESTART_EXIT_CODE) });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => void stop());
  process.on("uncaughtException", error => { log("error", error.stack ?? error.message); void stop(1); });
  process.on("unhandledRejection", error => { log("error", String(error)); void stop(1); });
  process.on("exit", () => { try { unlinkSync(PID); } catch { /* best effort */ } });
  await server.start();
  if (process.env.CAL_HTTP_PORT) {
    const port = Number(process.env.CAL_HTTP_PORT);
    const host = process.env.CAL_HTTP_HOST ?? "127.0.0.1";
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("CAL_HTTP_PORT must be 0–65535.");
    if (!["127.0.0.1", "::1", "localhost"].includes(host)) {
      throw new Error("The HTTP API must bind to loopback. Expose HTTPS through a reverse proxy instead.");
    }
    http = new CalendarHttpServer(store, server, { requestRestart: () => void stop(DAEMON_RESTART_EXIT_CODE) });
    http.start(port, host);
    log("info", `HTTP API listening on ${host}:${http.port}`);
  }
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
