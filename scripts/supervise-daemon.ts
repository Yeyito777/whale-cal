import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { DAEMON_RESTART_EXIT_CODE } from "../shared/src/lifecycle";

const root = resolve(import.meta.dir, "..");
const daemon = resolve(root, "daemon/src/main.ts");
const daemonArgs = process.argv.slice(2);
const restartable = daemonArgs.length === 0;
let child: ChildProcess | null = null;
let stopping = false;

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    stopping = true;
    child?.kill(signal);
  });
}

async function runDaemon(): Promise<number> {
  child = spawn(process.execPath, [daemon, ...daemonArgs], { cwd: root, env: process.env, stdio: "inherit" });
  const exitCode = await new Promise<number>(resolveExit => {
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      resolveExit(code);
    };
    child!.once("exit", code => finish(code ?? 1));
    child!.once("error", () => finish(1));
  });
  child = null;
  return exitCode;
}

while (!stopping) {
  const exitCode = await runDaemon();
  if (stopping) process.exit(0);
  if (!restartable || exitCode !== DAEMON_RESTART_EXIT_CODE) process.exit(exitCode);
  await Bun.sleep(50);
}
