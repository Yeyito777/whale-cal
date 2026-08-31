import { existsSync, globSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

function tokens(line: string): string[] {
  const output: string[] = [];
  let current = "", quote: "'" | '"' | null = null, escaped = false;
  for (const char of line) {
    if (escaped) { current += char; escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = null; else current += char; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === "#") break;
    if (/\s/.test(char)) {
      if (current) output.push(current);
      current = "";
    } else current += char;
  }
  if (current) output.push(current);
  return output;
}

function concrete(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && !/[*?\[\]]/.test(value);
}

export function loadSshAliases(configFiles?: string[], home = homedir()): string[] {
  const configured = process.env.CAL_SSH_CONFIG?.trim();
  const roots = configFiles ?? (configured ? [configured] : [join(home, ".ssh/config"), "/etc/ssh/ssh_config"]);
  const found = new Set<string>(), visited = new Set<string>();
  const expand = (value: string) => value === "~" ? home : value.startsWith("~/") ? join(home, value.slice(2)) : value;
  const read = (file: string) => {
    const expanded = expand(file);
    if (!existsSync(expanded)) return;
    let canonical: string;
    try { canonical = realpathSync(expanded); } catch { canonical = resolve(expanded); }
    if (visited.has(canonical)) return;
    visited.add(canonical);
    let text: string;
    try { text = readFileSync(canonical, "utf8"); } catch { return; }
    for (const line of text.split(/\r?\n/)) {
      const parts = tokens(line);
      if (parts.length < 2) continue;
      const keyword = parts[0]!.toLowerCase();
      if (keyword === "host") {
        for (const alias of parts.slice(1)) if (concrete(alias) && !alias.startsWith("!")) found.add(alias);
      } else if (keyword === "include") {
        for (const pattern of parts.slice(1)) {
          const expandedPattern = expand(pattern);
          const absolute = isAbsolute(expandedPattern) ? expandedPattern : resolve(dirname(canonical), expandedPattern);
          try {
            const files = /[*?\[\]{}]/.test(absolute) ? globSync(absolute).sort() : existsSync(absolute) ? [absolute] : [];
            for (const included of files) read(included);
          } catch { /* malformed include is ignored like OpenSSH */ }
        }
      }
    }
  };
  for (const root of roots) read(root);
  return [...found].sort((a, b) => a.localeCompare(b));
}
