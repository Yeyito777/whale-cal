const ESC = "\x1b[";
export type TerminalColorLevel = "truecolor" | "256" | "16";
const LEVELS = [0, 95, 135, 175, 215, 255] as const;

function nearest(value: number): number {
  let best = 0;
  for (let i = 1; i < LEVELS.length; i++) {
    if (Math.abs(LEVELS[i]! - value) < Math.abs(LEVELS[best]! - value)) best = i;
  }
  return best;
}

function xterm(r: number, g: number, b: number): number {
  const ri = nearest(r), gi = nearest(g), bi = nearest(b);
  return 16 + 36 * ri + 6 * gi + bi;
}

function ansi16(kind: 38 | 48, r: number, g: number, b: number): string {
  const bright = Math.max(r, g, b) > 180;
  const index = (r > 100 ? 1 : 0) | (g > 100 ? 2 : 0) | (b > 100 ? 4 : 0);
  const base = kind === 38 ? (bright ? 90 : 30) : (bright ? 100 : 40);
  // ANSI's bit ordering is red=1, green=2, blue=4.
  return `${ESC}${base + index}m`;
}

export function detectColorLevel(): TerminalColorLevel {
  const forced = process.env.CAL_TUI_COLOR?.toLowerCase();
  if (["truecolor", "24bit", "3"].includes(forced ?? "")) return "truecolor";
  if (["256", "2"].includes(forced ?? "")) return "256";
  if (["16", "1"].includes(forced ?? "")) return "16";
  const term = (process.env.TERM ?? "").toLowerCase();
  const color = (process.env.COLORTERM ?? "").toLowerCase();
  if (color.includes("truecolor") || color.includes("24bit") || /(kitty|wezterm|foot|alacritty|ghostty|st)/.test(term)) return "truecolor";
  if (term.includes("256")) return "256";
  return "16";
}

export function color(kind: 38 | 48, hex: string, level = detectColorLevel()): string {
  const value = hex.replace(/^#/, "");
  const r = parseInt(value.slice(0, 2), 16), g = parseInt(value.slice(2, 4), 16), b = parseInt(value.slice(4, 6), 16);
  if (level === "truecolor") return `${ESC}${kind};2;${r};${g};${b}m`;
  if (level === "256") return `${ESC}${kind};5;${xterm(r, g, b)}m`;
  return ansi16(kind, r, g, b);
}
