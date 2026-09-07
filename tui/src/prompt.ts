import type { AppState, PromptState } from "./state";
import type { KeyEvent } from "./input";
import { cycleCompletion, refreshCompletion } from "./completion";
import { nextGrapheme, previousGrapheme } from "./text";

type Snapshot = { text: string; cursor: number };
interface Memory { undo: Snapshot[]; redo: Snapshot[]; pending: string; count: string; operatorCount?: number; historyIndex: number; draft: string; focusEpoch?: number }

/** Single-line command editing. History and the yank register last for this TUI session. */
export class PromptController {
  readonly history: string[] = [];
  private register = "";
  private memories = new WeakMap<PromptState, Memory>();

  handle(p: PromptState, key: KeyEvent, state: AppState): "handled" | "submit" | "close" {
    let m = this.memories.get(p);
    if (!m) { m = { undo: [], redo: [], pending: "", count: "", historyIndex: this.history.length, draft: p.text }; this.memories.set(p, m); }
    if (m.focusEpoch !== p.focusEpoch) {
      m.pending = ""; m.count = ""; m.operatorCount = undefined; m.focusEpoch = p.focusEpoch;
    }
    refreshCompletion(p, state);
    const before = { text: p.text, cursor: p.cursor };
    const finish = () => {
      if (p.text !== before.text) {
        m!.undo.push(before); if (m!.undo.length > 200) m!.undo.shift(); m!.redo = [];
      }
      p.cursor = Math.max(0, Math.min(p.cursor, p.mode === "normal" && p.text.length ? previousGrapheme(p.text, p.text.length) : p.text.length));
      refreshCompletion(p, state);
      return "handled" as const;
    };
    if (key.type === "enter") {
      if (p.text.trim() && this.history.at(-1) !== p.text) { this.history.push(p.text); if (this.history.length > 200) this.history.shift(); }
      p.completion = null; return "submit";
    }
    if (key.type === "tab" || key.type === "backtab" || (p.completion && (key.type === "up" || key.type === "down"))) {
      cycleCompletion(p, key.type === "backtab" || key.type === "up" ? -1 : 1);
      return "handled";
    }
    if (key.type === "escape") {
      if (p.completion) {
        p.completion = null; p.completionText = p.text; p.completionCursor = p.cursor;
      }
      if (p.mode === "insert") { p.mode = "normal"; p.cursor = previousGrapheme(p.text, p.cursor); }
      else if (p.selectionAnchor !== undefined || m.pending || m.count) { p.selectionAnchor = undefined; m.pending = ""; m.count = ""; m.operatorCount = undefined; }
      else return "close";
      return "handled";
    }
    if (["up", "down"].includes(key.type)) {
      if (m.historyIndex === this.history.length) m.draft = p.text;
      const backward = key.type === "up";
      m.historyIndex = Math.max(0, Math.min(this.history.length, m.historyIndex + (backward ? -1 : 1)));
      p.text = this.history[m.historyIndex] ?? m.draft; p.cursor = p.text.length;
      p.completion = null; p.completionText = p.text; p.completionCursor = p.cursor;
      return "handled";
    }
    const remove = (start: number, end: number, yank = true) => {
      if (yank) this.register = p.text.slice(start, end);
      p.text = p.text.slice(0, start) + p.text.slice(end); p.cursor = start;
    };
    const insert = (text: string) => { p.text = p.text.slice(0, p.cursor) + text.replace(/[\r\n]+/g, " ") + p.text.slice(p.cursor); p.cursor += text.replace(/[\r\n]+/g, " ").length; };
    const wordClass = (at: number, big = false) => /\s/.test(p.text[at] ?? " ") ? 0 : big || /[\p{L}\p{N}_]/u.test(p.text[at] ?? "") ? 1 : 2;
    const wordForward = (pos: number, big = false) => { const kind = wordClass(pos, big); while (pos < p.text.length && wordClass(pos, big) === kind) pos = nextGrapheme(p.text, pos); while (pos < p.text.length && !wordClass(pos, big)) pos = nextGrapheme(p.text, pos); return pos; };
    const wordBack = (pos: number, big = false) => { pos = previousGrapheme(p.text, pos); while (pos > 0 && !wordClass(pos, big)) pos = previousGrapheme(p.text, pos); const kind = wordClass(pos, big); while (pos > 0 && wordClass(previousGrapheme(p.text, pos), big) === kind) pos = previousGrapheme(p.text, pos); return pos; };
    if (p.mode === "insert") {
      switch (key.type) {
        case "char": insert(key.char ?? ""); break;
        case "paste": insert(key.text ?? ""); break;
        case "left": case "ctrl-b": p.cursor = previousGrapheme(p.text, p.cursor); break;
        case "right": case "ctrl-f": p.cursor = nextGrapheme(p.text, p.cursor); break;
        case "home": case "ctrl-a": p.cursor = 0; break;
        case "end": case "ctrl-e": p.cursor = p.text.length; break;
        case "backspace": remove(previousGrapheme(p.text, p.cursor), p.cursor, false); break;
        case "delete": remove(p.cursor, nextGrapheme(p.text, p.cursor), false); break;
        case "ctrl-w": remove(wordBack(p.cursor), p.cursor); break;
        case "ctrl-u": remove(0, p.cursor); break;
        case "ctrl-y": insert(this.register); break;
      }
      return finish();
    }
    if (key.type === "ctrl-r" || (key.char === "u" && !m.pending)) {
      const source = key.type === "ctrl-r" ? m.redo : m.undo;
      const target = key.type === "ctrl-r" ? m.undo : m.redo;
      const snapshot = source.pop();
      if (snapshot) { target.push(before); Object.assign(p, snapshot); p.cursor = Math.min(p.cursor, previousGrapheme(p.text, p.text.length)); }
      p.selectionAnchor = undefined; m.pending = ""; m.count = ""; m.operatorCount = undefined; return "handled";
    }
    const ch = key.type === "char" ? key.char ?? "" : ({ left: "h", right: "l", home: "0", end: "$", delete: "x", backspace: "X" } as Record<string, string>)[key.type] ?? "";
    if (m.pending === "r" && ch) {
      let end = p.cursor;
      const n = Math.max(1, Number(m.count) || 1);
      for (let i = 0; i < n; i++) end = nextGrapheme(p.text, end);
      p.text = p.text.slice(0, p.cursor) + ch.repeat(n) + p.text.slice(end);
      m.pending = ""; m.count = ""; m.operatorCount = undefined; return finish();
    }
    if (/[fFtT]$/.test(m.pending) && ch) {
      const find = m.pending.at(-1)!;
      const forward = find === "f" || find === "t";
      const index = forward ? p.text.indexOf(ch, nextGrapheme(p.text, p.cursor)) : p.text.lastIndexOf(ch, p.cursor - 1);
      if (index >= 0) {
        const target = find === "t" ? previousGrapheme(p.text, index) : find === "T" ? nextGrapheme(p.text, index) : index;
        if (m.pending.length > 1) {
          const op = m.pending[0];
          const start = Math.min(p.cursor, target), end = nextGrapheme(p.text, Math.max(p.cursor, target));
          this.register = p.text.slice(start, end);
          if (op !== "y") remove(start, end); if (op === "c") p.mode = "insert";
        } else p.cursor = target;
      }
      m.pending = ""; m.count = ""; m.operatorCount = undefined; return finish();
    }
    if (/^[1-9]$/.test(ch) || (ch === "0" && m.count)) { m.count = (m.count + ch).slice(0, 3); return "handled"; }
    const count = Math.max(1, Number(m.count) || 1) * (m.operatorCount ?? 1);
    if (["f", "F", "t", "T"].includes(ch)) { m.pending += ch; return "handled"; }
    if (ch === "r" && !m.pending) { m.pending = "r"; return "handled"; }
    if (ch === "g" && !m.pending) { m.pending = "g"; return "handled"; }
    if (ch === "g" && m.pending === "g") { p.cursor = 0; m.pending = ""; m.count = ""; m.operatorCount = undefined; return finish(); }
    if (ch === "v") { p.selectionAnchor = p.selectionAnchor === undefined ? p.cursor : undefined; return "handled"; }
    if (p.selectionAnchor !== undefined && ["d", "c", "y", "x"].includes(ch)) {
      const start = Math.min(p.selectionAnchor, p.cursor), end = nextGrapheme(p.text, Math.max(p.selectionAnchor, p.cursor));
      this.register = p.text.slice(start, end);
      if (ch !== "y") remove(start, end); else p.cursor = start;
      p.selectionAnchor = undefined; if (ch === "c") p.mode = "insert";
      return finish();
    }
    if (m.pending && (ch === "i" || ch === "a")) { m.pending += ch; return "handled"; }
    if (m.pending.length === 2 && ["\"", "'", "`", "(", ")", "[", "]", "{", "}"].includes(ch)) {
      const pairs: Record<string, [string, string]> = { "(": ["(", ")"], ")": ["(", ")"], "[": ["[", "]"], "]": ["[", "]"], "{": ["{", "}"], "}": ["{", "}"] };
      const [open, close] = pairs[ch] ?? [ch, ch];
      const from = p.text.lastIndexOf(open, p.cursor), to = p.text.indexOf(close, Math.max(p.cursor, from + 1));
      if (from >= 0 && to > from) {
        const around = m.pending[1] === "a", op = m.pending[0];
        const start = from + (around ? 0 : 1), end = to + (around ? 1 : 0);
        this.register = p.text.slice(start, end);
        if (op !== "y") remove(start, end); if (op === "c") p.mode = "insert";
      }
      m.pending = ""; m.count = ""; m.operatorCount = undefined; return finish();
    }
    if (m.pending.length === 2 && ["w", "W"].includes(ch)) {
      const op = m.pending[0], around = m.pending[1] === "a";
      let start = p.cursor;
      while (start > 0 && wordClass(previousGrapheme(p.text, start), ch === "W") === wordClass(p.cursor, ch === "W")) start = previousGrapheme(p.text, start);
      let end = nextGrapheme(p.text, p.cursor);
      while (end < p.text.length && wordClass(end, ch === "W") === wordClass(p.cursor, ch === "W")) end = nextGrapheme(p.text, end);
      if (around) while (end < p.text.length && !wordClass(end)) end = nextGrapheme(p.text, end);
      this.register = p.text.slice(start, end);
      if (op !== "y") remove(start, end); if (op === "c") p.mode = "insert";
      m.pending = ""; m.count = ""; m.operatorCount = undefined; return finish();
    }
    if (["d", "c", "y"].includes(ch)) {
      if (m.pending === ch) { this.register = p.text; if (ch !== "y") remove(0, p.text.length); if (ch === "c") p.mode = "insert"; m.pending = ""; m.count = ""; m.operatorCount = undefined; return finish(); }
      m.pending = ch; m.operatorCount = count; m.count = ""; return "handled";
    }
    let target = p.cursor;
    let motion = true;
    for (let i = 0; i < count; i++) {
      switch (ch) {
        case "h": target = previousGrapheme(p.text, target); break;
        case "l": target = nextGrapheme(p.text, target); break;
        case "w": case "W": target = wordForward(target, ch === "W"); break;
        case "b": case "B": target = wordBack(target, ch === "B"); break;
        case "e": case "E": { target = nextGrapheme(p.text, target); while (target < p.text.length && !wordClass(target)) target = nextGrapheme(p.text, target); const kind = wordClass(target, ch === "E"); while (nextGrapheme(p.text, target) < p.text.length && wordClass(nextGrapheme(p.text, target), ch === "E") === kind) target = nextGrapheme(p.text, target); break; }
        case "0": target = 0; break;
        case "^": target = p.text.search(/\S/); break;
        case "$": case "G": target = p.text.length; break;
        default: motion = false;
      }
    }
    if (motion) {
      if (m.pending) {
        const op = m.pending[0];
        if (op === "c" && ["w", "W"].includes(ch) && wordClass(p.cursor)) {
          while (target > p.cursor && !wordClass(previousGrapheme(p.text, target))) target = previousGrapheme(p.text, target);
        }
        if (["e", "E"].includes(ch)) target = nextGrapheme(p.text, target);
        const start = Math.min(p.cursor, target), end = Math.max(p.cursor, target);
        this.register = p.text.slice(start, end);
        if (op !== "y") remove(start, end); if (op === "c") p.mode = "insert";
      } else p.cursor = target;
    } else {
      switch (ch) {
        case "i": p.mode = "insert"; break;
        case "a": p.cursor = nextGrapheme(p.text, p.cursor); p.mode = "insert"; break;
        case "I": p.cursor = 0; p.mode = "insert"; break;
        case "A": p.cursor = p.text.length; p.mode = "insert"; break;
        case "x": for (let i = 0; i < count; i++) target = nextGrapheme(p.text, target); remove(p.cursor, target); break;
        case "X": for (let i = 0; i < count; i++) target = previousGrapheme(p.text, target); remove(target, p.cursor); break;
        case "D": case "C": remove(p.cursor, p.text.length); if (ch === "C") p.mode = "insert"; break;
        case "Y": this.register = p.text.slice(p.cursor); break;
        case "s": remove(p.cursor, nextGrapheme(p.text, p.cursor)); p.mode = "insert"; break;
        case "S": remove(0, p.text.length); p.mode = "insert"; break;
        case "p": case "P": if (ch === "p") p.cursor = nextGrapheme(p.text, p.cursor); insert(this.register.repeat(count)); p.cursor = previousGrapheme(p.text, p.cursor); break;
      }
    }
    m.pending = ""; m.count = ""; m.operatorCount = undefined;
    return finish();
  }
}
