const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

export function stripAnsi(value: string): string { return value.replace(ANSI_RE, ""); }

export function width(value: string): number {
  let result = 0;
  for (const ch of stripAnsi(value)) {
    const cp = ch.codePointAt(0) ?? 0;
    result += cp >= 0x1100 && (
      cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0x1f300 && cp <= 0x1faff)
    ) ? 2 : 1;
  }
  return result;
}

export function truncate(value: string, max: number, ellipsis = "…"): string {
  if (max <= 0) return "";
  if (width(value) <= max) return value;
  const target = Math.max(0, max - width(ellipsis));
  let out = "", used = 0;
  for (const ch of stripAnsi(value)) {
    const w = width(ch);
    if (used + w > target) break;
    out += ch;
    used += w;
  }
  return out + ellipsis;
}

export function pad(value: string, target: number): string {
  const visible = width(value);
  if (visible >= target) return visible === target ? value : truncate(value, target, "");
  return value + " ".repeat(target - visible);
}

export function center(value: string, target: number): string {
  const clipped = truncate(value, target);
  const remaining = Math.max(0, target - width(clipped));
  const left = Math.floor(remaining / 2);
  return " ".repeat(left) + clipped + " ".repeat(remaining - left);
}

export function previousGrapheme(text: string, cursor: number): number {
  if (cursor <= 0) return 0;
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let previous = 0;
  for (const segment of segmenter.segment(text.slice(0, cursor))) previous = segment.index;
  return previous;
}

export function nextGrapheme(text: string, cursor: number): number {
  if (cursor >= text.length) return text.length;
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const first = segmenter.segment(text.slice(cursor))[Symbol.iterator]().next().value as { segment: string } | undefined;
  return Math.min(text.length, cursor + (first?.segment.length ?? 1));
}
