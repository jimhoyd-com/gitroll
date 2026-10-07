// CALENDAR. Dates that are still to come, read from files that already exist.
//
// Nothing here is a new kind of file. The field names are iCalendar's (RFC 5545):
//
//   start: 2026-11-04T09:30:00-05:00     when it begins (ISO 8601)
//   end: 2026-11-04T10:30:00-05:00       when it ends
//   location: Main St Dental             where
//   rrule: FREQ=MONTHLY;INTERVAL=3       how it repeats: an RFC 5545 RRULE
//
// A to-do line is dated and repeated the way Obsidian Tasks writes it:
//
//   - [ ] Renew passport 📅 2026-11-01
//   - [ ] Replace the HVAC filter 📅 2026-10-01 🔁 every 3 months
//
// and a few date fields that say when something runs out (`warranty`, `expires`,
// `due`, `renewal`) are on the calendar too, as are vCard's `bday` and
// `anniversary`, which come round every year. Everything is derived on read, the
// way backlinks are, and never stored.
//
// The RRULE subset understood here: FREQ (DAILY, WEEKLY, MONTHLY, YEARLY),
// INTERVAL, COUNT, UNTIL, and BYDAY (weekday names, WEEKLY only). WKST=MO is
// accepted. Anything else is reported rather than guessed at. As RFC 5545 says,
// a monthly rule on the 31st skips the months that have no 31st, and a yearly
// rule on 29 February happens only in leap years.

import type { Entry } from "./entry.ts";
import type { Todo } from "./todos.ts";
import { isRealTimestamp } from "./util.ts";

export type Freq = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

export interface RRule {
  freq: Freq;
  interval: number;
  count?: number;
  /** The last day an occurrence may fall on, inclusive, with the time RRULE gave it if any. */
  until?: { day: string; time?: string; utc: boolean };
  /** Weekdays, 0 = Monday … 6 = Sunday, for FREQ=WEEKLY. */
  byday?: number[];
}

export class RRuleError extends Error {}

const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const FREQS: Freq[] = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const UNTIL = /^(\d{4})-?(\d{2})-?(\d{2})(?:T(\d{2}):?(\d{2}):?(\d{2})(Z?))?$/;
const DIGITS = /^\d{1,6}$/;

/** Reads an RFC 5545 RRULE value (`FREQ=MONTHLY;INTERVAL=3`, with or without `RRULE:`). Throws RRuleError for what it doesn't support. */
export function parseRRule(text: string): RRule {
  let s = String(text).trim();
  if (s.toUpperCase().startsWith("RRULE:")) s = s.slice(6);
  if (!s) throw new RRuleError("an empty rrule");
  const parts = new Map<string, string>();
  for (const piece of s.split(";")) {
    if (!piece.trim()) continue;
    const at = piece.indexOf("=");
    if (at <= 0) throw new RRuleError(`"${piece}" isn't NAME=VALUE`);
    const key = piece.slice(0, at).trim().toUpperCase();
    if (parts.has(key)) throw new RRuleError(`${key} is given twice`);
    parts.set(key, piece.slice(at + 1).trim().toUpperCase());
  }
  const freq = parts.get("FREQ") as Freq | undefined;
  if (!freq) throw new RRuleError("FREQ is required, e.g. FREQ=MONTHLY");
  if (!FREQS.includes(freq)) throw new RRuleError(`FREQ=${freq} isn't supported (DAILY, WEEKLY, MONTHLY or YEARLY)`);
  const rule: RRule = { freq, interval: 1 };
  for (const [key, value] of parts) {
    switch (key) {
      case "FREQ":
        break;
      case "INTERVAL":
        if (!DIGITS.test(value) || Number(value) < 1) throw new RRuleError(`INTERVAL=${value} must be a positive whole number`);
        rule.interval = Number(value);
        break;
      case "COUNT":
        if (!DIGITS.test(value) || Number(value) < 1) throw new RRuleError(`COUNT=${value} must be a positive whole number`);
        rule.count = Number(value);
        break;
      case "UNTIL": {
        const m = UNTIL.exec(value);
        const day = m ? `${m[1]}-${m[2]}-${m[3]}` : "";
        if (!m || !isRealTimestamp(day)) throw new RRuleError(`UNTIL=${value} isn't a date like 20261231 or 20261231T235959Z`);
        rule.until = { day, ...(m[4] ? { time: `${m[4]}${m[5]}${m[6]}` } : {}), utc: m[7] === "Z" };
        break;
      }
      case "BYDAY": {
        if (freq !== "WEEKLY") throw new RRuleError("BYDAY is supported with FREQ=WEEKLY only");
        const days = value.split(",").map((d) => WEEKDAYS.indexOf(d.trim()));
        if (!days.length || days.some((d) => d < 0)) throw new RRuleError(`BYDAY=${value} must be weekday names like MO,WE,FR`);
        rule.byday = [...new Set(days)].sort((a, b) => a - b);
        break;
      }
      case "WKST":
        if (value !== "MO") throw new RRuleError("only WKST=MO (the default) is supported");
        break;
      default:
        throw new RRuleError(`${key} isn't supported (FREQ, INTERVAL, COUNT, UNTIL and weekly BYDAY are)`);
    }
  }
  if (rule.count !== undefined && rule.until) throw new RRuleError("COUNT and UNTIL can't both be given (RFC 5545)");
  return rule;
}

