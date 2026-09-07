/** Bright calendar accents on Whale's dark background, not a repeating cycle. */
export const CALENDAR_COLORS = [
  "#1d9bf0", "#c792ea", "#50c878", "#ff9f43", "#ff6b9d", "#48cae4",
  "#ff6b6b", "#f4d35e", "#2ec4b6", "#a5a6ff", "#b8de6f", "#ffb997",
  "#e879f9", "#80c7ff", "#f47c48", "#8be9bd", "#d6a2e8", "#a3cb38",
  "#f8a5c2", "#63cdda", "#e6cc80", "#cf8b67", "#f78fb3", "#9aafff",
] as const;

const rgb = (hex: string) => [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
const distance = (a: number[], b: number[]) => a.reduce((sum, channel, i) => sum + (channel - b[i]!) ** 2, 0);

function mostDistinct(candidates: readonly string[], used: Set<string>): string | undefined {
  const existing = [...used].filter(color => /^#[0-9a-f]{6}$/.test(color)).map(rgb);
  let best: string | undefined, score = -1;
  for (const candidate of candidates) {
    if (used.has(candidate)) continue;
    const value = rgb(candidate);
    const nearest = existing.length ? Math.min(...existing.map(other => distance(value, other))) : 0;
    if (nearest > score) { best = candidate; score = nearest; }
  }
  return best;
}

function hsl(hue: number, saturation: number, lightness: number): string {
  const amplitude = saturation * Math.min(lightness, 1 - lightness);
  const channel = (n: number) => {
    const k = (n + hue / 30) % 12;
    const value = lightness - amplitude * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * value).toString(16).padStart(2, "0");
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

/** Honor every existing color, including hidden/custom calendars and deletions. */
export function nextCalendarColor(colors: readonly string[]): string {
  const used = new Set(colors.map(color => color.trim().toLowerCase()));
  const curated = mostDistinct(CALENDAR_COLORS, used);
  if (curated) return curated;
  // More than 24 calendars: extend the color wheel instead of wrapping around.
  for (const lightness of [0.6, 0.7, 0.5, 0.65, 0.55]) {
    for (const saturation of [0.7, 0.85, 0.55]) {
      const generated = mostDistinct(Array.from({ length: 360 }, (_, hue) => hsl(hue, saturation, lightness)), used);
      if (generated) return generated;
    }
  }
  throw new Error("Automatic calendar colors exhausted. Choose a custom #rrggbb color.");
}
