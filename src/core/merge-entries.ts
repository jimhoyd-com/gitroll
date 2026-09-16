// Merging two versions of a Roll, entry by entry.
//
// Once entries share a file, a line-based merge is the wrong tool: two people
// each appending to September's file touch the same lines and Git calls it a
// conflict, though nothing actually disagrees. So sync takes the files apart
// first and reasons about entries, which have permanent ids, and about where
// those entries are filed, which is data rather than a line number.
//
// Given the common ancestor and both sides:
//
//   • an entry only one side added is kept, exactly once;
//   • an entry only one side changed takes that side's text;
//   • an entry both sides changed is merged when the changes don't overlap, and
//     otherwise keeps *both* texts, flagged, the way a conflicted event always
//     has;
//   • an entry one side edited and the other deleted is a conflict, never a
//     silent deletion;
//   • a move — rollover, migration, archival — is a change of placement, not a
//     deletion and a creation of something that looks similar.
//
// Two entries with different ids are two entries, however alike they read.
// Nothing here deduplicates on content.

import { conflictNote } from "./conflict.ts";
import { splitFrontMatter } from "./entry.ts";
import { parseDocument } from "yaml";

/** One entry as a side of the merge has it. */
export interface EntryState {
  id: string;
  /** Front matter and body: everything but the marker line. */
  content: string;
  /** The filing period it sits in, e.g. 2026-09. */
  period: string;
  /** The segment it sits in, for keeping filenames stable where we can. */
  seq: number;
  /** Where it physically lives, including per-event paths during a transition. */
  path: string;
}

export type MergeKind = "unchanged" | "added" | "changed" | "merged" | "deleted" | "moved" | "conflict";

export type ConflictKind = "content" | "edit-delete" | "placement";

export interface MergedEntry {
  id: string;
  kind: MergeKind;
  content: string;
  period: string;
  /** The segment number to prefer; the writer honours it when that file can still hold the entry. */
  seq: number;
  conflict?: ConflictKind;
}

export interface EntryConflict {
  id: string;
  kind: ConflictKind;
  message: string;
}

export interface MergeSets {
  base: Map<string, EntryState>;
  mine: Map<string, EntryState>;
  theirs: Map<string, EntryState>;
  /** Today, for the note written into a conflicted entry. */
  day: string;
}

export interface MergeReport {
  /** Every entry that survives, with the text and placement to write. */
  entries: MergedEntry[];
  /** Entries deleted on one side with nothing to keep. */
  deleted: string[];
  conflicts: EntryConflict[];
}

/** Merges two whole Rolls against their common ancestor. */
export function mergeEntrySets({ base, mine, theirs, day }: MergeSets): MergeReport {
  const entries: MergedEntry[] = [];
  const deleted: string[] = [];
  const conflicts: EntryConflict[] = [];
  const ids = new Set([...base.keys(), ...mine.keys(), ...theirs.keys()]);

  for (const id of [...ids].sort()) {
    const b = base.get(id);
    const m = mine.get(id);
    const t = theirs.get(id);

    if (!m && !t) {
      deleted.push(id);
      continue;
    }
    // Added on one side only. Both sides adding the same id is the same entry
    // arriving twice (a retried sync); it is kept once and merged as an edit.
    if (!b) {
      if (m && !t) entries.push({ id, kind: "added", content: m.content, period: m.period, seq: m.seq });
      else if (t && !m) entries.push({ id, kind: "added", content: t.content, period: t.period, seq: t.seq });
      else entries.push(mergePair(id, null, m!, t!, day, conflicts));
      continue;
    }
    if (m && !t) {
      // Deleted over there. An untouched entry goes; an edited one is a conflict.
      if (same(m, b)) {
        deleted.push(id);
        conflicts.push({ id, kind: "edit-delete", message: `${id} was deleted elsewhere` });
        entries.push({ id, kind: "deleted", content: m.content, period: m.period, seq: m.seq, conflict: "edit-delete" });
      } else {
        conflicts.push({ id, kind: "edit-delete", message: `${id} was edited here and deleted elsewhere` });
        entries.push({ id, kind: "conflict", content: m.content, period: m.period, seq: m.seq, conflict: "edit-delete" });
      }
      continue;
    }
    if (t && !m) {
      if (same(t, b)) {
        deleted.push(id);
        continue;
      }
      conflicts.push({ id, kind: "edit-delete", message: `${id} was deleted here and edited elsewhere` });
      entries.push({ id, kind: "conflict", content: t.content, period: t.period, seq: t.seq, conflict: "edit-delete" });
      continue;
    }
    entries.push(mergePair(id, b, m!, t!, day, conflicts));
  }
  return { entries: entries.filter((e) => e.kind !== "deleted" || e.conflict), deleted, conflicts };
}

const same = (a: EntryState, b: EntryState) => a.content === b.content;

