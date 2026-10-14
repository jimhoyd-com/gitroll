// ARCHIVE. An event or a note with `archived:` in its front matter is kept but
// out of the way: a contact you've lost touch with, a thing you sold, a page
// that no longer applies, a bookmark that went dead.
//
//   archived: 2026-10-14     archived, on that day
//   archived: true           archived, with no day given
//
// It is the opposite of a pin. Lists of what is current (the timeline, a
// search, notes, a collection's table, to-dos, the calendar, contacts and the
// other collection views) leave it out unless they are asked for it; totals of
// what happened (the ledger, series, time) still count it, since archiving
// something doesn't undo that it happened. Nothing moves and nothing is
// deleted, so links to it, its history and its backlinks are as they were.

import type { Entry } from "./entry.ts";
import { metaValue } from "./calendar.ts";
import { parseQuery } from "./search.ts";

export const ARCHIVED_FIELD = "archived";

/** Whether a document is archived: its `archived` field has a value other than `false` or empty (the key in any case). */
export function isArchived(e: Entry): boolean {
  const v = metaValue(e.meta, ARCHIVED_FIELD);
  return !(v == null || v === "" || v === false || (Array.isArray(v) && !v.length));
}

/**
 * Whether a search asks for archived documents: `is:archived`, `has:archived`,
 * or a query on the `archived` field itself (`archived:2026`, `archived>=2026-01-01`).
 */
export function asksForArchived(query: string): boolean {
  if (!query.trim()) return false;
  const q = parseQuery(query);
  return q.marks.includes("archived") || q.has.includes(ARCHIVED_FIELD) || [...q.fields, ...q.compares].some((f) => f.key.toLowerCase() === ARCHIVED_FIELD);
}

/** The documents that aren't archived, unless `query` asks for archived ones, in which case all of them. */
export function current<T extends Entry>(docs: T[], query = ""): T[] {
  return asksForArchived(query) ? docs : docs.filter((d) => !isArchived(d));
}
