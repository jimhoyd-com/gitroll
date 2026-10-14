// TIME. Where the hours went, read from files that already exist, the way the
// ledger reads where the money went. An event or a note with a `duration`
// is time spent:
//
//   duration: PT1H30M      an ISO 8601 duration, as iCalendar's DURATION writes it
//   duration: 1h30m        also read: 1h 30m, 90m, 90 min, 1.5h, 2 hours, 1:30
//
// A bare number isn't read (minutes or hours?) and is reported as left out,
// never guessed. Durations are added up overall and, with `by`, per day, week,
// month, year, project, tag or any field, like the ledger's groups. This is a
// view, not a timesheet system: `toTimeclock` writes the same entries for
// hledger's timeclock format, so billing happens in a tool built for it.

import type { Entry } from "./entry.ts";
import { metaValue } from "./calendar.ts";
import { fieldValue } from "./fields.ts";
import { parseDuration } from "./reminders.ts";
import { isoWeek } from "./series.ts";
import { accountPart } from "./ledger.ts";

export const DURATION_FIELD = "duration";

/**
 * Seconds in a duration as written: ISO 8601 (`PT1H30M`, `P1D`, `P1W`), or
 * the short forms people type (`1h30m`, `1h 30m`, `90m`, `45 min`, `1.5h`,
 * `2 hours`, `1:30`). Null for anything else, a bare number and a negative
 * duration included.
 */
export function durationSeconds(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  if (!s) return null;
  if (s.startsWith("p")) {
    const d = parseDuration(s);
    return d && d.sign > 0 ? (d.weeks * 7 + d.days) * 86_400 + d.seconds : null;
  }
  const clock = /^(\d{1,4}):([0-5]\d)(?::([0-5]\d))?$/.exec(s);
  if (clock) return Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3] ?? 0);
  // Number-and-unit pairs, scanned by hand so no input can make a pattern backtrack.
  const scale: Record<string, number> = { h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600, m: 60, min: 60, mins: 60, minute: 60, minutes: 60, s: 1, sec: 1, secs: 1, second: 1, seconds: 1 };
  let i = 0;
  let total = 0;
  let parts = 0;
  const skipSpace = () => {
    while (s[i] === " ") i++;
  };
  while (i < s.length) {
    skipSpace();
    const from = i;
    while (i < s.length && /[\d.]/.test(s[i]) && i - from < 12) i++;
    const n = Number(s.slice(from, i));
    if (i === from || !Number.isFinite(n)) return null;
    skipSpace();
    const unitFrom = i;
    while (i < s.length && s[i] >= "a" && s[i] <= "z") i++;
    const unit = scale[s.slice(unitFrom, i)];
    if (!unit) return null;
    total += n * unit;
    parts++;
    skipSpace();
    if (s[i] === ",") i++;
  }
  return parts ? Math.round(total) : null;
}

