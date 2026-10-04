// To-dos are a line of Markdown, not a record of their own:
//
//   - [ ] Call the plumber about the shutoff valve
//   - [x] Book the AC service
//
// That is GitHub's task-list syntax, so a to-do renders as a checkbox on
// GitHub, in most editors and in GitRoll alike. One can sit in any event or
// note. Ticking it off is an ordinary edit to that line, so Git history is the
// record of when it was done; nothing else is stored.

/** One to-do line, read. */
export interface Todo {
  /** The repository-relative path of the event or note it is in. */
  path: string;
  /** 1-based line in the file as written, front matter included, so `file:line` opens in an editor. */
  line: number;
  /** What the line says after the checkbox. */
  text: string;
  done: boolean;
}

// A list item (-, *, + or 1. / 1)), then [ ], [x] or [X], then the words. The
// pieces are anchored and bounded so nothing rescans a long line: the words
// after the box are taken whole and trimmed afterwards, rather than matched
// beside a run of whitespace that could be split between the two.
const TODO = /^([ \t]{0,12}(?:[-*+]|\d{1,9}[.)])[ \t]{1,12})\[([ xX])\](?=[ \t]|$)(.*)$/;
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/;
const FRONT_MATTER_OPEN = /^---[ \t]*$/;

/**
 * Every to-do in a file, in order. Lines inside front matter, fenced code and
 * HTML comments are skipped, for the same reason a `#412` in a code span isn't
 * a reference: an example is not a promise to do something.
 */
export function todosIn(source: string, path = ""): Todo[] {
  const out: Todo[] = [];
  const lines = source.replace(/^﻿/, "").split("\n");
  let i = 0;
  if (lines.length && FRONT_MATTER_OPEN.test(lines[0].replace(/\r$/, ""))) {
    const end = lines.findIndex((l, n) => n > 0 && FRONT_MATTER_OPEN.test(l.replace(/\r$/, "")));
    if (end > 0) i = end + 1;
  }
  let fence: string | null = null;
  let comment = false;
  for (; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "");
    const f = FENCE.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      continue;
    }
    if (f) {
      fence = f[1];
      continue;
    }
    if (comment) {
      if (line.includes("-->")) comment = false;
      continue;
    }
    if (line.includes("<!--") && !line.slice(line.indexOf("<!--")).includes("-->")) {
      comment = true;
      continue;
    }
    const m = TODO.exec(line);
    if (m) out.push({ path, line: i + 1, text: m[3].trim(), done: m[2] !== " " });
  }
  return out;
}

/** The to-dos still to do. */
export const openTodos = (todos: Todo[]): Todo[] => todos.filter((t) => !t.done);

/**
 * Ticks a to-do off (or back on). Only the one character inside the brackets
 * changes, so the rest of the line — indentation, bullet, wording, trailing
 * spaces and line ending — stays exactly as it was written. Throws when the
 * line isn't a to-do any more, so a stale line number never edits the wrong
 * thing.
 */
export function setTodo(source: string, line: number, done: boolean): string {
  const lines = source.split("\n");
  const at = line - 1;
  const current = lines[at];
  const todo = todosIn(source).find((t) => t.line === line);
  if (current === undefined || !todo) throw new Error(`line ${line} is not a to-do`);
  const m = TODO.exec(current.replace(/\r$/, ""))!;
  const bracket = m[1].length + 1;
  lines[at] = `${current.slice(0, bracket)}${done ? "x" : " "}${current.slice(bracket + 1)}`;
  return lines.join("\n");
}

/**
 * Adds a to-do at the end of a file, after the last to-do if the file ends in a
 * list of them and as a new paragraph otherwise, so the list stays one list.
 */
export function appendTodo(source: string, text: string): string {
  const words = text.replace(/\s+/g, " ").trim();
  if (!words) throw new Error("a to-do needs some words");
  const body = source.trimEnd();
  if (!body) return `- [ ] ${words}\n`;
  const last = body.split("\n").pop()!.replace(/\r$/, "");
  const sep = TODO.test(last) ? "\n" : "\n\n";
  return `${body}${sep}- [ ] ${words}\n`;
}
