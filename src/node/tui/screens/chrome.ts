// The furniture every screen is built from: the header, the prompt line, the
// key hints, and the pieces screens share — a scrolling list, a wrapped note,
// and one event as a row.
//
// Everything here is a function of its arguments. A screen is a picture of
// state, so drawing one never needs the app itself, and a test can ask for a
// picture without a terminal.

import type { LoadedEntry } from "../../../core/layout.ts";
import { formatAmount } from "../../../core/util.ts";
import type { SyncStatus } from "../../repo.ts";
import { Input, bold, caret, clean, cyan, day, dim, fit, green, inverse, pad, red, shorten, spread, wrap, yellow } from "../text.ts";

/** Names for topics, so a slug can be shown the way its author wrote it. */
export type Names = (slug: string) => string;

export interface Safety {
  text: string;
  tone: "ok" | "warn" | "none";
  detail: string;
}

/** Where a screen's list has scrolled to, handed back so the app remembers it. */
export interface Scrolled {
  lines: string[];
  scroll: number;
}

/**
 * Always the Roll, the branch and the folder being written to — never the
 * backup address in the folder's place, because with more than one Roll around
 * the folder is the thing you can get wrong.
 */
export function header(name: string, root: string, status: SyncStatus, safety: Safety, w: number): string {
  const paint = safety.tone === "ok" ? green : safety.tone === "warn" ? yellow : dim;
  const left = `${bold(` GitRoll · ${clean(name)} · ${status.branch || "detached HEAD"}`)}${dim(`  ${shorten(root)}`)}`;
  return spread(left, paint(safety.text), w);
}

/** The line under the header: either the rule, or what can't be read. */
export function rule(problems: number, w: number): string {
  if (!problems) return dim("─".repeat(w));
  return yellow(fit(` ${problems} ${problems === 1 ? "file" : "files"} in this Roll can't be read · /problems`, w));
}

export function promptLine(prompt: Input, w: number): string {
  const label = prompt.value.startsWith("/") ? cyan(" › ") : " › ";
  const room = w - 4;
  if (!prompt.value) return `${label}${dim(fit("What happened? Type it here, or press / for commands", room))}`;
  return `${label}${caret(prompt.value, prompt.cursor, room)}`;
}

/** What the message line says, wrapped: an instruction cut off at the edge helps nobody. */
export function message(text: string, tone: "info" | "ok" | "error", w: number): string[] {
  const said = text ? wrap(text, w - 2).slice(0, 3).map((line) => ` ${line}`) : [""];
  const paint = tone === "ok" ? green : tone === "error" ? red : dim;
  return said.map((line) => (line ? paint(fit(line, w)) : ""));
}

/** A window onto a list of rows, scrolled far enough to keep the chosen one in view. */
export function list(rows: string[], selected: number, scroll: number, w: number, height: number): Scrolled {
  let at = scroll;
  if (selected >= 0 && selected < at) at = selected;
  if (selected >= at + height) at = selected - height + 1;
  at = Math.max(0, Math.min(at, Math.max(0, rows.length - height)));
  const lines = rows.slice(at, at + height).map((row, i) => (at + i === selected ? inverse(pad(fit(`▸ ${row}`, w), w)) : `  ${fit(row, w - 2)}`));
  return { lines, scroll: at };
}

/** An explanation under a heading or a result, broken to fit rather than run off the edge. */
export function note(text: string, w: number): string[] {
  return wrap(text, w - 2).map((line) => dim(` ${line}`));
}

/** One event as a timeline row: date, title, and its labels on the right. */
export function row(e: LoadedEntry, w: number, names: Names): string {
  const labels = [...e.projects.map(names), e.attachments.length ? `${e.attachments.length} file${e.attachments.length === 1 ? "" : "s"}` : "", e.amount ? formatAmount(e.amount) : ""]
    .filter(Boolean)
    .join(" · ");
  const date = day(e.date).padEnd(7);
  const room = Math.max(8, w - 4 - date.length - (labels ? labels.length + 2 : 0));
  const text = `${date} ${fit(e.title || "(no text)", room)}`;
  return labels ? `${pad(text, Math.max(0, w - 3 - labels.length))} ${clean(labels)}` : text;
}
