// What time an entry says it happened, and which day it is therefore filed on.
//
// Three things are kept apart on purpose:
//
//   occurrence   when it happened, as the author wrote it — a day, or a moment
//                with its UTC offset
//   filing date  the calendar day the occurrence falls on in the Roll's zone,
//                decided once, when the entry is created, and then a fact
//   created      when GitRoll wrote it down
//
// Ingestion time is never quietly used as an occurrence. An import with no
// usable timestamp gets an undated entry and says so, which is honest, rather
// than an entry claiming to have happened when the importer happened to run.

import { normalizeDate } from "./entry.ts";
import { filingDateFor, formatInZone, instantFromLocal, resolveLocal } from "./tz.ts";
import { UserError } from "./util.ts";

/** How far ahead an occurrence may be before GitRoll treats it as a mistake. */
export const FUTURE_LIMIT_DAYS = 366;

export interface Occurrence {
  /** What goes in `date:`. null for an entry nobody dated. */
  date: string | null;
  /** What goes in `filed:`. null only when there is no date at all. */
  filed: string | null;
  /** Things worth telling the person, e.g. that a local time was ambiguous. */
  notices: string[];
}

export interface OccurrenceOptions {
  /** What to do with a wall time that happened twice (the clocks went back). */
  ambiguous?: "earlier" | "later" | "reject";
  /** What to do with a wall time that never happened (the clocks went forward). */
  nonexistent?: "shift" | "reject";
  /** Allow a date far in the future, e.g. a booking. Off by default so a typo is caught. */
  allowFuture?: boolean;
  now?: Date;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const HAS_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/;
const WALL = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/;

/**
 * Turns whatever a person, an importer or a CLI flag supplied into an
 * occurrence and a filing date, in the Roll's zone.
 */
export function resolveOccurrence(input: string | null | undefined, tz: string, opts: OccurrenceOptions = {}): Occurrence {
  const raw = (input ?? "").trim();
  if (!raw) return { date: null, filed: null, notices: [] };
  const notices: string[] = [];

  // A day someone typed is a day. No midnight is invented for it, and no zone
  // conversion may move it: 2026-09-15 is the 15th wherever the Roll is opened.
  if (DATE_ONLY.test(raw)) {
    if (!normalizeDate(raw)) throw new UserError(`Invalid date: ${input} (use 2026-09-15)`);
    checkFuture(`${raw}T00:00:00Z`, opts, notices);
    return { date: raw, filed: raw, notices };
  }

  if (HAS_OFFSET.test(raw)) {
    const date = normalizeDate(raw.replace(" ", "T"));
    if (!date) throw new UserError(`Invalid date/time: ${input} (use 2026-09-15T14:30:00-05:00)`);
    checkFuture(date, opts, notices);
    return { date, filed: filingDateFor(date, tz), notices };
  }

  // A time with no offset is a wall clock reading, and the Roll's zone is what
  // it is read in — never the device's. Twice a year that reading is ambiguous
  // or impossible, and GitRoll says which rather than choosing in silence.
  if (WALL.test(raw)) {
    const local = raw.replace(" ", "T");
    const resolution = resolveLocal(local, tz);
    if (resolution.kind === "ambiguous") notices.push(`${local} happened twice in ${tz} that night; kept the ${opts.ambiguous === "later" ? "second" : "first"}.`);
    if (resolution.kind === "nonexistent") notices.push(`${local} never happened in ${tz} (the clocks went forward); moved to the instant the clocks jumped to.`);
    const instant = instantFromLocal(local, tz, { ambiguous: opts.ambiguous ?? "earlier", nonexistent: opts.nonexistent ?? "shift" });
    const date = formatInZone(instant, tz);
    checkFuture(date, opts, notices);
    return { date, filed: filingDateFor(date, tz), notices };
  }

  throw new UserError(`Invalid date/time: ${input} (use 2026-09-15, or 2026-09-15T14:30:00-05:00)`);
}

function checkFuture(date: string, opts: OccurrenceOptions, notices: string[]): void {
  const at = new Date(date).getTime();
  if (Number.isNaN(at)) return;
  const ahead = (at - (opts.now ?? new Date()).getTime()) / 86_400_000;
  if (ahead <= FUTURE_LIMIT_DAYS) return;
  if (!opts.allowFuture) {
    throw new UserError(
      `${date} is more than a year from now. If that's really when it happened, log it again with --allow-future; otherwise check the date.`,
    );
  }
  notices.push(`${date} is more than a year in the future.`);
}
