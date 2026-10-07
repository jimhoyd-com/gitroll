// REMINDERS. A time to be told about something, written with conventions that
// already exist rather than a new one:
//
//   - [ ] Call the dentist ⏰ 2026-11-01 09:00          the Obsidian Reminder plugin, in its
//   - [ ] Call the dentist (@2026-11-01 09:00)          Tasks-style and its own form (both read;
//                                                        GitRoll writes the first)
//   ---
//   start: 2026-11-04T09:30:00-05:00
//   remind: -PT1H                                       an RFC 5545 duration before (or after)
//   ---                                                 `start`, or an ISO 8601 date-time;
//                                                        a list of either is several reminders
//
// GitRoll runs only when it is run, so nothing here sends anything. A reminder
// is listed by `gitroll upcoming` and `gitroll reminders` (due ones first), and
// `gitroll calendar --ics` writes each one as a VALARM so the calendar app that
// imports the file does the telling.
//
// A time without an offset is local time wherever it is read, as `start` is. A
// reminder written as a day alone is at 09:00 that day, the Reminder plugin's
// default time. A reminder is due from its time until what it is about is dealt
// with: the to-do ticked off, the day of the event (or its `end`) over, or, for
// a `remind` with no `start`, the field taken out.

import type { Entry } from "./entry.ts";
import type { Todo } from "./todos.ts";
import type { CalendarItem } from "./calendar.ts";
import { addDays, dateField, metaValue, occurrences, parseRRule, taskDates, upcoming } from "./calendar.ts";
import { isRealTimestamp, isoDate, isoDateIn, slugify, zoneOffset, zonedInstant } from "./util.ts";

/** The time a reminder written as a day alone is at: the Obsidian Reminder plugin's default. */
export const DEFAULT_REMINDER_TIME = "09:00";

const ALARM = "⏰"; // ⏰
const VARIATION = "️";

const isDigit = (s: string, i: number) => {
  const c = s.charCodeAt(i);
  return c >= 48 && c <= 57;
};
const digits = (s: string, from: number, n: number) => {
  for (let i = from; i < from + n; i++) if (!isDigit(s, i)) return false;
  return true;
};

/** `YYYY-MM-DD`, then optionally ` HH:MM` or `THH:MM`, at `i`. Bounded: it never looks more than 16 characters ahead. */
function readDateTime(s: string, i: number): { day: string; time: string | null; end: number } | null {
  if (!(digits(s, i, 4) && s[i + 4] === "-" && digits(s, i + 5, 2) && s[i + 7] === "-" && digits(s, i + 8, 2))) return null;
  const day = s.slice(i, i + 10);
  if (!isRealTimestamp(day)) return null;
  const sep = s[i + 10];
  if ((sep === " " || sep === "T") && digits(s, i + 11, 2) && s[i + 13] === ":" && digits(s, i + 14, 2) && !isDigit(s, i + 16)) {
    const time = s.slice(i + 11, i + 16);
    if (isRealTimestamp(`${day}T${time}`)) return { day, time, end: i + 16 };
  }
  if (isDigit(s, i + 10)) return null;
  return { day, time: null, end: i + 10 };
}

export interface TaskReminder {
  /** Local time: YYYY-MM-DDTHH:MM:00. */
  at: string;
  /** Where the whole marker (`⏰ …` or `(@…)`) is in the text, and where its date is. */
  start: number;
  end: number;
  dateAt: number;
}

/** Reads `⏰ 2026-11-01 09:00` or `(@2026-11-01 09:00)` from a to-do's words. A day alone is at 09:00. */
export function taskReminder(text: string): TaskReminder | null {
  const alarm = text.indexOf(ALARM);
  if (alarm >= 0) {
    let i = alarm + 1;
    if (text[i] === VARIATION) i++;
    while (text[i] === " " || text[i] === "\t") i++;
    const dt = readDateTime(text, i);
    if (dt) return { at: `${dt.day}T${dt.time ?? DEFAULT_REMINDER_TIME}:00`, start: alarm, end: dt.end, dateAt: i };
  }
  for (let open = text.indexOf("(@"); open >= 0; open = text.indexOf("(@", open + 2)) {
    const dt = readDateTime(text, open + 2);
    if (dt && text[dt.end] === ")") return { at: `${dt.day}T${dt.time ?? DEFAULT_REMINDER_TIME}:00`, start: open, end: dt.end + 1, dateAt: open + 2 };
  }
  return null;
}

/** The words with the reminder's day moved by `days` (a repeating to-do's next copy keeps its reminder as far from its 📅 date). */
export function shiftTaskReminder(words: string, days: number): string {
  const r = taskReminder(words);
  if (!r || !days) return words;
  return `${words.slice(0, r.dateAt)}${addDays(words.slice(r.dateAt, r.dateAt + 10), days)}${words.slice(r.dateAt + 10)}`;
}

