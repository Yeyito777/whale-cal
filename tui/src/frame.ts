const ESC = "\x1b[";
const move = (row: number, col: number) => `${ESC}${row};${col}H`;
const clear = `${ESC}2K`;
const syncStart = `${ESC}?2026h${ESC}?25l`;
const syncEnd = `${ESC}?2026l`;

export interface Frame {
  rows: string[];
  cursor: string;
}

/** Draw content over a rendered row without erasing the cells on either side. */
export function overlayAt(base: string, col: number, content: string): string {
  return `${base}${ESC}${Math.max(1, col)}G${content}`;
}

let previous: Frame | null = null;

export function invalidateFrame(): void { previous = null; }

export function flushFrame(frame: Frame): void {
  const output: string[] = [];
  const count = Math.max(previous?.rows.length ?? 0, frame.rows.length);
  for (let index = 0; index < count; index++) {
    const row = frame.rows[index];
    if (row !== undefined && row !== previous?.rows[index]) output.push(move(index + 1, 1) + clear + row);
  }
  if (output.length > 0 || frame.cursor !== previous?.cursor) output.push(frame.cursor);
  if (output.length > 0) process.stdout.write(syncStart + output.join("") + syncEnd);
  previous = frame;
}

export function cursorAt(row: number, col: number, shape: string, visible = true): string {
  return `${shape}${move(row, col)}${visible ? `${ESC}?25h` : `${ESC}?25l`}`;
}
