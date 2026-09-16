// One Roll, one time zone. Every part of GitRoll — the app, the CLI, imports,
// sync, indexing and archival — decides *which day something is filed under*
// here, so no two of them can disagree.
//
// The rules, in one place:
//
//   • A timed event keeps the moment it happened, offset and all
//     (2026-10-01T02:00:00Z). Its **filing date** is the calendar day that
//     moment falls on in the Roll's zone — September 30 in America/Chicago —
//     and that day is written into the entry when it is created.
//   • A date-only event is a day someone typed. It is filed on that day,
//     untouched: no midnight is invented for it and no zone can shift it.
//   • A filing date, once written, is a fact about the entry. Changing the
//     Roll's zone changes where *new* entries go, never where old ones live.
//
// Nothing here reads the device's zone, so the same Roll files the same way on
// a laptop in Chicago and a server in UTC.

import { UserError } from "./util.ts";

/** A wall-clock reading in some zone. */
export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = FORMATTERS.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        era: "short",
      });
    } catch {
      throw new UserError(`Unknown time zone: ${tz} (use an IANA name such as America/Chicago)`);
    }
    FORMATTERS.set(tz, f);
  }
  return f;
}

/** True when `tz` is a time zone this platform knows. */
export function isValidZone(tz: string): boolean {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

/** Throws a readable error rather than filing an entry under a zone nobody can resolve. */
export function requireZone(tz: string): string {
  formatter(tz);
  return tz;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** What the clock says in `tz` at `instant`. */
export function zonedParts(instant: Date, tz: string): ZonedParts {
  const parts: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(instant)) parts[p.type] = p.value;
  const year = Number(parts.year) * (parts.era === "BC" || parts.era === "B" ? -1 : 1);
  return {
    year,
    month: Number(parts.month),
    day: Number(parts.day),
    // Some locales render midnight as 24.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** The calendar day `instant` falls on in `tz`, as YYYY-MM-DD. */
export function zonedDay(instant: Date, tz: string): string {
  const p = zonedParts(instant, tz);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

/** The zone's offset from UTC, in minutes, at `instant`. East of Greenwich is positive. */
export function offsetMinutes(instant: Date, tz: string): number {
  const p = zonedParts(instant, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60_000);
}

/** 2026-09-15T14:30:00-05:00 — the moment, written in the Roll's zone. */
export function formatInZone(instant: Date, tz: string): string {
  const p = zonedParts(instant, tz);
  const off = offsetMinutes(instant, tz);
  const sign = off < 0 ? "-" : "+";
  const abs = Math.abs(off);
  return (
    `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

export type LocalKind = "ok" | "ambiguous" | "nonexistent";

export interface LocalResolution {
  kind: LocalKind;
  /**
   * The instants the wall time maps to: one normally, two when the clocks went
   * back, and for a time that never happened the instant the clocks jumped to
   * (so a caller that chooses to go on has something sane to use).
   */
  instants: Date[];
  /** The wall time as asked for, echoed back for error messages. */
  local: string;
}

const WALL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * Turns a wall-clock reading in `tz` into the moment it names.
 *
 * Twice a year that question has no single answer, and GitRoll says so rather
 * than picking one quietly: on the night the clocks go back, 01:30 happens
 * twice, and on the night they go forward, 02:30 never happens at all. The
 * caller decides — keep the earlier instant, the later one, or ask.
 */
export function resolveLocal(local: string, tz: string): LocalResolution {
  const m = WALL.exec(local.trim());
  if (!m) throw new UserError(`Invalid local date/time: ${local} (use 2026-09-15T14:30)`);
  const [y, mo, d, h, mi, s = 0] = m.slice(1).map((v) => Number(v ?? 0));
  const wallUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  // Two guesses bracket every real zone: the offset a day either side of the
  // reading. Where they agree there is one answer; where they differ the
  // reading sits on a transition.
  const candidates = new Set<number>();
  for (const guess of [wallUtc - 86_400_000, wallUtc + 86_400_000]) {
    const off = offsetMinutes(new Date(guess), tz);
    const instant = wallUtc - off * 60_000;
    // Keep it only when the zone really reads back the wall time we asked for.
    if (matchesWall(new Date(instant), tz, [y, mo, d, h, mi, s])) candidates.add(instant);
  }
  const instants = [...candidates].sort((a, b) => a - b).map((t) => new Date(t));
  if (instants.length === 1) return { kind: "ok", instants, local };
  if (instants.length > 1) return { kind: "ambiguous", instants, local };
  // Nothing matched: the clocks jumped over this reading. Offer the instant the
  // jump landed on, which is the wall time read with the offset after the change.
  const after = wallUtc - offsetMinutes(new Date(wallUtc + 86_400_000), tz) * 60_000;
  return { kind: "nonexistent", instants: [new Date(after)], local };
}

function matchesWall(instant: Date, tz: string, [y, mo, d, h, mi, s]: number[]): boolean {
  const p = zonedParts(instant, tz);
  return p.year === y && p.month === mo && p.day === d && p.hour === h && p.minute === mi && p.second === s;
}

/**
 * The instant a wall time names, with the caller's answer for the twice-a-year
 * questions. "earlier"/"later" pick a side of an ambiguous reading; a time that
 * never happened is refused unless `onNonexistent` says to move it forward.
 */
export function instantFromLocal(
  local: string,
  tz: string,
  opts: { ambiguous?: "earlier" | "later" | "reject"; nonexistent?: "shift" | "reject" } = {},
): Date {
  const r = resolveLocal(local, tz);
  if (r.kind === "ok") return r.instants[0];
  if (r.kind === "ambiguous") {
    const how = opts.ambiguous ?? "reject";
    if (how === "earlier") return r.instants[0];
    if (how === "later") return r.instants[r.instants.length - 1];
    throw new UserError(
      `${local} happened twice in ${tz} (the clocks went back), so GitRoll can't tell which one you mean. ` +
        `Write the offset you mean, for example ${formatInZone(r.instants[0], tz)} or ${formatInZone(r.instants[r.instants.length - 1], tz)}.`,
    );
  }
  if ((opts.nonexistent ?? "reject") === "shift") return r.instants[0];
  throw new UserError(
    `${local} never happened in ${tz} (the clocks went forward). ` + `The clock jumped to ${formatInZone(r.instants[0], tz)}; use that, or another time.`,
  );
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The day an occurrence is filed under.
 *
 * A date-only occurrence is returned as written — it is a day, not a moment, and
 * converting it through a zone would move somebody's entry off the day they
 * chose. A timestamp with an offset is the moment it names, read in the Roll's
 * zone. A timestamp without one has no moment to read, so its own day stands.
 */
export function filingDateFor(occurrence: string, tz: string): string {
  const s = occurrence.trim();
  if (DATE_ONLY.test(s)) return s;
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/.test(s);
  if (!hasOffset) return s.slice(0, 10);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new UserError(`Invalid date/time: ${occurrence}`);
  return zonedDay(d, tz);
}

/** The last instant of a filing period ("2026-09" or "2026-09-16") in `tz`, exclusive. */
export function periodEnd(period: string, tz: string): Date {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(period);
  if (!m) throw new UserError(`Invalid period: ${period}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const day = m[3] ? Number(m[3]) : 0;
  const next = day ? new Date(Date.UTC(y, mo - 1, day + 1)) : new Date(Date.UTC(y, mo, 1));
  const local = `${pad(next.getUTCFullYear(), 4)}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}T00:00:00`;
  const r = resolveLocal(local, tz);
  return r.instants[r.instants.length - 1] ?? new Date(next.getTime());
}