/** A to-do's words for a person: without the Tasks fields, the ⏰ and the (@…). */
export function reminderTitle(text: string): string {
  const r = taskReminder(text);
  const plain = r && text[r.start] === "(" ? `${text.slice(0, r.start)}${text.slice(r.end)}` : text;
  return taskDates(plain).text.replace(/\s+/g, " ").trim() || text;
}

/**
 * `--at` for `gitroll remind`: a day, or a day and a time (`2026-11-01 09:00`,
 * `2026-11-01T09:00`), as written into a to-do: `2026-11-01 09:00`, local time.
 * One with an offset is moved to local time in `timeZone`, or this computer's. Null when it isn't one.
 */
export function reminderTime(input: string, timeZone?: string): string | null {
  const s = input.trim();
  const dt = readDateTime(s, 0);
  if (!dt) return null;
  if (dt.end === s.length) return `${dt.day} ${dt.time ?? DEFAULT_REMINDER_TIME}`;
  const iso = `${dt.day}T${s.slice(11)}`;
  if (!dt.time || !dateField(iso)) return null;
  const moment = Date.parse(iso);
  if (Number.isNaN(moment)) return null;
  if (timeZone) {
    const wall = new Date(moment + zoneOffset(moment, timeZone)).toISOString();
    return `${wall.slice(0, 10)} ${wall.slice(11, 16)}`;
  }
  const local = new Date(moment);
  const at = isoDate(local);
  return `${at} ${String(local.getHours()).padStart(2, "0")}:${String(local.getMinutes()).padStart(2, "0")}`;
}

// ── RFC 5545 durations (§3.3.6) ────────────────────────────────────────────

export interface Duration {
  sign: 1 | -1;
  weeks: number;
  days: number;
  /** Hours, minutes and seconds, in seconds. */
  seconds: number;
}

/**
 * Reads an RFC 5545 duration: `-PT1H`, `-P1D`, `P1DT2H30M`, `-P2W`, `PT0S`.
 * A hand-written scanner, so it takes time in proportion to the text and no more.
 */
export function parseDuration(text: string): Duration | null {
  const s = String(text).trim().toUpperCase();
  let i = 0;
  let sign: 1 | -1 = 1;
  if (s[i] === "+" || s[i] === "-") sign = s[i++] === "-" ? -1 : 1;
  if (s[i++] !== "P") return null;
  const d: Duration = { sign, weeks: 0, days: 0, seconds: 0 };
  let inTime = false;
  let any = false;
  // The units allowed next, in order; each may come once.
  let order = "WD";
  const scale: Record<string, number> = { H: 3600, M: 60, S: 1 };
  while (i < s.length) {
    if (s[i] === "T") {
      if (inTime || d.weeks) return null;
      inTime = true;
      order = "HMS";
      i++;
      if (i >= s.length) return null;
      continue;
    }
    const from = i;
    while (i < s.length && isDigit(s, i) && i - from < 9) i++;
    if (i === from) return null;
    const n = Number(s.slice(from, i));
    const unit = s[i++];
    const at = order.indexOf(unit);
    if (!unit || at < 0) return null;
    order = order.slice(at + 1);
    any = true;
    if (unit === "W") {
      d.weeks = n;
      if (i !== s.length) return null;
    } else if (unit === "D") {
      d.days = n;
      order = "";
    } else d.seconds += n * scale[unit];
  }
  return any ? d : null;
}

/** A duration as RFC 5545 writes it: `-PT1H`, `-P1DT30M`, `PT0S`. */
export function formatDuration(d: Duration): string {
  const sign = d.sign < 0 && (d.weeks || d.days || d.seconds) ? "-" : "";
  if (d.weeks && !d.days && !d.seconds) return `${sign}P${d.weeks}W`;
  const days = d.weeks * 7 + d.days;
  const h = Math.floor(d.seconds / 3600);
  const m = Math.floor((d.seconds % 3600) / 60);
  const sec = d.seconds % 60;
  // dur-hour, dur-minute and dur-second follow each other without a gap: PT1H0M5S, not PT1H5S.
  let time = "";
  if (h) time += `${h}H`;
  if (m || (h && sec)) time += `${m}M`;
  if (sec) time += `${sec}S`;
  if (!days && !time) return "PT0S";
  return `${sign}P${days ? `${days}D` : ""}${time ? `T${time}` : ""}`;
}

/** A difference in seconds as a duration. */
export const secondsDuration = (seconds: number): Duration => ({ sign: seconds < 0 ? -1 : 1, weeks: 0, days: Math.floor(Math.abs(seconds) / 86400), seconds: Math.abs(seconds) % 86400 });

// ── Times, kept as written: local (no offset), or with the offset they were given ──

