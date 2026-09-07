import { nextGrapheme } from "./text";

export type KeyType = "char" | "enter" | "tab" | "backtab" | "backspace" | "delete" | "escape"
  | "left" | "right" | "up" | "down" | "home" | "end" | "paste" | "unknown"
  | "ctrl-a" | "ctrl-w" | "ctrl-b" | "ctrl-c" | "ctrl-d" | "ctrl-e" | "ctrl-f" | "ctrl-j" | "ctrl-k" | "ctrl-l" | "ctrl-n"
  | "ctrl-p" | "ctrl-r" | "ctrl-s" | "ctrl-u" | "ctrl-y" | "ctrl-shift-r" | "ctrl-shift-o";

export interface KeyEvent {
  type: KeyType;
  char?: string;
  text?: string;
  /** Kitty keyboard protocol event type. Raw legacy input is a press. */
  event?: "press" | "repeat" | "release";
}
export interface MouseEvent { type: "mouse"; button: number; col: number; row: number; action: "press" | "release" | "motion" }
export type InputEvent = KeyEvent | MouseEvent;

const pasteStart = "\x1b[200~", pasteEnd = "\x1b[201~";

const CTRL: Partial<Record<number, KeyType>> = {
  1: "ctrl-a", 23: "ctrl-w",
  2: "ctrl-b", 3: "ctrl-c", 4: "ctrl-d", 5: "ctrl-e", 6: "ctrl-f", 10: "ctrl-j", 11: "ctrl-k", 12: "ctrl-l",
  14: "ctrl-n", 16: "ctrl-p", 18: "ctrl-r", 19: "ctrl-s", 21: "ctrl-u", 25: "ctrl-y",
};

function kitty(params: string): KeyEvent | null {
  const fields = params.split(";");
  const code = Number(fields[0]?.split(":")[0]);
  const modifierParts = fields[1]?.split(":") ?? ["1"];
  const modifier = Number(modifierParts[0] ?? 1);
  const event = modifierParts[1] === "3" ? "release" : modifierParts[1] === "2" ? "repeat" : "press";
  if (modifier === 5 && code >= 97 && code <= 122) {
    return { type: (`ctrl-${String.fromCharCode(code)}` as KeyType), event };
  }
  if (modifier === 6 && code === 114) return { type: "ctrl-shift-r", event };
  if (modifier === 6 && code === 111) return { type: "ctrl-shift-o", event };
  if (code === 13) return { type: "enter", event };
  if (code === 9) return { type: modifier === 2 ? "backtab" : "tab", event };
  if (code === 27) return { type: "escape", event };
  if (code === 127 || code === 8) return { type: "backspace", event };
  if (modifier === 1 || modifier === 2) return { type: "char", char: String.fromCodePoint(code), event };
  return null;
}

export function parseInput(data: Buffer | string): InputEvent[] {
  const text = typeof data === "string" ? data : data.toString("utf8");
  const events: InputEvent[] = [];
  let index = 0;
  while (index < text.length) {
    if (text.startsWith(pasteStart, index)) {
      const start = index + pasteStart.length;
      const end = text.indexOf(pasteEnd, start);
      events.push({ type: "paste", text: text.slice(start, end === -1 ? text.length : end) });
      index = end === -1 ? text.length : end + pasteEnd.length;
      continue;
    }
    const code = text.charCodeAt(index);
    if (CTRL[code]) { events.push({ type: CTRL[code]! }); index++; continue; }
    if (code === 13) { events.push({ type: "enter" }); index++; continue; }
    if (code === 9) { events.push({ type: "tab" }); index++; continue; }
    if (code === 127 || code === 8) { events.push({ type: "backspace" }); index++; continue; }
    if (code === 27) {
      if (index + 1 >= text.length) { events.push({ type: "escape" }); index++; continue; }
      if (text[index + 1] === "[") {
        if (text[index + 2] === "<") {
          const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(text.slice(index));
          if (match) {
            const raw = Number(match[1]);
            events.push({ type: "mouse", button: raw & 0x43, col: Number(match[2]), row: Number(match[3]), action: match[4] === "m" ? "release" : raw & 32 ? "motion" : "press" });
            index += match[0].length;
            continue;
          }
        }
        let end = index + 2;
        while (end < text.length && !(text.charCodeAt(end) >= 0x40 && text.charCodeAt(end) <= 0x7e)) end++;
        if (end < text.length) {
          const params = text.slice(index + 2, end), final = text[end];
          const standard: Record<string, KeyType> = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end", Z: "backtab" };
          if (!params && standard[final!]) events.push({ type: standard[final!]! });
          else if (params === "3" && final === "~") events.push({ type: "delete" });
          else if (final === "u") { const parsed = kitty(params); if (parsed) events.push(parsed); }
          index = end + 1;
          continue;
        }
      }
      events.push({ type: "escape" }); index++; continue;
    }
    if (code >= 32) {
      const end = nextGrapheme(text, index);
      events.push({ type: "char", char: text.slice(index, end) });
      index = end;
      continue;
    }
    events.push({ type: "unknown" }); index++;
  }
  return events;
}

/** Holds terminal chunks until a bracketed paste is complete. */
export class InputBuffer {
  private buffer = "";
  feed(chunk: Buffer): string | null {
    this.buffer += chunk.toString("utf8");
    const start = this.buffer.indexOf(pasteStart);
    if (start !== -1 && this.buffer.indexOf(pasteEnd, start) === -1) return null;
    const value = this.buffer;
    this.buffer = "";
    return value;
  }
}
