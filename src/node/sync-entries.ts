// Combining one segment file that two devices both changed.
//
// Git hands a conflict over as three versions of a file. A line-based merge of
// a shared monthly file goes wrong in the obvious way — two people appending
// entries touch the same lines — so GitRoll takes the three versions apart into
// entries, merges those by their permanent ids, and writes the file back. Two
// independent additions both survive, edits to different entries both apply,
// and a real disagreement about one entry keeps both texts with a note, the way
// a conflicted event always has.
//
// Compressed segments are decompressed, merged as entries, and recompressed
// only after the merge settles — a gzip stream is never merged as bytes.

import { parseSegment, renderSegment, segmentHeader } from "../core/grouped.ts";
import { mergeEntrySets } from "../core/merge-entries.ts";
import type { EntryConflict, EntryState } from "../core/merge-entries.ts";
import { parseSegmentPath } from "../core/segments.ts";
import { isoDate } from "../core/util.ts";
import { gunzipText, gzipDeterministic } from "./gzip.ts";
import { parseArchiveYaml, serializeArchiveYaml } from "./store.ts";
import type { ArchiveState } from "./store.ts";

export interface SegmentSides {
  /** The common ancestor, or null when both sides created the file. */
  base: Buffer | null;
  mine: Buffer | null;
  theirs: Buffer | null;
  /** The path Git is conflicting over. */
  path: string;
  day?: string;
}

export interface SegmentMerge {
  /** The bytes to write, compressed when the path says the segment is compressed. */
  data: Buffer;
  conflicts: EntryConflict[];
  /** Entries that belong to another period now and have to be re-filed by the writer. */
  displaced: { id: string; content: string; period: string }[];
  merged: string[];
}

const text = (data: Buffer | null, compressed: boolean): string | null =>
  data === null ? null : compressed ? gunzipText(data) : data.toString("utf8");

/** Merges the three versions of one segment file, entry by entry. */
export function mergeSegment({ base, mine, theirs, path, day = isoDate() }: SegmentSides): SegmentMerge {
  const ref = parseSegmentPath(path);
  const compressed = path.endsWith(".gz");
  const period = ref?.period ?? "";
  const seq = ref?.seq ?? 1;
  const sides = {
    base: sections(text(base, compressed), period, seq, path),
    mine: sections(text(mine, compressed), period, seq, path),
    theirs: sections(text(theirs, compressed), period, seq, path),
  };
  const report = mergeEntrySets({ ...sides, day });

  const header = headerOf(text(mine, compressed)) || headerOf(text(theirs, compressed)) || segmentHeader(period, seq);
  const keep: { id: string; content: string }[] = [];
  const displaced: { id: string; content: string; period: string }[] = [];
  // Order is stable everywhere: the order the ancestor had, then whatever is
  // new, by id. Nothing unaffected is repacked or renumbered.
  const order = [...sides.base.keys(), ...sides.mine.keys(), ...sides.theirs.keys()];
  const rank = new Map(order.map((id, i) => [id, i]));
  for (const entry of report.entries.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0) || a.id.localeCompare(b.id))) {
    if (period && entry.period !== period) displaced.push({ id: entry.id, content: entry.content, period: entry.period });
    else keep.push({ id: entry.id, content: entry.content });
  }
  const out = renderSegment(header, keep);
  return {
    data: compressed ? gzipDeterministic(out) : Buffer.from(out, "utf8"),
    conflicts: report.conflicts,
    displaced,
    merged: report.entries.filter((e) => e.kind === "merged" || e.kind === "changed").map((e) => e.id),
  };
}

function sections(source: string | null, period: string, seq: number, path: string): Map<string, EntryState> {
  const out = new Map<string, EntryState>();
  if (source === null) return out;
  for (const s of parseSegment(source).sections) {
    // An id appearing twice in one file is a fault, not a merge decision: the
    // first is kept here and the duplicate is reported by the index.
    if (!out.has(s.id)) out.set(s.id, { id: s.id, content: s.content, period: filedPeriod(s.content, period), seq, path });
  }
  return out;
}

/** The period an entry's own `filed:` says it belongs to, falling back to the file's. */
function filedPeriod(content: string, fallback: string): string {
  const m = /^filed:\s*(\d{4})-(\d{2})-(\d{2})/m.exec(content);
  if (!m) return fallback;
  return fallback.length > 7 ? `${m[1]}-${m[2]}-${m[3]}` : `${m[1]}-${m[2]}`;
}

const headerOf = (source: string | null): string => (source === null ? "" : parseSegment(source).header.trim());

export interface ArchiveMerge {
  text: string;
  conflicts: string[];
}

/**
 * Merges .gitroll/archive.yaml. Archival state is a decision somebody made, so
 * two different decisions about one period are reported rather than resolved:
 * last-writer-wins would quietly re-archive a period somebody deliberately
 * reopened.
 */
export function mergeArchiveState(base: string | null, mine: string, theirs: string): ArchiveMerge {
  const b = base === null ? null : parseArchiveYaml(base);
  const m = parseArchiveYaml(mine);
  const t = parseArchiveYaml(theirs);
  const out: ArchiveState = { version: Math.max(m.version, t.version), periods: {} };
  const conflicts: string[] = [];
  for (const period of new Set([...Object.keys(m.periods), ...Object.keys(t.periods)])) {
    const mv = m.periods[period];
    const tv = t.periods[period];
    const bv = b?.periods[period];
    if (!tv || same(mv, tv)) out.periods[period] = mv ?? tv;
    else if (!mv) out.periods[period] = tv;
    else if (bv && same(mv, bv)) out.periods[period] = tv;
    else if (bv && same(tv, bv)) out.periods[period] = mv;
    else {
      // Keep this device's decision *and* say so, so the person can settle it.
      out.periods[period] = mv;
      conflicts.push(period);
    }
  }
  return { text: serializeArchiveYaml(out), conflicts };
}

const same = (a: ArchiveState["periods"][string] | undefined, b: ArchiveState["periods"][string] | undefined) =>
  !!a && !!b && a.archived === b.archived && a.compressed === b.compressed && a.auto === b.auto;