const ZONE = (s: string): string => {
  if (s.length <= 10) return "";
  if (s.endsWith("Z")) return "Z";
  const tail = s.slice(-6);
  return (tail[0] === "+" || tail[0] === "-") && tail[3] === ":" ? tail : "";
};

const p2 = (n: number) => String(n).padStart(2, "0");

/** The clock reading of a date or timestamp, in seconds, as if it were UTC: what wall-clock arithmetic works on. */
export function wallSeconds(iso: string): number {
  const n = (a: number, b: number) => Number(iso.slice(a, b) || 0);
  return Date.UTC(n(0, 4), n(5, 7) - 1, n(8, 10), n(11, 13), n(14, 16), n(17, 19)) / 1000;
}

/** A date or timestamp moved by a duration on the clock it was written with, and written back the same way (with seconds). */
export function shiftTime(iso: string, d: Duration): string {
  const zone = ZONE(iso);
  const t = new Date((wallSeconds(iso) + d.sign * ((d.weeks * 7 + d.days) * 86400 + d.seconds)) * 1000);
  const day = `${String(t.getUTCFullYear()).padStart(4, "0")}-${p2(t.getUTCMonth() + 1)}-${p2(t.getUTCDate())}`;
  return `${day}T${p2(t.getUTCHours())}:${p2(t.getUTCMinutes())}:${p2(t.getUTCSeconds())}${zone}`;
}

const ZERO: Duration = { sign: 1, weeks: 0, days: 0, seconds: 0 };

/** True when a time has no offset: a local time (or a day). */
export const isLocalTime = (iso: string): boolean => !ZONE(iso);

/**
 * The moment a time names, in milliseconds: one without an offset is read in
 * `timeZone` (an IANA name) when given, else in this computer's time zone.
 */
export function instant(iso: string, timeZone?: string): number {
  if (!isLocalTime(iso)) return Date.parse(iso);
  if (timeZone) return zonedInstant(wallSeconds(iso) * 1000, timeZone);
  const n = (a: number, b: number) => Number(iso.slice(a, b) || 0);
  return new Date(n(0, 4), n(5, 7) - 1, n(8, 10), n(11, 13), n(14, 16), n(17, 19)).getTime();
}

// ── Front matter `remind` ──────────────────────────────────────────────────

/** The `remind` values of an event or note, as written: one, or a list. */
export function remindValues(meta: Record<string, unknown>): string[] {
  const raw = metaValue(meta, "remind");
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  return list.map((v) => (v instanceof Date ? v.toISOString() : String(v)).trim()).filter(Boolean);
}

export type RemindValue = { kind: "duration"; duration: Duration } | { kind: "time"; at: string } | { kind: "problem"; problem: string };

/** One `remind` value: an RFC 5545 duration from `start`, or an ISO 8601 date-time (a day alone is at 09:00). */
export function readRemind(value: string): RemindValue {
  const s = value.trim();
  const c = s[0]?.toUpperCase();
  if (c === "P" || c === "-" || c === "+") {
    const duration = parseDuration(s);
    return duration ? { kind: "duration", duration } : { kind: "problem", problem: `"${s}" isn't an RFC 5545 duration like -PT1H or -P1D` };
  }
  const iso = dateField(s.length > 10 && s[10] === " " ? `${s.slice(0, 10)}T${s.slice(11)}` : s);
  if (!iso) return { kind: "problem", problem: `"${s}" isn't an ISO 8601 date-time like 2026-11-01T09:00 or a duration like -PT1H` };
  return { kind: "time", at: shiftTime(iso.length === 10 ? `${iso}T${DEFAULT_REMINDER_TIME}` : iso.replace(/\.\d+/, ""), ZERO) };
}

// ── Listing them ───────────────────────────────────────────────────────────

export interface Reminder {
  /** Stable while the reminder is unchanged: the file, which reminder of it, and its time. A poller can remember which it has told. */
  id: string;
  /** When: an ISO 8601 timestamp, local (no offset) or with the offset it was written with. */
  at: string;
  /** Its time has come and what it is about hasn't been dealt with. */
  due: boolean;
  title: string;
  path: string;
  /** For a to-do: its line and words. */
  line?: number;
  text?: string;
  /** The `remind` value as written, for an event or note. */
  remind?: string;
  /** The `start` (occurrence) or 📅 date it is about. */
  about?: string;
  /** A `remind` GitRoll could not read; `at` is empty. */
  problem?: string;
}

export interface ReminderOptions {
  /** The present moment. */
  now: Date;
  /** The last day (YYYY-MM-DD, inclusive) of reminders still to come to list. Omit for every one. */
  to?: string;
  /** Only the ones that are due. */
  dueOnly?: boolean;
  /** The IANA time zone local times and "today" are read in; this computer's when omitted. */
  timeZone?: string;
}

