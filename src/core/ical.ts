// An iCalendar file (RFC 5545) of a Roll's calendar: what `gitroll calendar --ics` writes.
//
// - Lines end in CRLF and are folded at 75 octets (counted in UTF-8, never
//   inside a character), continuing with a single space.
// - Text is escaped: backslash, semicolon, comma, and newlines as \n.
// - A repeating item carries its RRULE; occurrences are never expanded.
// - Each item's UID is made from its file's path and which item of the file it is,
//   so importing the file again updates the same items instead of adding copies.

import type { Entry } from "./entry.ts";
import type { Todo } from "./todos.ts";
import { DUE_FIELDS, RRuleError, addDays, dateField, formatRRule, linkText, metaValue, parseRRule, recurrenceRule, taskDates } from "./calendar.ts";
import { slugify } from "./util.ts";

/** Escapes a TEXT value (RFC 5545 §3.3.11). Other control characters are dropped. */
export function escapeText(s: string): string {
  let out = "";
  for (const ch of s.replace(/\r\n?/g, "\n")) {
    if (ch === "\\") out += "\\\\";
    else if (ch === ";") out += "\\;";
    else if (ch === ",") out += "\\,";
    else if (ch === "\n") out += "\\n";
    else if (ch < " " || ch === "\x7f") continue;
    else out += ch;
  }
  return out;
}

const utf8Length = (ch: string): number => {
  const c = ch.codePointAt(0)!;
  return c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
};

/** Folds one content line so no physical line is longer than 75 octets (RFC 5545 §3.1). */
export function foldLine(line: string): string {
  const parts: string[] = [];
  let current = "";
  let size = 0;
  for (const ch of line) {
    const n = utf8Length(ch);
    // The first line holds 75 octets; each continuation spends one on its leading space.
    if (size + n > 75) {
      parts.push(current);
      current = " ";
      size = 1;
    }
    current += ch;
    size += n;
  }
  parts.push(current);
  return parts.join("\r\n");
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** A UTC moment as an iCalendar DATE-TIME: 20261007T143000Z. */
export function utcStamp(d: Date): string {
  return `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

const hasZone = (s: string): boolean => s.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(s);

/**
 * A property carrying an ISO 8601 date or timestamp: a date is VALUE=DATE, a
 * time with a zone or offset is written in UTC, and a time without one is a
 * floating local time, as it was written.
 */
export function dateProperty(name: string, iso: string): string {
  if (iso.length === 10) return `${name};VALUE=DATE:${iso.replace(/-/g, "")}`;
  if (hasZone(iso)) return `${name}:${utcStamp(new Date(iso))}`;
  const [day, time] = iso.split("T");
  const [h, m, s = "00"] = time.split(":");
  return `${name}:${day.replace(/-/g, "")}T${h}${m}${s.slice(0, 2)}`;
}

/** An RRULE line for a start, re-written from the parsed rule when GitRoll understands it, else as written when it is well-formed. */
function rruleLine(text: string, start: string): string | null {
  try {
    return `RRULE:${formatRRule(parseRRule(text), start)}`;
  } catch (e) {
    if (!(e instanceof RRuleError)) throw e;
    const raw = text.trim().replace(/^RRULE:/i, "").toUpperCase();
    // Something another calendar may understand (BYMONTHDAY, BYSETPOS …): pass it on if it has the RRULE shape.
    const parts = raw.split(";");
    const wellFormed = parts.every((p) => /^[A-Z-]+=[A-Z0-9,+:-]+$/.test(p)) && parts.some((p) => p.startsWith("FREQ="));
    return wellFormed ? `RRULE:${raw}` : null;
  }
}

export interface ICalendarOptions {
  /** The calendar's name. */
  name?: string;
  /** DTSTAMP: when this file was made. */
  now?: Date;
  /** Events dated on or after this day (YYYY-MM-DD) are included when they have no `start`. */
  today?: string;
}

/**
 * The Roll's calendar as an RFC 5545 VCALENDAR: an event for each `start`
 * (with its RRULE), for each event dated today or later, and for each due-ish
 * date field, and a to-do (VTODO) for each open to-do with a 📅 date.
 */
export function toICalendar(entries: Entry[], todos: (Todo & { title?: string })[], opts: ICalendarOptions = {}): string {
  const stamp = `DTSTAMP:${utcStamp(opts.now ?? new Date())}`;
  const lines: string[] = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//GitRoll//GitRoll//EN", "CALSCALE:GREGORIAN"];
  if (opts.name) lines.push(`NAME:${escapeText(opts.name)}`, `X-WR-CALNAME:${escapeText(opts.name)}`);
  const uids = new Set<string>();
  const uid = (path: string, part: string): string => {
    const base = `${path}#${part}`;
    let id = base;
    for (let n = 2; uids.has(id); n++) id = `${base}-${n}`;
    uids.add(id);
    return `UID:${escapeText(id)}`;
  };
  for (const e of entries) {
    const start = dateField(metaValue(e.meta, "start"));
    const dated = !start && e.path.toLowerCase().startsWith(".gitroll/events/") && e.date && (!opts.today || e.date.slice(0, 10) >= opts.today) ? e.date : null;
    const begin = start ?? dated;
    if (begin) {
      lines.push("BEGIN:VEVENT", uid(e.path, "start"), stamp, dateProperty("DTSTART", begin));
      const end = dateField(metaValue(e.meta, "end"));
      if (end && end >= begin && (end.length === 10) === (begin.length === 10)) {
        // An all-day end is exclusive in iCalendar; in a Roll it is the last day.
        lines.push(dateProperty("DTEND", end.length === 10 ? addDays(end, 1) : end));
      }
      lines.push(`SUMMARY:${escapeText(e.title)}`);
      const location = metaValue(e.meta, "location");
      if (typeof location === "string" && location.trim()) lines.push(`LOCATION:${escapeText(linkText(location))}`);
      const rrule = metaValue(e.meta, "rrule");
      if (start && typeof rrule === "string" && rrule.trim()) {
        const line = rruleLine(rrule, start);
        if (line) lines.push(line);
      }
      lines.push(`DESCRIPTION:${escapeText(e.path)}`, "END:VEVENT");
    }
    for (const field of DUE_FIELDS) {
      const key = Object.keys(e.meta).find((k) => k.toLowerCase() === field);
      const day = key ? dateField(e.meta[key])?.slice(0, 10) : null;
      if (!key || !day) continue;
      lines.push("BEGIN:VEVENT", uid(e.path, key), stamp, dateProperty("DTSTART", day), `SUMMARY:${escapeText(`${e.title}: ${key}`)}`, `DESCRIPTION:${escapeText(e.path)}`, "END:VEVENT");
    }
  }
  for (const t of todos) {
    if (t.done) continue;
    const dates = taskDates(t.text);
    if (!dates.due) continue;
    const summary = dates.text || t.text;
    lines.push("BEGIN:VTODO", uid(t.path, `todo-${slugify(summary) || t.line}`), stamp);
    if (dates.recurrence) lines.push(dateProperty("DTSTART", dates.due));
    lines.push(dateProperty("DUE", dates.due), `SUMMARY:${escapeText(summary)}`, "STATUS:NEEDS-ACTION");
    if (dates.recurrence && !dates.recurrence.whenDone) lines.push(`RRULE:${formatRRule(recurrenceRule(dates.recurrence), dates.due)}`);
    lines.push(`DESCRIPTION:${escapeText(`${t.path}:${t.line}`)}`, "END:VTODO");
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}