/** The rule back as RRULE text, with UNTIL written to match a start that is a date, a UTC time or a floating time. */
export function formatRRule(rule: RRule, start?: string): string {
  const out = [`FREQ=${rule.freq}`];
  if (rule.interval !== 1) out.push(`INTERVAL=${rule.interval}`);
  if (rule.count !== undefined) out.push(`COUNT=${rule.count}`);
  if (rule.until) {
    const day = rule.until.day.replace(/-/g, "");
    const startKind = start === undefined ? "date" : DAY.test(start) ? "date" : hasZone(start) ? "utc" : "floating";
    if (startKind === "date") out.push(`UNTIL=${day}`);
    else out.push(`UNTIL=${day}T${rule.until.time ?? "235959"}${startKind === "utc" ? "Z" : ""}`);
  }
  if (rule.byday) out.push(`BYDAY=${rule.byday.map((d) => WEEKDAYS[d]).join(",")}`);
  return out.join(";");
}

const hasZone = (s: string): boolean => s.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(s);

// ── Day arithmetic, on YYYY-MM-DD strings, with no time zone involved ─────

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const toDay = (d: Date): string => `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const dateOf = (day: string): Date => new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))));

export function addDays(day: string, n: number): string {
  const d = dateOf(day);
  d.setUTCDate(d.getUTCDate() + n);
  return toDay(d);
}

export const daysInMonth = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** 0 = Monday … 6 = Sunday. */
const weekday = (day: string): number => (dateOf(day).getUTCDay() + 6) % 7;

/** The same day of the month `n` months later, or null when that month hasn't got one (RFC 5545 skips it). */
function monthsLater(day: string, n: number, clamp: boolean): string | null {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7)) - 1 + n;
  const year = y + Math.floor(m / 12);
  const month = (m % 12) + 1;
  const want = Number(day.slice(8, 10));
  const last = daysInMonth(year, month);
  if (want > last && !clamp) return null;
  return `${pad(year, 4)}-${pad(month)}-${pad(Math.min(want, last))}`;
}

// Enough periods for a daily rule to run for centuries; a rule that would go on
// longer than that is stopped rather than allowed to spin.
const MAX_PERIODS = 200_000;

/**
 * The occurrences of a rule that fall between two days (inclusive), each as the
 * start's own text with its date changed: a start with a time keeps that time.
 * COUNT counts from the start, so occurrences before `from` still use it up.
 */
export function occurrences(start: string, rule: RRule, from: string, to: string, max = 1000): string[] {
  const first = start.slice(0, 10);
  const time = start.slice(10);
  if (!DAY.test(first) || !isRealTimestamp(first)) return [];
  const out: string[] = [];
  let seen = 0;
  const last = rule.until && rule.until.day < to ? rule.until.day : to;
  const take = (day: string): boolean => {
    // true to stop
    if (day < first) return false;
    if (day > last) return true;
    seen++;
    if (day >= from) out.push(`${day}${time}`);
    return (rule.count !== undefined && seen >= rule.count) || out.length >= max;
  };
  if (rule.freq === "WEEKLY" && rule.byday) {
    const monday = addDays(first, -weekday(first));
    for (let k = 0; k < MAX_PERIODS; k++) {
      const week = addDays(monday, 7 * rule.interval * k);
      if (week > last) break;
      for (const d of rule.byday) if (take(addDays(week, d))) return out;
    }
    return out;
  }
  for (let k = 0; k < MAX_PERIODS; k++) {
    let day: string | null;
    switch (rule.freq) {
      case "DAILY":
        day = addDays(first, rule.interval * k);
        break;
      case "WEEKLY":
        day = addDays(first, 7 * rule.interval * k);
        break;
      case "MONTHLY":
        day = monthsLater(first, rule.interval * k, false);
        break;
      default:
        day = monthsLater(first, 12 * rule.interval * k, false);
    }
    if (day === null) {
      // A skipped month: is the period itself already past the end?
      if (monthsLater(first, (rule.freq === "MONTHLY" ? 1 : 12) * rule.interval * k, true)! > last) break;
      continue;
    }
    if (take(day)) break;
  }
  return out;
}

// ── Dated and recurring to-dos (Obsidian Tasks format) ─────────────────────

/** What the Tasks plugin writes after a task's words: due, scheduled, start, done, created, cancelled, priorities, ids; and the Reminder plugin's ⏰. */
const SIGNIFIERS = ["📅", "⏳", "🛫", "✅", "➕", "❌", "🔁", "🔺", "⏫", "🔼", "🔽", "⏬", "🆔", "⛔", "🏁", "⏰"];

export interface Recurrence {
  every: number;
  unit: "day" | "week" | "month" | "year";
  /** `every week when done`: the next date counts from the day it was done, not from the due date. */
  whenDone: boolean;
  /** The words as written after 🔁. */
  text: string;
}

export interface TaskDates {
  /** The 📅 date, YYYY-MM-DD. */
  due: string | null;
  /** The 🔁 rule, when it is one GitRoll understands. */
  recurrence: Recurrence | null;
  /** The 🔁 text as written, understood or not. */
  recurrenceText: string | null;
  /** The words without the Tasks fields. */
  text: string;
}

/** Where the next Tasks field starts after `from`, or the end of the text. */
function nextSignifier(text: string, from: number): number {
  let end = text.length;
  for (const s of SIGNIFIERS) {
    const at = text.indexOf(s, from);
    if (at >= 0 && at < end) end = at;
  }
  return end;
}

/** Reads `📅 2026-11-01` and `🔁 every 3 months` from a to-do's words. */
export function taskDates(text: string): TaskDates {
  let due: string | null = null;
  const dueAt = text.indexOf("📅");
  if (dueAt >= 0) {
    const candidate = text.slice(dueAt + 2).trimStart().slice(0, 10);
    if (DAY.test(candidate) && isRealTimestamp(candidate)) due = candidate;
  }
  let recurrenceText: string | null = null;
  const repeatAt = text.indexOf("🔁");
  if (repeatAt >= 0) recurrenceText = text.slice(repeatAt + 2, nextSignifier(text, repeatAt + 2)).trim() || null;
  const first = nextSignifier(text, 0);
  return { due, recurrence: recurrenceText ? parseRecurrence(recurrenceText) : null, recurrenceText, text: text.slice(0, first).trim() };
}

const UNITS: Record<string, Recurrence["unit"]> = { day: "day", days: "day", week: "week", weeks: "week", month: "month", months: "month", year: "year", years: "year" };

/** `every day`, `every 2 weeks`, `every month when done`. Other Tasks phrasings are left alone (null). */
export function parseRecurrence(text: string): Recurrence | null {
  const all = text.toLowerCase().split(/\s+/).filter(Boolean);
  // Tags written after the rule (`🔁 every month #home`) aren't part of it.
  const tag = all.findIndex((w) => w.startsWith("#"));
  const words = tag < 0 ? all : all.slice(0, tag);
  if (words[0] !== "every") return null;
  let i = 1;
  let every = 1;
  if (words[i] && DIGITS.test(words[i])) every = Number(words[i++]);
  if (every < 1) return null;
  const unit = UNITS[words[i++] ?? ""];
  if (!unit) return null;
  let whenDone = false;
  if (words[i] === "when" && words[i + 1] === "done") {
    whenDone = true;
    i += 2;
  }
  if (i !== words.length) return null;
  return { every, unit, whenDone, text };
}