/** Seconds as people read them: `1h 30m`, `45m`, `2h`, `0m`. */
export function formatSeconds(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

export interface TimeEntry {
  /** YYYY-MM-DD, or null when nothing dates it. */
  date: string | null;
  title: string;
  path: string;
  seconds: number;
  /** The `duration` as written. */
  duration: string;
  projects: string[];
  tags: string[];
}

export interface TimeGroup {
  key: string;
  seconds: number;
  count: number;
}

export interface TimeView {
  by: string | null;
  total: { seconds: number; count: number };
  groups: TimeGroup[];
  entries: TimeEntry[];
  /** Documents with a `duration` that couldn't be read, so aren't in the totals. */
  skipped: { path: string; title: string; duration: string }[];
}

const day = (s: string | null): string | null => (s ? s.slice(0, 10) : null);
const textOf = (v: unknown): string => (v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === "object" && v ? JSON.stringify(v) : String(v));

/** The groups one entry belongs to: one for a period or a field; one per project or tag (so those groups can overlap). */
function keysOf(e: TimeEntry, by: string, doc: Entry | undefined): string[] {
  switch (by.toLowerCase()) {
    case "day":
      return [e.date ?? "undated"];
    case "week":
      return [e.date ? isoWeek(e.date) : "undated"];
    case "month":
      return [e.date ? e.date.slice(0, 7) : "undated"];
    case "year":
      return [e.date ? e.date.slice(0, 4) : "undated"];
    case "project":
    case "projects":
      return e.projects.length ? e.projects : ["(none)"];
    case "tag":
    case "tags":
      return e.tags.length ? e.tags : ["(none)"];
  }
  const v = doc ? fieldValue(doc, by) : undefined;
  if (v == null || v === "") return ["(none)"];
  return Array.isArray(v) ? (v.length ? v.map(textOf) : ["(none)"]) : [textOf(v)];
}

const PERIODS = ["day", "week", "month", "year"];

/** Time spent, overall and (with `by`) per group, from each document's `duration`. */
export function timeSpent(docs: Entry[], by?: string): TimeView {
  const entries: TimeEntry[] = [];
  const skipped: TimeView["skipped"] = [];
  for (const d of docs) {
    const raw = metaValue(d.meta, DURATION_FIELD);
    if (raw == null || raw === "") continue;
    const seconds = durationSeconds(raw);
    if (seconds === null) {
      skipped.push({ path: d.path, title: d.title, duration: textOf(raw) });
      continue;
    }
    entries.push({ date: day(d.date), title: d.title, path: d.path, seconds, duration: String(raw).trim(), projects: d.projects, tags: d.tags });
  }
  entries.sort((a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999") || a.path.localeCompare(b.path));
  const docOf = new Map(docs.map((d) => [d.path, d]));
  const groups = new Map<string, TimeGroup>();
  if (by) {
    for (const e of entries) {
      for (const key of keysOf(e, by, docOf.get(e.path))) {
        const g = groups.get(key) ?? { key, seconds: 0, count: 0 };
        g.seconds += e.seconds;
        g.count++;
        groups.set(key, g);
      }
    }
  }
  const periodic = by && PERIODS.includes(by.toLowerCase());
  const special = (k: string) => (k === "undated" || k === "(none)" ? 1 : 0);
  const sorted = [...groups.values()].sort((a, b) => special(a.key) - special(b.key) || (periodic ? a.key.localeCompare(b.key) : b.seconds - a.seconds || a.key.localeCompare(b.key)));
  return {
    by: by ?? null,
    total: { seconds: entries.reduce((n, e) => n + e.seconds, 0), count: entries.length },
    groups: sorted,
    entries,
    skipped,
  };
}

/**
 * The entries in hledger's timeclock format: a clock-in at midnight of the day
 * and a clock-out the duration later, under the first project (else tag). The
 * time of day isn't known, only how long, and hledger's reports use only that.
 * Undated entries can't be clocked; they're listed in a comment at the end.
 */
export function toTimeclock(entries: TimeEntry[]): string {
  const out = ["; Time from a GitRoll log: how long, not when in the day. Read it with hledger -f <file> balance.", ""];
  const undated: TimeEntry[] = [];
  const pad = (n: number) => String(n).padStart(2, "0");
  for (const e of entries) {
    if (!e.date) {
      undated.push(e);
      continue;
    }
    const end = new Date(Date.UTC(Number(e.date.slice(0, 4)), Number(e.date.slice(5, 7)) - 1, Number(e.date.slice(8, 10))) + e.seconds * 1000);
    const at = `${end.getUTCFullYear()}-${pad(end.getUTCMonth() + 1)}-${pad(end.getUTCDate())} ${pad(end.getUTCHours())}:${pad(end.getUTCMinutes())}:${pad(end.getUTCSeconds())}`;
    const description = e.title.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/;/g, ",").trim() || "(untitled)";
    out.push(`i ${e.date} 00:00:00 ${accountPart(e.projects[0] ?? e.tags[0] ?? "unknown")}  ${description}`, `o ${at}`, "");
  }
  if (undated.length) {
    out.push("; Undated, so not clocked:");
    for (const e of undated) out.push(`;   ${e.title.replace(/[\x00-\x1f\x7f]+/g, " ")}  ${formatSeconds(e.seconds)}  (${e.path})`);
    out.push("");
  }
  return out.join("\n");
}
