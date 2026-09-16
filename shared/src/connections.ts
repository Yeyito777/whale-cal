import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { configDir, socketPath } from "./paths";
import type { Command, Event } from "./protocol";

export interface ConnectionProfile {
  name: string;
  url?: string;
  socket?: string;
  token?: string;
}
interface StoredProfile { url?: string; socket?: string; tokenEnv?: string; tokenFile?: string }

/** Shared by TUI and CLI. Explicit remote failures never select a local fallback. */
export function connectionProfile(name = process.env.CAL_PROFILE || undefined): ConnectionProfile {
  let config: { defaultProfile?: string; profiles?: Record<string, StoredProfile> } = {};
  const file = join(configDir(), "connections.json");
  if (existsSync(file)) config = JSON.parse(readFileSync(file, "utf8"));
  const selected = name ?? (process.env.CAL_SERVER_URL ? undefined : config.defaultProfile) ?? "local";
  let stored: StoredProfile;
  if (!name && process.env.CAL_SERVER_URL) stored = { url: process.env.CAL_SERVER_URL, tokenFile: process.env.CAL_TOKEN_FILE };
  else if (selected === "local") stored = config.profiles?.local ?? { socket: socketPath(), tokenFile: process.env.CAL_TOKEN_FILE };
  else {
    if (!config.profiles || !Object.hasOwn(config.profiles, selected)) throw new Error(`Unknown calendar profile: ${selected}`);
    stored = config.profiles[selected]!;
  }
  if (stored.url && stored.socket) throw new Error("A profile cannot select both HTTP and a local socket.");
  const tokenFile = stored.tokenFile && (isAbsolute(stored.tokenFile) ? stored.tokenFile : resolve(configDir(), stored.tokenFile));
  const token = tokenFile ? readFileSync(tokenFile, "utf8").trim() : process.env[stored.tokenEnv ?? "CAL_TOKEN"]?.trim();
  if (!stored.url) return { name: selected, socket: stored.socket ? resolve(configDir(), stored.socket) : socketPath(), token };
  const url = new URL(stored.url);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Server URL must be an HTTP(S) origin without credentials, query, or path.");
  }
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && process.env.CAL_ALLOW_INSECURE_HTTP !== "1") {
    throw new Error("Remote calendar connections require HTTPS (CAL_ALLOW_INSECURE_HTTP=1 is only for deliberate private-network testing).");
  }
  if (!token) throw new Error("Remote calendar requires a token: configure tokenFile/tokenEnv or CAL_TOKEN.");
  return { name: name ?? (process.env.CAL_SERVER_URL ? url.origin : selected), url: url.origin, token };
}

export async function httpRequest(profile: ConnectionProfile, command: Command | Record<string, unknown>, timeoutMs = 5_000): Promise<Event> {
  const response = await fetch(`${profile.url}/v1/commands`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
    headers: { Authorization: `Bearer ${profile.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  const event = await response.json() as Event;
  if (!response.ok && event.type !== "error") throw new Error(`Calendar server returned HTTP ${response.status}.`);
  return event;
}

/** Parse the server's one-data-line SSE events, including split UTF-8 chunks. */
export async function consumeChanges(profile: ConnectionProfile, signal: AbortSignal, receive: (event: Event) => void, ready: () => void): Promise<void> {
  const response = await fetch(`${profile.url}/v1/changes`, {
    redirect: "error", signal, headers: { Authorization: `Bearer ${profile.token}` },
  });
  if (!response.ok || !response.body) throw new Error(`Calendar live connection failed (HTTP ${response.status}).`);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = "";
  ready();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 16_777_216) throw new Error("Calendar update too large.");
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trimEnd(); buffer = buffer.slice(newline + 1);
        if (line.startsWith("data: ")) receive(JSON.parse(line.slice(6)) as Event);
      }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