function mergePair(id: string, b: EntryState | null, m: EntryState, t: EntryState, day: string, conflicts: EntryConflict[]): MergedEntry {
  const placement = placeMerged(id, b, m, t, conflicts);
  if (m.content === t.content) return { id, kind: b && m.content !== b.content ? "changed" : "unchanged", content: m.content, ...placement };
  if (b && m.content === b.content) return { id, kind: "changed", content: t.content, ...placement };
  if (b && t.content === b.content) return { id, kind: "changed", content: m.content, ...placement };

  const safe = mergeContent(b?.content ?? null, m.content, t.content);
  if (safe !== null) return { id, kind: "merged", content: safe, ...placement };
  conflicts.push({ id, kind: "content", message: `${id} was edited here and elsewhere` });
  return { id, kind: "conflict", content: keepBoth(m.content, t.content, day), conflict: "content", ...placement };
}

/**
 * Where a merged entry is filed. A side that moved it wins; two sides moving it
 * to different periods is a real disagreement about when the thing happened, so
 * it is reported rather than decided. The segment number is a preference only:
 * the writer keeps the file it names when it can, and allocates the next one
 * when that file is full or taken.
 */
function placeMerged(id: string, b: EntryState | null, m: EntryState, t: EntryState, conflicts: EntryConflict[]): { period: string; seq: number } {
  if (m.period === t.period) return { period: m.period, seq: Math.min(m.seq, t.seq) };
  if (b && b.period === m.period) return { period: t.period, seq: t.seq };
  if (b && b.period === t.period) return { period: m.period, seq: m.seq };
  conflicts.push({
    id,
    kind: "placement",
    message: `${id} was filed under ${m.period} here and ${t.period} elsewhere`,
  });
  // Deterministic wherever it runs: the earlier period wins, and the conflict
  // above is what a person actually resolves.
  return m.period <= t.period ? { period: m.period, seq: m.seq } : { period: t.period, seq: t.seq };
}

/**
 * Merges two edits of one entry when it is safe to: front matter key by key,
 * and the body only when at most one side touched it. Returns null when the
 * changes overlap, which is the caller's signal to keep both texts.
 */
export function mergeContent(base: string | null, mine: string, theirs: string): string | null {
  const b = base === null ? null : splitFrontMatter(base);
  const a = splitFrontMatter(mine);
  const c = splitFrontMatter(theirs);
  const bodyBase = b?.body.trim() ?? null;
  const bodyMine = a.body.trim();
  const bodyTheirs = c.body.trim();

  let body: string;
  if (bodyMine === bodyTheirs) body = a.body;
  else if (bodyBase !== null && bodyMine === bodyBase) body = c.body;
  else if (bodyBase !== null && bodyTheirs === bodyBase) body = a.body;
  else return null;

  const meta = mergeFrontMatter(b?.frontMatter ?? null, a.frontMatter, c.frontMatter);
  if (meta === null) return null;
  return meta ? `---\n${meta}\n---\n${body.startsWith("\n") ? "" : "\n"}${body.replace(/^\n+/, "\n")}` : body.replace(/^\s*\n/, "");
}

const keys = (text: string | null): Map<string, string> => {
  const out = new Map<string, string>();
  if (!text?.trim()) return out;
  const doc = parseDocument(text);
  const contents = doc.contents as { items?: { key?: { value?: unknown }; value?: unknown }[] } | null;
  for (const item of contents?.items ?? []) {
    const key = String(item.key?.value ?? "");
    if (key) out.set(key, String(doc.createNode(item.value).toString()));
  }
  return out;
};

/** Per-key three-way merge of YAML front matter. null when one key changed on both sides. */
function mergeFrontMatter(base: string | null, mine: string | null, theirs: string | null): string | null {
  const b = keys(base);
  const m = keys(mine);
  const t = keys(theirs);
  const out: string[] = [];
  for (const key of [...new Set([...m.keys(), ...t.keys(), ...b.keys()])]) {
    const bv = b.get(key);
    const mv = m.get(key);
    const tv = t.get(key);
    if (mv === tv) {
      if (mv !== undefined) out.push(`${key}: ${mv}`);
      continue;
    }
    if (mv === bv) {
      if (tv !== undefined) out.push(`${key}: ${tv}`);
      continue;
    }
    if (tv === bv) {
      if (mv !== undefined) out.push(`${key}: ${mv}`);
      continue;
    }
    return null; // both sides set the same key differently
  }
  return out.join("\n");
}

/** Overlapping edits: this side's text stays, and the other is kept underneath it. */
export function keepBoth(mine: string, theirs: string, day: string): string {
  return [
    mine.trimEnd(),
    "",
    conflictNote(day),
    "",
    theirs
      .trim()
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n"),
    "",
  ].join("\n");
}
