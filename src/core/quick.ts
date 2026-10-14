// QUICK ENTRY. One line typed into the box at the top of the browser app,
// read as the construct it most likely is:
//
//   Fixed the gate latch            an event, today
//   Fixed the gate latch yesterday  an event, yesterday
//   $18 parking at the airport      an event with amount 18 USD (an expense)
//   [ ] buy furnace filter          a to-do in notes/todo.md
//   call Dana tomorrow 9am          a to-do with ⏰ 2026-10-15 09:00 (a reminder)
//   note: Wi-Fi                     a note
//   https://example.com/fermenting  a bookmark
//   #garden on an event             a tag
//
// The guess is only a default: the person sees it before saving and can pick
// another kind, and the line is then read again as that kind. Plain rules, no
// learning, so the same words always mean the same thing, for the browser, the
// command line and an agent alike.

import type { Amount } from "./entry.ts";
import { parseAmount } from "./util.ts";

export type QuickKind = "event" | "expense" | "todo" | "reminder" | "note" | "bookmark";

/** The kinds, in the order picking another one steps through them. */
export const QUICK_KINDS: QuickKind[] = ["event", "todo", "reminder", "expense", "note", "bookmark"];

export const QUICK_LABELS: Record<QuickKind, string> = {
  event: "Event",
  expense: "Expense",
  todo: "To-do",
  reminder: "Reminder",
  note: "Note",
  bookmark: "Bookmark",
};

export interface Quick {
  kind: QuickKind;
  /** What the words alone suggest, whatever kind was picked. */
  guessed: QuickKind;
  /** The words, without what was read out of them (an amount, a day, a tag, a prefix). */
  title: string;
  tags: string[];
  amount: Amount | null;
  /** An event's day, when the words name one ("yesterday"); null for today. */
  date: string | null;
  /** A reminder's local time, YYYY-MM-DD HH:MM. */
  remind: string | null;
  url: string | null;
}

export interface QuickOptions {
  /** Read as this kind rather than the guessed one. */
  kind?: QuickKind;
  now?: Date;
}