const endOfDay = (iso: string, timeZone?: string): number => instant(shiftTime(`${iso.slice(0, 10)}T00:00:00${ZONE(iso)}`, { ...ZERO, days: 1 }), timeZone);

/**
 * Every reminder: the due ones first, then the ones still to come by time, then
 * any `remind` that couldn't be read. One that came and whose subject is over
 * (a to-do ticked off, an event's day gone) is left out.
 */
export function reminders(entries: Entry[], todos: (Todo & { title?: string })[], opts: ReminderOptions): Reminder[] {
  const now = opts.now.getTime();
  const zone = opts.timeZone;
  const today = isoDateIn(opts.now, zone);
  const to = opts.to ?? "9999-12-31";
  const out: Reminder[] = [];
  const problems: Reminder[] = [];
  const add = (r: Omit<Reminder, "due">, until: number | null) => {
    const when = instant(r.at, zone);
    if (when <= now) {
      if (until !== null && now >= until) return;
      out.push({ ...r, due: true });
    } else if (!opts.dueOnly && r.at.slice(0, 10) <= to) out.push({ ...r, due: false });
  };
  for (const t of todos) {
    if (t.done) continue;
    const r = taskReminder(t.text);
    if (!r) continue;
    const title = reminderTitle(t.text);
    const due = taskDates(t.text).due;
    add({ id: `${t.path}#todo-${slugify(title) || t.line}@${r.at}`, at: r.at, title, path: t.path, line: t.line, text: t.text, ...(due ? { about: due } : {}) }, null);
  }
  for (const e of entries) {
    const values = remindValues(e.meta);
    if (!values.length) continue;
    const start = dateField(metaValue(e.meta, "start"));
    const end = dateField(metaValue(e.meta, "end"));
    const rawRule = metaValue(e.meta, "rrule");
    let rule = null;
    try {
      rule = start && typeof rawRule === "string" && rawRule.trim() ? parseRRule(rawRule) : null;
    } catch {
      rule = null; // the calendar reports it; the start alone still has its reminders
    }
    const untilOf = (o: string) => Math.max(endOfDay(o, zone), !rule && end ? (end.length === 10 ? endOfDay(end, zone) : instant(end, zone)) : 0);
    values.forEach((value, n) => {
      const id = `${e.path}#remind-${n + 1}`;
      const read = readRemind(value);
      if (read.kind === "problem") {
        problems.push({ id, at: "", due: false, title: e.title, path: e.path, remind: value, problem: read.problem });
      } else if (read.kind === "time") {
        add({ id: `${id}@${read.at}`, at: read.at, title: e.title, path: e.path, remind: value, ...(start ? { about: start } : {}) }, start ? untilOf(start) : null);
      } else if (!start) {
        problems.push({ id, at: "", due: false, title: e.title, path: e.path, remind: value, problem: `${value} counts from start, and there is no start` });
      } else {
        const d = read.duration;
        const reach = Math.ceil((d.weeks * 7 + d.days + d.seconds / 86400) + 2);
        const from = addDays(today, -reach);
        const last = to === "9999-12-31" ? addDays(today, 3660) : addDays(to, reach);
        const starts = rule ? occurrences(start, rule, from, last) : [start];
        for (const o of starts) {
          const at = shiftTime(o.length === 10 ? `${o}T00:00:00` : o, d);
          add({ id: `${id}@${at}`, at, title: e.title, path: e.path, remind: value, about: o }, untilOf(o));
        }
      }
    });
  }
  out.sort((a, b) => Number(b.due) - Number(a.due) || instant(a.at, zone) - instant(b.at, zone) || a.title.localeCompare(b.title));
  return opts.dueOnly ? out : [...out, ...problems];
}

/**
 * `gitroll upcoming` with reminders: the calendar from today to `days` ahead,
 * and each reminder in that time (kind `reminder`); due ones and overdue to-dos first.
 * `today` should be the date at `now` in `timeZone` (isoDateIn).
 */
export function upcomingWithReminders(entries: Entry[], todos: (Todo & { title?: string })[], today: string, days = 30, now = new Date(), timeZone?: string): CalendarItem[] {
  const items = upcoming(entries, todos, today, days);
  const extra: CalendarItem[] = reminders(entries, todos, { now, to: addDays(today, days), timeZone })
    .filter((r) => !r.problem)
    .map((r) => ({
      date: r.at,
      kind: "reminder" as const,
      title: r.title,
      path: r.path,
      ...(r.line !== undefined ? { line: r.line, text: r.text } : {}),
      ...(r.remind ? { remind: r.remind } : {}),
      ...(r.due ? { due: true } : {}),
    }));
  const first = (i: CalendarItem) => (i.due ? 0 : i.overdue ? 1 : 2);
  return [...items, ...extra].sort((a, b) => first(a) - first(b) || a.date.slice(0, 10).localeCompare(b.date.slice(0, 10)) || a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
}