/** The Tasks recurrence as an RRULE, for a calendar. */
export function recurrenceRule(r: Recurrence): RRule {
  const freq: Record<Recurrence["unit"], Freq> = { day: "DAILY", week: "WEEKLY", month: "MONTHLY", year: "YEARLY" };
  return { freq: freq[r.unit], interval: r.every };
}

/**
 * The next due date of a recurring to-do. Counted from the due date, or from
 * `today` for `when done`. A month or a year later than the 31st, or than 29
 * February, is the last day of that month, as Obsidian Tasks does it.
 */
export function nextDue(due: string, r: Recurrence, today: string): string {
  const base = r.whenDone ? today : due;
  switch (r.unit) {
    case "day":
      return addDays(base, r.every);
    case "week":
      return addDays(base, 7 * r.every);
    case "month":
      return monthsLater(base, r.every, true)!;
    default:
      return monthsLater(base, 12 * r.every, true)!;
  }
}

// ── The calendar view ──────────────────────────────────────────────────────

/** Date fields that say when something runs out, and so belong on a calendar. */
export const DUE_FIELDS = ["warranty", "expires", "due", "renewal"];

/** vCard's (RFC 6350) dates that come round every year. */
export const YEARLY_FIELDS = ["bday", "anniversary"];

export interface YearlyDate {
  /** null when only the month and day are known (vCard's `--MMDD`). */
  year: number | null;
  month: number;
  day: number;
}

