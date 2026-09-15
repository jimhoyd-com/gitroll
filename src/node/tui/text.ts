// Text helpers for the interactive app: styling, measuring, wrapping, and
// editable text (one line or many). Pure: keys in, strings out, so every
// behavior here is testable without a terminal. No dependencies.

export interface Key {
  /** Named keys: up, down, left, right, return, escape, backspace, delete, tab, home, end, pageup, pagedown. */
  name?: string;
  /** A printable character typed or pasted. */
  ch?: string;
  ctrl?: boolean;
  shift?: boolean;
}

const code = (c: string) => (s: string) => `\x1b[${c}m${s}\x1b[0m`;
export const bold = code("1");
export const dim = code("2");
export const inverse = code("7");
export const green = code("32");
export const red = code("31");
export const yellow = code("33");
export const cyan = code("36");

/** Drops styling so text can be measured the way the terminal shows it. */
export const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

/** Removes control characters, so nothing in a Roll can move the cursor or retitle the window. */
export const clean = (s: string): string => s.replace(/[\x00-\x1f\x7f]/g, " ");

export const width = (s: string): number => [...strip(s)].length;

/** Cuts plain text to a width (by code point; wide characters may overhang slightly). */
export function fit(s: string, max: number): string {
  const chars = [...clean(s)];
  return chars.length <= max ? chars.join("") : `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
}

/** Pads plain or styled text out to a width. */
export function pad(s: string, max: number): string {
  return s + " ".repeat(Math.max(0, max - width(s)));
}

/** Left text and right text on one line, separated by at least one space. */
export function spread(left: string, right: string, max: number): string {
  const room = Math.max(0, max - width(right) - 1);
  return `${pad(fitStyled(left, room), room)} ${right}`;
}

function fitStyled(s: string, max: number): string {
  return width(s) <= max ? s : fit(strip(s), max);
}

export function wrap(text: string, max: number): string[] {
  const out: string[] = [];
  for (const para of clean(text).split("\n")) {
    let line = "";
    for (const word of para.split(/(\s+)/)) {
      if ([...line].length + [...word].length > max && line.trim()) {
        out.push(line.trimEnd());
        line = word.trimStart();
      } else line += word;
      while ([...line].length > max) {
        out.push([...line].slice(0, max).join(""));
        line = [...line].slice(max).join("");
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

/**
 * Escapes a path the way a terminal does when a file is dragged in, so
 * `parsePaths` reads it back unchanged. The escape character is escaped too:
 * escaping only spaces would lose a backslash that is part of the name.
 */
export const escapePath = (path: string): string => path.replace(/[\\ ]/g, "\\$&");

/** Splits dragged-in or pasted paths: quoted, or with backslash-escaped spaces. */
export function parsePaths(input: string): string[] {
  return [...input.matchAll(/'([^']*)'|"([^"]*)"|((?:\\.|\S)+)/g)].map((m) => m[1] ?? m[2] ?? m[3].replace(/\\(.)/g, "$1"));
}

export function when(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}, ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}

export const day = (iso: string): string => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** Editable text: one line, or many when `multiline` is set. */
export class Input {
  value = "";
  cursor = 0;
  readonly multiline: boolean;

  constructor(value = "", multiline = false) {
    this.multiline = multiline;
    this.set(value);
  }

  set(value: string): void {
    this.value = value;
    this.cursor = [...value].length;
  }

  clear(): void {
    this.value = "";
    this.cursor = 0;
  }

  insert(text: string): void {
    const chars = [...this.value];
    chars.splice(this.cursor, 0, ...text);
    this.value = chars.join("");
    this.cursor += [...text].length;
  }

  /** Returns true when the key changed the text or moved the cursor. */
  key(k: Key): boolean {
    const chars = [...this.value];
    if (k.ctrl && k.name === "u") this.clear();
    else if (k.ctrl && k.name === "a") this.cursor = this.#lineStart();
    else if (k.ctrl && k.name === "e") this.cursor = this.#lineEnd();
    else if (k.ctrl && k.name === "w") this.#deleteWord();
    else if (k.ctrl) return false;
    else if (k.ch) this.insert(k.ch);
    else if (k.name === "return" && this.multiline) this.insert("\n");
    else if (k.name === "backspace" && this.cursor > 0) {
      chars.splice(--this.cursor, 1);
      this.value = chars.join("");
    } else if (k.name === "delete" && this.cursor < chars.length) {
      chars.splice(this.cursor, 1);
      this.value = chars.join("");
    } else if (k.name === "left") this.cursor = Math.max(0, this.cursor - 1);
    else if (k.name === "right") this.cursor = Math.min(chars.length, this.cursor + 1);
    else if (k.name === "home") this.cursor = this.#lineStart();
    else if (k.name === "end") this.cursor = this.#lineEnd();
    else if (this.multiline && (k.name === "up" || k.name === "down")) return this.#moveLine(k.name === "up" ? -1 : 1);
    else return false;
    return true;
  }

  /** Where the cursor is, as a zero-based row and column. */
  position(): { row: number; column: number } {
    const before = [...this.value].slice(0, this.cursor).join("").split("\n");
    return { row: before.length - 1, column: [...before[before.length - 1]].length };
  }

  lines(): string[] {
    return this.value.split("\n");
  }

  #lineStart(): number {
    const { column } = this.position();
    return this.cursor - column;
  }

  #lineEnd(): number {
    const { row } = this.position();
    return this.#lineStart() + [...this.lines()[row]].length;
  }

  #moveLine(step: number): boolean {
    const { row, column } = this.position();
    const lines = this.lines();
    const target = row + step;
    if (target < 0 || target >= lines.length) return false;
    const start = lines.slice(0, target).reduce((n, l) => n + [...l].length + 1, 0);
    this.cursor = start + Math.min(column, [...lines[target]].length);
    return true;
  }

  #deleteWord(): void {
    const chars = [...this.value];
    let at = this.cursor;
    while (at > 0 && /\s/.test(chars[at - 1])) at--;
    while (at > 0 && !/\s/.test(chars[at - 1])) at--;
    chars.splice(at, this.cursor - at);
    this.value = chars.join("");
    this.cursor = at;
  }
}

/** One line of an input with a visible cursor, scrolled so the cursor stays in view. */
export function caret(value: string, cursor: number, max: number): string {
  const chars = [...clean(value)];
  const start = Math.max(0, cursor - max + 1);
  const before = chars.slice(start, cursor).join("");
  const at = chars[cursor] ?? " ";
  const after = chars.slice(cursor + 1, start + max).join("");
  return `${before}${inverse(at)}${after}`;
}

/** The visible lines of an editable text box, with the cursor shown on the active row. */
export function caretLines(input: Input, max: number, focused: boolean): string[] {
  const lines = input.lines();
  if (!focused) return lines.map((l) => fit(l, max));
  const { row, column } = input.position();
  return lines.map((l, i) => (i === row ? caret(l, column, max) : fit(l, max)));
}
