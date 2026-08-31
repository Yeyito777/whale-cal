import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { logPath } from "@whale-cal/shared/paths";

export function log(level: "info" | "warn" | "error", message: string): void {
  if (process.env.CAL_DISABLE_FILE_LOG === "1") return;
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}\n`;
  try {
    mkdirSync(dirname(logPath()), { recursive: true });
    appendFileSync(logPath(), line);
  } catch {
    if (level === "error") console.error(line.trim());
  }
}