/**
 * A birthday or an anniversary: an ISO 8601 date (`1815-12-10`), vCard's basic
 * form (`18151210`), or the month and day alone as vCard writes them (`--1210`,
 * also `--12-10`). A timestamp (either form) counts by its date. Anything else is null.
 */
export function yearlyDate(v: unknown): YearlyDate | null {
  const s = v instanceof Date ? (Number.isNaN(v.getTime()) ? "" : v.toISOString().slice(0, 10)) : typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
  let year: number | null = null;
  let md: string;
  if (s.startsWith("--")) md = s.slice(2).replace("-", "");
  else {
    const t = s.indexOf("T");
    const day = t === 8 || t === 10 ? s.slice(0, t) : s;
    const ymd = day.replace(/-/g, "");
    if (!/^\d{8}$/.test(ymd) || (day.length === 10 && !DAY.test(day))) return null;
    year = Number(ymd.slice(0, 4));
    md = ymd.slice(4);
  }
  if (!/^\d{4}$/.test(md)) return null;
  const month = Number(md.slice(0, 2));
  const day = Number(md.slice(2));
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year ?? 2000, month)) return null;
  return { year, month, day };
}

/** The day it falls on in a year: 29 February is kept on 28 February when the year has no 29th. */
export function yearlyOn(d: YearlyDate, year: number): string {
  return `${pad(year, 4)}-${pad(d.month)}-${pad(Math.min(d.day, daysInMonth(year, d.month)))}`;
}

/**
 * The days a yearly date falls on between two days (inclusive), never before
 * the year it began. Unbounded on either side (no `from` or no `to`), it is
 * the first one only: the date itself when its year is known.
 */
export function yearlyOccurrences(d: YearlyDate, from?: string, to?: string): { date: string; years: number | null }[] {
  const at = (y: number) => ({ date: yearlyOn(d, y), years: d.year === null ? null : y - d.year });
  let y = from ? Math.max(Number(from.slice(0, 4)), d.year ?? 0) : d.year;
  if (y === null) return [];
  if (from && yearlyOn(d, y) < from) y++;
  if (!from || !to) return [at(y)];
  const out: { date: string; years: number | null }[] = [];
  for (; yearlyOn(d, y) <= to && out.length < 1000; y++) out.push(at(y));
  return out;
}

export interface CalendarItem {
  /** YYYY-MM-DD, or the full timestamp when there is a time. */
  date: string;
  /** event: a start, or an event dated ahead; occurrence: a repeat of one; todo: a dated to-do; field: a due-ish date field; reminder: a time to be told (reminders.ts). */
  kind: "event" | "occurrence" | "todo" | "field" | "reminder";
  title: string;
  path: string;
  end?: string;
  location?: string;
  rrule?: string;
  /** For kind field: which field. */
  field?: string;
  /** For a yearly field (bday, anniversary) whose year is known: how many years it has been. */
  years?: number;
  /** For kind todo: where it is and what it says. */
  line?: number;
  text?: string;
  /** How a to-do repeats, as written; `every year` for a birthday or an anniversary. */
  recurrence?: string;
  /** An open to-do whose date has passed. */
  overdue?: boolean;
  /** An rrule GitRoll could not read, so only its start is listed. */
  problem?: string;
  /** For kind reminder: the `remind` value as written, on an event or note. */
  remind?: string;
  /** For kind reminder: its time has come and what it is about isn't dealt with yet. */
  due?: boolean;
}

const stringOf = (v: unknown): string | null => {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().replace(/\.000Z$/, "Z");
  return typeof v === "string" ? v.trim() : null;
};

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?$/;

/** A field's value when it is an ISO 8601 date or timestamp. */
export function dateField(v: unknown): string | null {
  const s = stringOf(v);
  if (!s || !(DAY.test(s) || TIMESTAMP.test(s)) || !isRealTimestamp(s)) return null;
  return s;
}