const TODO_PREFIX = /^(?:[-*]\s*)?\[\s?\]\s*|^to-?do\s*[:\s]\s*/i;
const NOTE_PREFIX = /^note\s*:\s*/i;
const URL = /^https?:\/\/\S+/i;
// A sign then a number ($18, €1,250.50) or a number then a code (18 USD).
const MONEY = /(^|\s)([$€£¥]\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s?(?:usd|eur|gbp|jpy|cad|aud|chf))(?=\s|$|[.,;!?])/i;
const TAG = /(^|\s)#([\p{L}\p{N}][\p{L}\p{N}_-]*)/gu;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const DAY_WORD = /(^|\s)(?:on\s+|by\s+|next\s+)?(today|tonight|tomorrow|yesterday|next week|(?:sun|mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?)(?:day)?|in \d{1,3} days?|\d{4}-\d{2}-\d{2})(?=\s|$|[.,;!?])/i;
const TIME = /(^|\s)(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s?(am|pm)(?=\s|$|[.,;!?])|(^|\s)(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)(?=\s|$|[.,;!?])/i;

/** Reads one typed line; null when there is nothing to save. */
export function readQuick(input: string, opts: QuickOptions = {}): Quick | null {
  const line = oneLine(input);
  if (!line) return null;
  const now = opts.now ?? new Date();
  const guessed = guessKind(line, now);
  const kind = opts.kind ?? guessed;

  let rest = line;
  let url: string | null = null;
  const urlMatch = rest.match(URL);
  if (kind === "bookmark" && urlMatch) {
    url = urlMatch[0];
    rest = rest.slice(url.length).replace(/^\s*[-–—:|]\s*/, "").trim();
  }
  rest = rest.replace(TODO_PREFIX, "").replace(NOTE_PREFIX, "");

  let amount: Amount | null = null;
  if (kind === "expense") {
    const m = rest.match(MONEY);
    if (m) {
      amount = parseAmount(m[2].replace(/\s/g, "").replace(/^(\d[\d,.]*)([a-z]{3})$/i, "$1 $2"));
      rest = cut(rest, m.index! + m[1].length, m[2].length).replace(/^(?:for|on)\s+/i, "");
    }
  }

  let date: string | null = null;
  let remind: string | null = null;
  if (kind === "reminder" || kind === "event" || kind === "expense") {
    const d = rest.match(DAY_WORD);
    const day = d ? dayOf(d[2], now) : null;
    const t = kind === "reminder" ? rest.match(TIME) : null;
    if (kind === "reminder") {
      const clock = t ? timeOf(t) : null;
      if (d && day) rest = cut(rest, d.index! + d[1].length, d[0].length - d[1].length);
      if (t) {
        const again = rest.match(TIME);
        const lead = (again?.[1] ?? again?.[5] ?? "").length;
        if (again) rest = cut(rest, again.index! + lead, again[0].length - lead);
      }
      const word = d?.[2].toLowerCase();
      remind = `${day ?? isoDay(now)} ${clock ?? (word === "tonight" ? "19:00" : "09:00")}`;
    } else if (d && day && day <= isoDay(now)) {
      // Only a day that has come: "yesterday" dates an event, "tomorrow" doesn't.
      if (day !== isoDay(now)) date = day;
      rest = cut(rest, d.index! + d[1].length, d[0].length - d[1].length);
    }
  }

  const tags: string[] = [];
  if (kind === "event" || kind === "expense") {
    rest = rest.replace(TAG, (_all, space: string, tag: string) => {
      tags.push(tag.toLowerCase());
      return space;
    });
  }

  let title = trimPunctuation(rest.replace(/\s+/g, " "));
  if (!title && url) title = url;
  if (!title) title = line;
  return { kind, guessed, title, tags: [...new Set(tags)], amount, date, remind, url };
}

/** One line, at most MAX_LINE characters: what a box holds, and a bound on the patterns below. */
export const MAX_LINE = 1000;
const oneLine = (input: string): string => input.slice(0, MAX_LINE * 2).replace(/\s+/g, " ").trim().slice(0, MAX_LINE);

/** The kind the words alone suggest. */
export function guessKind(input: string, now: Date = new Date()): QuickKind {
  const line = oneLine(input);
  if (URL.test(line)) return "bookmark";
  if (NOTE_PREFIX.test(line)) return "note";
  const todo = TODO_PREFIX.test(line);
  if (!todo && MONEY.test(line)) return "expense";
  const d = line.match(DAY_WORD);
  const day = d ? dayOf(d[2], now) : null;
  const future = !!day && day > isoDay(now);
  const timed = TIME.test(line) && !(day && day < isoDay(now));
  if (future || timed || (d && /tonight/i.test(d[2]))) return "reminder";
  return todo ? "todo" : "event";
}

/** The to-do line a quick to-do or reminder is written as: its words, then ⏰ and when. */
export function quickTodoText(q: Quick): string {
  return q.kind === "reminder" && q.remind ? `${q.title} ⏰ ${q.remind}` : q.title;
}

/** The words without spaces, commas, semicolons, colons and dashes at either end. A loop, not a pattern anchored at the end, which can backtrack on long runs. */
function trimPunctuation(text: string): string {
  const loose = (c: string) => c === " " || c === "," || c === ";" || c === ":" || c === "-";
  let start = 0;
  let end = text.length;
  while (start < end && loose(text[start])) start++;
  while (end > start && loose(text[end - 1])) end--;
  return text.slice(start, end);
}

function cut(text: string, at: number, length: number): string {
  return `${text.slice(0, at)} ${text.slice(at + length)}`.replace(/\s+/g, " ").trim();
}

function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  out.setDate(out.getDate() + n);
  return out;
}

/** The day a word names, from `now`. A weekday is the next one, never today. */
function dayOf(word: string, now: Date): string | null {
  const w = word.toLowerCase();
  if (w === "today" || w === "tonight") return isoDay(now);
  if (w === "tomorrow") return isoDay(addDays(now, 1));
  if (w === "yesterday") return isoDay(addDays(now, -1));
  if (w === "next week") return isoDay(addDays(now, 7));
  const inDays = w.match(/^in (\d{1,3}) days?$/);
  if (inDays) return isoDay(addDays(now, Number(inDays[1])));
  if (/^\d{4}-\d{2}-\d{2}$/.test(w)) return Number.isNaN(Date.parse(`${w}T00:00:00`)) ? null : w;
  const i = WEEKDAYS.findIndex((name) => name.startsWith(w.slice(0, 3)));
  if (i < 0) return null;
  const ahead = (i - now.getDay() + 7) % 7 || 7;
  return isoDay(addDays(now, ahead));
}

function timeOf(m: RegExpMatchArray): string | null {
  let hour: number;
  let minute: number;
  if (m[2] !== undefined) {
    hour = Number(m[2]);
    minute = Number(m[3] ?? 0);
    if (hour < 1 || hour > 12 || minute > 59) return null;
    hour = (hour % 12) + (m[4].toLowerCase() === "pm" ? 12 : 0);
  } else {
    hour = Number(m[6]);
    minute = Number(m[7]);
  }
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}
