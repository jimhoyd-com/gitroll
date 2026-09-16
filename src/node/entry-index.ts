// A local index, so opening a Roll doesn't mean reading every file in it.
//
// The Markdown (and, when archived, the gzipped Markdown) is the source of
// truth. This is a cache and nothing else: it lives in .git/gitroll/, is never
// committed, and can be deleted at any moment — the next command rebuilds it.
//
// It is incremental. Each segment is remembered with a cheap fingerprint (size
// and modification time); a command re-reads only the segments whose
// fingerprint changed, which is what makes an edit, an import or a sync cost
// the segments it touched rather than the whole Roll. Anything it cannot
// account for — a file it failed to read, an id it saw twice — is recorded
// rather than dropped, and the index reports itself as incomplete so no
// interface can present a partial answer as a complete one.

import fs from "node:fs";
import path from "node:path";

export const INDEX_VERSION = 2;

/** What the index remembers about one entry. Enough to list, filter and link without opening a file. */
export interface IndexedEntry {
  id: string;
  path: string;
  /** Occurrence date or date-time, as written. */
  date: string | null;
  /** The day it is filed under, decided in the Roll's zone when it was created. */
  filed: string | null;
  /** When GitRoll first stored it, as distinct from when it happened. */
  created: string | null;
  title: string;
  tags: string[];
  projects: string[];
  archived: boolean;
  /** Bytes of the entry's own text, for rollover arithmetic. */
  bytes: number;
  /** An importer's key, when it had one: the same key is never imported twice. */
  key?: string;
}

export interface IndexedSegment {
  path: string;
  /** size:mtime — cheap, and enough to notice an outside edit. */
  stamp: string;
  period: string;
  seq: number;
  compressed: boolean;
  archived: boolean;
  bytes: number;
  entries: number;
  /** Set when the file could not be read or parsed; its entries are missing from the index. */
  error?: string;
}

export interface IndexData {
  version: number;
  entries: IndexedEntry[];
  segments: IndexedSegment[];
  /** Ids found in more than one place. Never merged: two entries claiming one id is a fault to show, not to fix. */
  duplicates: string[];
  /** Import checkpoints: the last batch an importer finished. */
  checkpoints: Record<string, string>;
  updated: string;
}

const empty = (): IndexData => ({ version: INDEX_VERSION, entries: [], segments: [], duplicates: [], checkpoints: {}, updated: "" });

export class EntryIndex {
  readonly file: string;
  #data: IndexData;

  constructor(gitDir: string) {
    this.file = path.join(gitDir, "gitroll", "index.json");
    this.#data = this.#read();
  }

  #read(): IndexData {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, "utf8")) as IndexData;
      if (data.version === INDEX_VERSION && Array.isArray(data.entries)) return data;
    } catch {
      // A missing, truncated or older index is not an error: it is rebuilt.
    }
    return empty();
  }

  /** Throws away everything remembered. The next scan reads the whole Roll. */
  reset(): void {
    this.#data = empty();
  }

  get data(): IndexData {
    return this.#data;
  }

  /** Segments whose entries are missing because the file wouldn't read. */
  get broken(): IndexedSegment[] {
    return this.#data.segments.filter((s) => s.error);
  }

  /** True when some part of the Roll is not represented here, so results are partial. */
  get incomplete(): boolean {
    return this.broken.length > 0 || this.#data.duplicates.length > 0;
  }

  stampOf(rel: string): string | undefined {
    return this.#data.segments.find((s) => s.path === rel)?.stamp;
  }

  /** Replaces everything known about one file. Called per changed segment, never for the whole Roll. */
  replaceSegment(segment: IndexedSegment, entries: IndexedEntry[]): void {
    this.#data.segments = this.#data.segments.filter((s) => s.path !== segment.path);
    this.#data.entries = this.#data.entries.filter((e) => e.path !== segment.path);
    this.#data.segments.push(segment);
    this.#data.entries.push(...entries);
  }

  forget(rel: string): void {
    this.#data.segments = this.#data.segments.filter((s) => s.path !== rel);
    this.#data.entries = this.#data.entries.filter((e) => e.path !== rel);
  }

  /** Any id claimed by more than one entry. Recorded, reported, never silently resolved. */
  recomputeDuplicates(): string[] {
    const seen = new Map<string, number>();
    for (const e of this.#data.entries) seen.set(e.id, (seen.get(e.id) ?? 0) + 1);
    this.#data.duplicates = [...seen].filter(([, n]) => n > 1).map(([id]) => id).sort();
    return this.#data.duplicates;
  }

  byId(id: string): IndexedEntry | undefined {
    return this.#data.entries.find((e) => e.id === id);
  }

  byKey(key: string): IndexedEntry | undefined {
    return this.#data.entries.find((e) => e.key === key);
  }

  checkpoint(importer: string): string | undefined {
    return this.#data.checkpoints[importer];
  }

  setCheckpoint(importer: string, marker: string): void {
    this.#data.checkpoints[importer] = marker;
  }

  /**
   * Entries newest first by occurrence, then by id — a tie-breaker that doesn't
   * depend on which file an entry happens to sit in. Undated entries come last.
   * Pagination is the caller's, so nothing has to hold a whole Roll to show a page.
   */
  page(opts: { offset?: number; limit?: number; includeArchived?: boolean } = {}): { entries: IndexedEntry[]; total: number } {
    const all = this.#data.entries.filter((e) => opts.includeArchived || !e.archived).sort(compareIndexed);
    const offset = Math.max(0, opts.offset ?? 0);
    const limit = opts.limit ?? all.length;
    return { entries: all.slice(offset, offset + limit), total: all.length };
  }

  save(): void {
    // The index is a cache inside .git/. A folder that isn't a Git repository
    // (a published template, say) gets no cache file rather than a stray one.
    if (!fs.existsSync(path.dirname(path.dirname(this.file)))) return;
    this.#data.updated = new Date().toISOString();
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.#data));
    fs.renameSync(tmp, this.file);
  }
}

/**
 * Newest first by when things happened, whatever file they are stored in. A
 * date-only entry counts as that whole day and sorts after every timed entry of
 * the same day, because a day without a time cannot claim a position within it.
 */
export function compareIndexed(a: IndexedEntry, b: IndexedEntry): number {
  if (!a.date || !b.date) return a.date ? -1 : b.date ? 1 : a.id.localeCompare(b.id);
  const day = b.date.slice(0, 10).localeCompare(a.date.slice(0, 10));
  if (day) return day;
  const aTimed = a.date.length > 10;
  const bTimed = b.date.length > 10;
  if (aTimed !== bTimed) return aTimed ? -1 : 1;
  return b.date.localeCompare(a.date) || a.id.localeCompare(b.id);
}

export const stampFor = (st: { size: number; mtimeMs: number }): string => `${st.size}:${Math.round(st.mtimeMs)}`;