/** A field's value by name in any case. */
export function metaValue(meta: Record<string, unknown>, key: string): unknown {
  if (Object.hasOwn(meta, key)) return meta[key];
  const k = key.toLowerCase();
  for (const own of Object.keys(meta)) if (own.toLowerCase() === k) return meta[own];
  return undefined;
}

/** `[Garage](../places/garage.md)` reads as Garage; anything else as written. */
export function linkText(v: string): string {
  const s = v.trim();
  if (s.startsWith("[")) {
    const close = s.indexOf("](");
    if (close > 0 && s.endsWith(")")) return s.slice(1, close);
  }
  return s;
}

const isEventPath = (p: string) => p.toLowerCase().startsWith(".gitroll/events/");

export interface CalendarOptions {
  /** First day, inclusive (YYYY-MM-DD). Omit for no lower bound. */
  from?: string;
  /** Last day, inclusive (YYYY-MM-DD). Omit for no upper bound. */
  to?: string;
  /** Include open dated to-dos from before `from`, marked overdue. */
  overdue?: boolean;
}

/**
 * Every dated thing between two days, by date: starts and their repeats,
 * events dated ahead, open to-dos with a 📅 date, and due-ish date fields.
 */
export function calendarItems(entries: Entry[], todos: (Todo & { title?: string })[], opts: CalendarOptions = {}): CalendarItem[] {
  const from = opts.from ?? "0000-01-01";
  const to = opts.to ?? "9999-12-31";
  const inRange = (d: string) => d.slice(0, 10) >= from && d.slice(0, 10) <= to;
  const out: CalendarItem[] = [];
  for (const e of entries) {
    const start = dateField(metaValue(e.meta, "start"));
    const end = dateField(metaValue(e.meta, "end")) ?? undefined;
    const location = stringOf(metaValue(e.meta, "location"));
    const extra = { ...(end ? { end } : {}), ...(location ? { location: linkText(location) } : {}) };
    if (start) {
      const raw = metaValue(e.meta, "rrule");
      const rruleText = typeof raw === "string" && raw.trim() ? raw.trim() : null;
      if (rruleText) {
        try {
          const rule = parseRRule(rruleText);
          const days = occurrences(start, rule, from, to);
          for (const d of days) out.push({ date: d, kind: d === start ? "event" : "occurrence", title: e.title, path: e.path, rrule: rruleText, ...extra });
        } catch (err) {
          if (inRange(start)) out.push({ date: start, kind: "event", title: e.title, path: e.path, rrule: rruleText, problem: (err as Error).message, ...extra });
        }
      } else if (inRange(start)) out.push({ date: start, kind: "event", title: e.title, path: e.path, ...extra });
    } else if (isEventPath(e.path) && e.date && inRange(e.date)) {
      out.push({ date: e.date, kind: "event", title: e.title, path: e.path, ...extra });
    }
    for (const field of DUE_FIELDS) {
      const key = Object.keys(e.meta).find((k) => k.toLowerCase() === field);
      if (!key) continue;
      const d = dateField(e.meta[key]);
      if (d && inRange(d)) out.push({ date: d, kind: "field", field: key, title: e.title, path: e.path });
    }
    for (const field of YEARLY_FIELDS) {
      const key = Object.keys(e.meta).find((k) => k.toLowerCase() === field);
      const d = key ? yearlyDate(e.meta[key]) : null;
      if (!key || !d) continue;
      for (const o of yearlyOccurrences(d, opts.from, opts.to)) {
        if (inRange(o.date)) out.push({ date: o.date, kind: "field", field: key, title: e.title, path: e.path, recurrence: "every year", ...(o.years !== null ? { years: o.years } : {}) });
      }
    }
  }
  for (const t of todos) {
    if (t.done) continue;
    const dates = taskDates(t.text);
    if (!dates.due) continue;
    const overdue = dates.due < from;
    if (!(inRange(dates.due) || (overdue && opts.overdue))) continue;
    out.push({
      date: dates.due,
      kind: "todo",
      title: dates.text || t.text,
      path: t.path,
      line: t.line,
      text: t.text,
      ...(dates.recurrenceText ? { recurrence: dates.recurrenceText } : {}),
      ...(overdue ? { overdue: true } : {}),
    });
  }
  return out.sort((a, b) => a.date.slice(0, 10).localeCompare(b.date.slice(0, 10)) || a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
}

/** `gitroll upcoming`: from today to `days` ahead, with open to-dos already overdue first. */
export function upcoming(entries: Entry[], todos: (Todo & { title?: string })[], today: string, days = 30): CalendarItem[] {
  return calendarItems(entries, todos, { from: today, to: addDays(today, days), overdue: true });
}
