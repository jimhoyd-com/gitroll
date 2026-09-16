// The seam between "what a Roll stores" and "how the bytes are laid out".
//
// Markdown is the format GitRoll has, and the only one implemented here. The
// interface exists so a second one — an append-only JSONL profile, for feeds
// that arrive faster than a person types — can be added without every caller
// learning about it. What such a profile would need, and what this interface
// therefore leaves room for:
//
//   • **Batched writes.** A writer hands over many records at once and the
//     profile decides how few files to touch (`writeBatch`), rather than each
//     record costing a read-modify-write of a segment.
//   • **Writer-specific segments.** With several processes appending at once,
//     each takes its own segment (`writerId` in a placement request), so two
//     writers never rewrite the same bytes and sync sees independent files.
//   • **Idempotent imports.** A record may carry an import key; re-running an
//     import finds the key and writes nothing (`keyOf`, and the index's
//     by-key lookup).
//   • **Incremental indexing.** A profile reports a stable per-segment
//     fingerprint and can decode one segment alone, so the index re-reads only
//     what changed (`fingerprint`, `decode`).
//
// None of that makes GitRoll suitable for high-volume machine logs today. See
// docs/STORAGE.md: ingestion, indexing, sync and repository growth have not
// been benchmarked at that scale, and raw-feed retention is a policy question
// that archival and compression do not answer.

import { parseSegment, renderSegment, segmentHeader } from "./grouped.ts";
import type { EntrySection } from "./grouped.ts";
import { parseSegmentPath, segmentPath } from "./segments.ts";
import type { SegmentRef } from "./segments.ts";
import { byteLength } from "./storage.ts";

/** One stored record: an entry, as bytes-in-a-segment sees it. */
export interface StoredRecord {
  id: string;
  /** The record's own text: front matter and body for Markdown, one line for JSONL. */
  content: string;
  /** An importer's key, when the record came from one. Re-importing finds it and writes nothing. */
  key?: string;
}

export interface DecodedSegment {
  header: string;
  records: StoredRecord[];
  duplicates: string[];
}

export interface PlacementRequest {
  period: string;
  bytes: number;
  /** Reserved for profiles that give each concurrent writer its own segment. */
  writerId?: string;
}

export interface StorageProfile {
  readonly name: string;
  readonly extension: string;
  /** Whether a writer may hand over several records for one flush. */
  readonly batched: boolean;
  /** Whether concurrent writers get segments of their own. */
  readonly writerScoped: boolean;
  pathFor(period: string, seq: number, compressed?: boolean): string;
  parsePath(path: string): SegmentRef | null;
  decode(text: string): DecodedSegment;
  encode(header: string, records: StoredRecord[]): string;
  newHeader(period: string, seq: number): string;
  sizeOf(record: StoredRecord): number;
}

const asRecord = (s: EntrySection): StoredRecord => ({ id: s.id, content: s.content });

/** Markdown segments: the format in SPEC.md, and the only one GitRoll writes. */
export const markdownProfile: StorageProfile = {
  name: "markdown",
  extension: ".md",
  batched: true,
  writerScoped: false,
  pathFor: (period, seq, compressed = false) => segmentPath(period, seq, compressed),
  parsePath: parseSegmentPath,
  decode(text) {
    const parsed = parseSegment(text);
    return { header: parsed.header, records: parsed.sections.map(asRecord), duplicates: parsed.duplicates };
  },
  encode: (header, records) => renderSegment(header, records),
  newHeader: segmentHeader,
  // What the record costs the file it joins: its text plus its marker line.
  sizeOf: (record) => byteLength(record.content) + 48,
};
