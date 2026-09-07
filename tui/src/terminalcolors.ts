const ESC = "\x1b[";
export type TerminalColorLevel = "truecolor" | "256" | "16";
const LEVELS = [0, 95, 135, 175, 215, 255] as const;
// Match Exocortex's nearest-palette conversion, including bright-black gray.
const ANSI_RGB = [
  [0, 0, 0], [205, 0, 0], [0, 205, 0], [205, 205, 0],
  [0, 0, 238], [205, 0, 205], [0, 205, 205], [229, 229, 229],
  [127, 127, 127], [255, 0, 0], [0, 255, 0], [255, 255, 0],
  [92, 92, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
] as const;
const distance = (r: number, g: number, b: number, pr: number, pg: number, pb: number) =>
  (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;

function nearest(value: number): number {
  let best = 0;
  for (let i = 1; i < LEVELS.length; i++) {
    if (Math.abs(LEVELS[i]! - value) < Math.abs(LEVELS[best]! - value)) best = i;
  }
  return best;
}

function xterm(r: number, g: number, b: number): number {
  const ri = nearest(r), gi = nearest(g), bi = nearest(b);
  const cube = 16 + 36 * ri + 6 * gi + bi;
  // Neutral colors benefit from the gray ramp; keep chromatic dark blues blue.
  if (Math.max(r, g, b) - Math.min(r, g, b) > 12) return cube;
  const grayIndex = Math.max(0, Math.min(23, Math.round(((r + g + b) / 3 - 8) / 10)));
  const gray = 8 + grayIndex * 10;
  return distance(r, g, b, gray, gray, gray) < distance(r, g, b, LEVELS[ri]!, LEVELS[gi]!, LEVELS[bi]!)
    ? 232 + grayIndex : cube;
}

function ansi16(kind: 38 | 48, r: number, g: number, b: number): string {
  let index = 0, best = Infinity;
  for (const [i, [pr, pg, pb]] of ANSI_RGB.entries()) {
    const dist = distance(r, g, b, pr, pg, pb);
    if (dist < best) { best = dist; index = i; }
  }
  const base = kind === 38 ? (index < 8 ? 30 : 90) : (index < 8 ? 40 : 100);
  return `${ESC}${base + index % 8}m`;
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
