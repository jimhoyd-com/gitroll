// One event, read: what was written, what it carries, and where it lives.

import type { LoadedEntry } from "../../../core/layout.ts";
import { formatAmount } from "../../../core/util.ts";
import { Input, bold, caret, clean, dim, fit, when, wrap, yellow } from "../text.ts";
import type { Scrolled } from "./chrome.ts";

/** Front matter GitRoll shows in its own right, so the list below doesn't repeat it. */
// Shown elsewhere on this screen, or GitRoll's own bookkeeping about where the
// entry is stored — neither is something the reader wrote.
const SHOWN_ELSEWHERE = ["projects", "tags", "amount", "currency", "date", "title", "filed", "created", "key", "id", "source"];

export interface EntryView {
  entry: LoadedEntry;
  /** Whether the file an event links to is actually in the Roll. */
  hasFile(relativePath: string): boolean;
  /** Which file the keys act on, when there's more than one. */
  attachIndex: number;
  /** The paths being typed, when files are being attached. */
  attaching: Input | null;
  scroll: number;
  width: number;
  rows: number;
}

export function entry(v: EntryView): Scrolled {
  const e = v.entry;
  const lines = [` ${bold(when(e.date))}`, ""];
  for (const l of wrap(e.body || "(no text)", v.width - 2)) lines.push(` ${l}`);
  lines.push("");
  if (e.amount) lines.push(dim(` Amount: ${formatAmount(e.amount)}`));
  if (e.tags.length) lines.push(dim(` Tags: ${e.tags.map((t) => `#${t}`).join(" ")}`));
  const at = Math.min(v.attachIndex, Math.max(0, e.attachments.length - 1));
  e.attachments.forEach((a, i) => {
    const missing = !v.hasFile(a.path);
    const mark = e.attachments.length > 1 && i === at ? "▸" : " ";
    const note = missing ? " — not in this Roll yet" : "";
    lines.push((missing ? yellow : dim)(fit(`${mark} File: ${clean(a.name)}${note}`, v.width)));
  });
  for (const [k, value] of Object.entries(e.meta)) {
    if (SHOWN_ELSEWHERE.includes(k)) continue;
    lines.push(dim(fit(` ${k}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`, v.width)));
  }
  // Where it is: an entry with a file to itself is named by that file, and one
  // that shares a file is named by the short form of its permanent id.
  const shared = /^\.gitroll\/logs\//.test(e.path);
  lines.push(dim(fit(shared ? ` ${e.id.slice(-6).toLowerCase()}  in ${e.path}` : ` ${e.path}`, v.width)));
  if (v.attaching) lines.push("", ` Attach: ${caret(v.attaching.value, v.attaching.cursor, v.width - 10)}`);
  const scroll = Math.min(v.scroll, Math.max(0, lines.length - v.rows));
  return { lines: lines.slice(scroll), scroll };
}

export interface HistoryItemView {
  date: string;
  author: string;
  subject: string;
}

export function history(items: HistoryItemView[], scroll: number, w: number, rows: number): Scrolled {
  const lines = [bold(" History · every change to this entry"), ""];
  if (!items.length) lines.push(dim("  No history yet — it hasn't been committed."));
  for (const h of items) lines.push(fit(`  ${when(h.date)}  ${h.author}  ${h.subject}`, w));
  const at = Math.min(scroll, Math.max(0, lines.length - rows));
  return { lines: lines.slice(at), scroll: at };
}
