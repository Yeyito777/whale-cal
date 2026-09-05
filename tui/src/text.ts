const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function stripAnsi(value: string): string { return value.replace(ANSI_RE, ""); }

export function width(value: string): number {
  return Bun.stringWidth(value);
}

export function truncate(value: string, max: number, ellipsis = "…"): string {
  if (max <= 0) return "";
  if (width(value) <= max) return value;
  const target = Math.max(0, max - width(ellipsis));
  let out = "", used = 0;
  for (const { segment: ch } of graphemes.segment(stripAnsi(value))) {
    const w = width(ch);
    if (used + w > target) break;
    out += ch;
    used += w;
  }
  return out + ellipsis;
}

/** Wrap details without discarding paragraph breaks or splitting graphemes. */
export function wrapText(text: string, columns: number): string[] {
  const max = Math.max(1, columns);
  const output: string[] = [];
  for (const paragraph of text.replace(/\r/g, "").split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line && width(line + " " + word) > max) { output.push(line); line = ""; }
      for (const { segment } of graphemes.segment((line ? " " : "") + word)) {
        if (line && width(line + segment) > max) { output.push(line); line = ""; }
        line += segment;
      }
    }
    output.push(line);
  }
  return output;
}

export function inputWindow(text: string, cursor: number, columns: number): { text: string; column: number; start: number } {
  const position = Math.min(cursor, text.length);
  let start = position, column = 0;
  const before = [...graphemes.segment(text.slice(0, position))];
  for (let i = before.length - 1; i >= 0; i--) {
    const item = before[i]!;
    const size = width(item.segment);
    if (column + size >= Math.max(1, columns)) break;
    start = item.index; column += size;
  }
  return { text: truncate(text.slice(start), columns, ""), column, start };
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
  let previous = 0;
  for (const segment of graphemes.segment(text.slice(0, cursor))) previous = segment.index;
  return previous;
}

export function nextGrapheme(text: string, cursor: number): number {
  if (cursor >= text.length) return text.length;
  const first = graphemes.segment(text.slice(cursor))[Symbol.iterator]().next().value as { segment: string } | undefined;
  return Math.min(text.length, cursor + (first?.segment.length ?? 1));
}
