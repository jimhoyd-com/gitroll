// Reading and writing a Roll's entries, whatever layout they are in.
//
// A Roll stores entries one of three ways, and may hold two of them at once
// while it is being migrated:
//
//   event     .gitroll/events/2026-09-15-ac-serviced.md   one file per event
//   monthly   .gitroll/logs/2026/09.md                    the default for new Rolls
//   daily     .gitroll/logs/2026/09/16.md                 for Rolls that fill a month in a day
//
// Every rule that decides *where* something goes — the Roll's time zone, the
// filing date, the period, rollover between segments, archival, compression —
// lives in core/ and is called from here, so the app, the CLI, an import and a
// sync cannot drift into three different answers.
//
// Writes are taken seriously: one local writer at a time (a lock), whole files
// written and renamed into place (never truncated and refilled), batched by the
// file they land in, and idempotent when the caller supplies a key. An
// interrupted write leaves the previous file; a retried import writes nothing
// twice.

import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { dirName, parseEntry, relinkBody, splitFrontMatter } from "../core/entry.ts";
import type { Entry } from "../core/entry.ts";
import { derivedEntryId, isEntryId, newEntryId } from "../core/ids.ts";
import { EVENTS_DIR, EVENT_FILE, FILES_DIR, GITROLL_DIR, MARKER_PATH } from "../core/layout.ts";
import { adoptSection, entryAnchor, entryFromSection, parseSegment, renderSegment, segmentHeader } from "../core/grouped.ts";
import type { EntrySection } from "../core/grouped.ts";
import { markdownProfile } from "../core/profile.ts";
import { LOGS_DIR, parseSegmentPath, periodFor, segmentPath, segmentVariants } from "../core/segments.ts";
import type { SegmentRef, StorageMode } from "../core/segments.ts";
import { byteLength, parseStorage, placeEntry, serializeStorage } from "../core/storage.ts";
import type { SegmentState, StorageSettings } from "../core/storage.ts";
import { resolveOccurrence } from "../core/occurrence.ts";
import { filingDateFor, formatInZone, periodEnd, requireZone } from "../core/tz.ts";
import { UserError } from "../core/util.ts";
import { headingKey, scanCommitDates } from "./commit-dates.ts";
import { EntryIndex, stampFor } from "./entry-index.ts";
import type { IndexedEntry, IndexedSegment } from "./entry-index.ts";
import { insideRoll, safeRead, safeRemove, walkFiles } from "./fs-safe.ts";
import { gunzipText, gzipDeterministic, replaceFile, sweepTemporaries, writeAtomic } from "./gzip.ts";
import { withWriteLock } from "./lock.ts";

export const ARCHIVE_STATE = `${GITROLL_DIR}/archive.yaml`;
export const ARCHIVE_STATE_VERSION = 1;
/** How far ahead of now an occurrence may be before GitRoll asks rather than files it. */
export const FUTURE_LIMIT_DAYS = 366;

/** Archival is a property of a whole filing period, not of one entry. */
export interface PeriodArchive {
  archived: boolean;
  /** When it was archived, as an instant. */
  at?: string;
  compressed: boolean;
  /**
   * False after someone unarchived a period by hand: automatic archival leaves
   * it alone until they say otherwise, so a period they deliberately reopened
   * isn't closed again overnight.
   */
  auto: boolean;
}

export interface ArchiveState {
  version: number;
  periods: Record<string, PeriodArchive>;
}

/** An entry as the store hands it out: the parsed event, plus where and how it is stored. */
export interface StoredEntry extends Entry {
  /** "event" for one-file-per-event, otherwise the grouping the segment uses. */
  storage: StorageMode;
  /** The filing period, e.g. 2026-09. */
  period: string | null;
  /** The day it is filed under, in the Roll's zone. */
  filed: string | null;
  /** When GitRoll first wrote it down — not when it happened. */
  created: string | null;
  archived: boolean;
  /** #gr-<id>, the fragment a link uses to point at it inside its file. */
  anchor: string;
}

export interface NewEntry {
  /** Front matter and body, exactly as it will be stored. */
  content: string;
  /**
   * Where this text is moving from, when it is moving. A segment two folders
   * deep and one three folders deep need different relative links to the same
   * receipt, so the links are rewritten rather than left pointing at nothing.
   */
  from?: string;
  /** Occurrence, as written: a day, or a timestamp with an offset. */
  date: string | null;
  /** Overrides the filing date derived from `date`. Used when re-placing an existing entry. */
  filed?: string;
  /** An importer's key. The same key never produces a second entry. */
  key?: string;
  /** Supplied only by migration, which must keep the ids it already has. */
  id?: string;
}

export interface WriteResult {
  entries: StoredEntry[];
  /** Ids that already existed under the caller's key, so nothing was written for them. */
  skipped: string[];
  /** Files changed, for the commit. */
  paths: string[];
}

export interface Usage {
  segmentBytes: number;
  archivedBytes: number;
  attachmentBytes: number;
  segments: number;
  entries: number;
  /** Entries in periods that are archived: still here, just out of the way. */
  archivedEntries: number;
  attachments: number;
  /** The biggest segment, and how close it is to the rollover target. */
  largest: { path: string; bytes: number; entries: number } | null;
}


export class EntryStore {
  readonly root: string;
  readonly index: EntryIndex;
  #settings: StorageSettings | null = null;
  #gitDir: string;

  constructor(root: string, gitDir?: string) {
    this.root = root;
    this.#gitDir = gitDir ?? path.join(root, ".git");
    this.index = new EntryIndex(this.#gitDir);
  }

  // ── Configuration ────────────────────────────────────────────────────────

  /** The Roll's storage settings. A Roll that has never recorded any keeps per-event storage. */
  settings(): StorageSettings {
    if (!this.#settings) {
      let text = "";
      try {
        text = safeRead(this.root, MARKER_PATH).toString("utf8");
      } catch {
        text = "";
      }
      this.#settings = parseStorage(text, deviceZone());
    }
    return this.#settings;
  }

  /** Forgets cached settings, e.g. after `gitroll storage --set`. */
  reloadSettings(): void {
    this.#settings = null;
  }

  /** Writes the storage block. Existing entries are untouched: this decides where *new* ones go. */
  setSettings(next: StorageSettings): void {
    requireZone(next.timezone);
    const text = safeRead(this.root, MARKER_PATH).toString("utf8");
    const without = text.replace(/^storage:\n(?:[ \t]+.*\n|\n(?=[ \t]))*/m, "");
    writeAtomic(this.root, MARKER_PATH, `${without.replace(/\n*$/, "\n")}\n${serializeStorage(next)}`);
    this.#settings = null;
  }

  // ── Archival state ───────────────────────────────────────────────────────

  archiveState(): ArchiveState {
    try {
      const text = safeRead(this.root, ARCHIVE_STATE).toString("utf8");
      const state = parseArchiveYaml(text);
      return state;
    } catch {
      return { version: ARCHIVE_STATE_VERSION, periods: {} };
    }
  }

  #writeArchiveState(state: ArchiveState): void {
    writeAtomic(this.root, ARCHIVE_STATE, serializeArchiveYaml(state));
  }

  isArchived(period: string | null): boolean {
    return !!period && this.archiveState().periods[period]?.archived === true;
  }

  // ── Reading ──────────────────────────────────────────────────────────────

  /** Every segment file in the Roll, with what the index knows about it. */
  scan(): IndexedSegment[] {
    sweepTemporaries(this.root, LOGS_DIR);
    this.#refreshCommitDates();
    const state = this.archiveState();
    const { files } = walkFiles(this.root, LOGS_DIR);
    const seen = new Set<string>();
    for (const rel of files) {
      const ref = parseSegmentPath(rel);
      if (!ref) continue;
      seen.add(rel);
      const st = fs.lstatSync(insideRoll(this.root, rel));
      const stamp = stampFor(st);
      if (this.index.stampOf(rel) === stamp) continue;
      this.#indexSegment(ref, stamp, state.periods[ref.period]?.archived === true);
    }
    for (const s of this.index.data.segments) if (!seen.has(s.path)) this.index.forget(s.path);
    // Per-event files keep their own identity (their path) but are indexed the
    // same way, so a Roll mid-migration lists and links as one thing.
    this.#indexLegacy();
    this.index.recomputeDuplicates();
    this.index.save();
    return this.index.data.segments;
  }

  /**
   * Asks Git when the entries it hasn't seen were written down. One pass over
   * the commits since the last scan, cached in the index; a history that was
   * rewritten under us (a rebase that dropped the last head) rebuilds the cache
   * from scratch rather than trusting half of it.
   */
  #refreshCommitDates(): void {
    const scan = scanCommitDates(this.root, this.index.commitsHead);
    if (scan.head === null && this.index.commitsHead !== null) {
      const full = scanCommitDates(this.root, null);
      this.index.rememberCommits(full, full.head);
      return;
    }
    if (scan.head !== this.index.commitsHead || Object.keys(scan.dates).length) this.index.rememberCommits(scan, scan.head);
  }

  #indexSegment(ref: SegmentRef, stamp: string, archived: boolean): void {
    let text: string;
    try {
      text = this.readSegmentText(ref.path);
    } catch (e) {
      // A corrupt archive is isolated and reported; the file itself is left
      // exactly as it is, and the rest of the Roll stays readable.
      this.index.replaceSegment(
        { path: ref.path, stamp, period: ref.period, seq: ref.seq, compressed: ref.compressed, archived, bytes: 0, entries: 0, error: (e as Error).message },
        [],
      );
      return;
    }
    const parsed = parseSegment(text);
    const entries: IndexedEntry[] = [];
    for (const section of parsed.sections) {
      try {
        const entry = this.#entryFromSection(ref, section.id, section.content, archived, section.date);
        entries.push(toIndexed(entry, byteLength(section.content)));
      } catch (e) {
        // One unreadable entry never hides the others.
        entries.push({
          id: section.id,
          path: ref.path,
          date: null,
          filed: null,
          created: null,
          title: `Unreadable entry (${(e as Error).message})`,
          tags: [],
          archived,
          bytes: byteLength(section.content),
        });
      }
    }
    this.index.replaceSegment(
      {
        path: ref.path,
        stamp,
        period: ref.period,
        seq: ref.seq,
        compressed: ref.compressed,
        archived,
        bytes: byteLength(text),
        entries: parsed.sections.length,
      },
      entries,
    );
  }

  #indexLegacy(): void {
    const { files } = walkFiles(this.root, EVENTS_DIR);
    const seen = new Set<string>();
    for (const rel of files.filter((f) => EVENT_FILE.test(f))) {
      seen.add(rel);
      const st = fs.lstatSync(insideRoll(this.root, rel));
      const stamp = stampFor(st);
      if (this.index.stampOf(rel) === stamp) continue;
      let entries: IndexedEntry[] = [];
      let error: string | undefined;
      try {
        const source = safeRead(this.root, rel).toString("utf8");
        const entry = this.#legacyEntry(rel, source);
        entries = [toIndexed(entry, byteLength(source))];
      } catch (e) {
        error = (e as Error).message;
      }
      const period = entries[0]?.filed ? periodFor(entries[0].filed, this.settings().mode === "daily" ? "daily" : "monthly") : "";
      this.index.replaceSegment(
        { path: rel, stamp, period, seq: 1, compressed: false, archived: this.isArchived(period || null), bytes: st.size, entries: entries.length, error },
        entries,
      );
    }
    for (const s of this.index.data.segments) if (s.path.startsWith(`${EVENTS_DIR}/`) && !seen.has(s.path)) this.index.forget(s.path);
  }

  /** The text of a segment, decompressing transparently when it is archived and compressed. */
  readSegmentText(rel: string): string {
    const data = safeRead(this.root, rel);
    return rel.endsWith(".gz") ? gunzipText(data) : data.toString("utf8");
  }

  /** Every entry, parsed. Prefer `page()` on a large Roll: this holds them all. */
  entries(opts: { includeArchived?: boolean } = {}): StoredEntry[] {
    this.scan();
    const state = this.archiveState();
    const out: StoredEntry[] = [];
    for (const segment of this.index.data.segments) {
      if (segment.error) continue;
      const archived = state.periods[segment.period]?.archived === true;
      if (archived && !opts.includeArchived) continue;
      out.push(...this.readSegmentEntries(segment.path, archived));
    }
    return out;
  }

  /** The entries of one file. Reading a page of a Roll costs the files that page touches. */
  readSegmentEntries(rel: string, archived = this.isArchived(parseSegmentPath(rel)?.period ?? null)): StoredEntry[] {
    const ref = parseSegmentPath(rel);
    if (!ref) {
      const entry = this.#legacyEntry(rel, safeRead(this.root, rel).toString("utf8"));
      return [{ ...entry, archived }];
    }
    const parsed = parseSegment(this.readSegmentText(rel));
    const out: StoredEntry[] = [];
    for (const s of parsed.sections) {
      try {
        out.push(this.#entryFromSection(ref, s.id, s.content, archived, s.date));
      } catch {
        // Already reported through the index; skipping here keeps the file readable.
      }
    }
    return out;
  }

  /**
   * One entry out of a shared file. The reading itself is core's, so this app
   * and GitRoll.com agree about what an entry in a segment is; what differs is
   * what each can supply — the id, and when the commit that wrote it landed.
   */
  #entryFromSection(ref: SegmentRef, rawId: string, content: string, archived: boolean, markerDate?: string): StoredEntry {
    const entry = parseEntry(ref.path, content);
    // An entry somebody typed has no marker and so no id of its own. It gets a
    // derived one — the same one on every clone — so it can be listed, found
    // and opened straight away; a permanent one is written the next time
    // GitRoll touches the file.
    const id = rawId || derivedEntryId(sha(`${ref.path}\n${entry.title}`)); // see #idOf
    const committed = (rawId ? this.index.committedAt(rawId) : this.index.headingAt(headingKey(ref.path, entry.title))) ?? null;
    return entryFromSection(ref, content, { id, markerDate, committed, timezone: this.settings().timezone, archived });
  }

  #legacyEntry(rel: string, source: string): StoredEntry {
    const entry = parseEntry(rel, source);
    const meta = entry.meta as Record<string, unknown>;
    const id = typeof meta.id === "string" && isEntryId(meta.id) ? meta.id : rel;
    const filed = typeof meta.filed === "string" ? meta.filed : entry.date ? filingDateFor(entry.date, this.settings().timezone) : null;
    const period = filed ? periodFor(filed, this.settings().mode === "daily" ? "daily" : "monthly") : null;
    return { ...entry, id, storage: "event", period, filed, created: typeof meta.created === "string" ? meta.created : null, archived: this.isArchived(period), anchor: entryAnchor(isEntryId(id) ? id : derivedEntryId(sha(rel))) };
  }

  /** The raw text of one entry: its front matter and body, without the marker line. */
  sourceOf(id: string): string {
    const hit = this.index.byId(id);
    if (!hit) throw new UserError(`No entry with id ${id}`);
    if (!parseSegmentPath(hit.path)) return safeRead(this.root, hit.path).toString("utf8");
    const section = parseSegment(this.readSegmentText(hit.path)).sections.find((s) => this.#idOf(hit.path, s) === id);
    if (!section) throw new UserError(`No entry with id ${id}`);
    return section.content;
  }

  /** A page of entries, from the index: nothing is parsed that isn't shown. */
  page(opts: { offset?: number; limit?: number; includeArchived?: boolean } = {}): { entries: IndexedEntry[]; total: number; incomplete: boolean } {
    this.scan();
    const { entries, total } = this.index.page(opts);
    return { entries, total, incomplete: this.index.incomplete };
  }

  /** Finds an entry by permanent id, by path, or by a path with an anchor. */
  find(idOrPath: string): StoredEntry | null {
    this.scan();
    const q = idOrPath.trim().replace(/^\.?\//, "");
    const anchored = /#gr-([0-9a-hjkmnp-tv-z]{26})$/i.exec(q);
    const id = anchored ? anchored[1].toUpperCase() : q.toUpperCase();
    if (isEntryId(id)) {
      const hit = this.index.byId(id);
      if (hit) return this.readSegmentEntries(hit.path).find((e) => e.id === id) ?? null;
      return null;
    }
    const plain = q.split("#")[0];
    const byPath = this.index.data.entries.find((e) => e.path === plain);
    if (byPath) return this.readSegmentEntries(byPath.path).find((e) => e.id === byPath.id) ?? null;
    // A link written before this Roll was grouped still points at a file that
    // no longer exists; .gitroll/moved.yaml says which entry it became.
    const alias = readMoved(this)[plain];
    return alias ? this.find(alias) : null;
  }

  // ── Writing ──────────────────────────────────────────────────────────────

  /**
   * Stores entries, grouped by the file they land in.
   *
   * A batch of a thousand backdated imports touches each destination segment
   * once — read, append them all, write — rather than once per entry, and an
   * archived period is decompressed and recompressed once for the batch, not
   * once per entry. A caller that supplies `key` gets idempotence: a key
   * already in the Roll is skipped, so a retried import adds nothing. Identical
   * text is *not* treated as a duplicate: two identical entries are two things
   * that happened.
   */
  put(inputs: NewEntry[], opts: { now?: Date; importer?: string; checkpoint?: string } = {}): WriteResult {
    const settings = this.settings();
    if (settings.mode === "event") throw new UserError("This Roll stores one event per file. Run `gitroll migrate --to monthly` to group entries.");
    const now = opts.now ?? new Date();
    return withWriteLock(this.#gitDir, "saving entries", () => {
      this.scan();
      const skipped: string[] = [];
      const pending = new Map<string, { id: string; content: string }[]>();
      const created: { id: string; period: string }[] = [];

      for (const input of inputs) {
        if (input.key) {
          const hit = this.index.byKey(input.key);
          if (hit) {
            skipped.push(hit.id);
            continue;
          }
        }
        const id = input.id ?? newEntryId(now, (n) => new Uint8Array(createHash("sha256").update(`${now.getTime()}:${Math.random()}`).digest()).slice(0, n));
        const occurrence = resolveOccurrence(input.date, settings.timezone, { now, allowFuture: true });
        const filed = input.filed ?? occurrence.filed ?? zonedToday(now, settings.timezone);
        const period = periodFor(filed, settings.mode);
        // An entry logged as it happens writes nothing down: the commit that
        // adds it says when, and the file it lands in says the rest. A date
        // somebody chose — backdating, or a time of day that matters — goes in
        // the entry's own marker, where it reads as nothing on GitHub.
        const destination = segmentPath(period, 1);
        const moved = input.from && dirName(input.from) !== dirName(destination) ? relinkBody(input.content, input.from, destination) : input.content;
        const content = input.key ? stampContent(moved, { key: input.key }) : moved;
        const list = pending.get(period) ?? [];
        list.push({ id, content, ...(occurrence.date ? { date: occurrence.date } : {}) });
        pending.set(period, list);
        created.push({ id, period });
      }

      const paths = new Set<string>();
      for (const [period, items] of pending) for (const p of this.#append(period, items)) paths.add(p);
      if (opts.importer && opts.checkpoint) {
        this.index.setCheckpoint(opts.importer, opts.checkpoint);
        this.index.save();
      }
      this.scan();
      const entries = created.map(({ id }) => this.find(id)).filter((e): e is StoredEntry => !!e);
      return { entries, skipped, paths: [...paths] };
    });
  }

  /** Appends entries to a period, opening segments as the rollover targets require. */
  #append(period: string, items: { id: string; content: string; date?: string; from?: string }[], mode?: Exclude<StorageMode, "event">): string[] {
    const settings = mode ? { ...this.settings(), mode } : this.settings();
    const archive = this.archiveState().periods[period];
    const touched = new Set<string>();
    let states = this.#segmentStates(period);
    // One read/modify/write per destination file, whatever the batch size.
    const batches = new Map<number, { id: string; content: string; date?: string }[]>();
    for (const raw of items) {
      // Moving between a month's file and a day's changes how deep the entry
      // sits, so its links to attachments are rewritten to still find them.
      const destination = segmentPath(period, 1);
      const item =
        raw.from && dirName(raw.from) !== dirName(destination) ? { ...raw, content: relinkBody(raw.content, raw.from, destination) } : raw;
      const bytes = markdownProfile.sizeOf({ id: item.id, content: item.content });
      const place = placeEntry(states, period, bytes, settings.limits);
      const batch = batches.get(place.seq) ?? [];
      batch.push(item);
      batches.set(place.seq, batch);
      const state = states.find((s) => s.seq === place.seq);
      if (state) {
        state.bytes += bytes;
        state.entries += 1;
      } else {
        states = [...states, { period, seq: place.seq, mode: settings.mode === "daily" ? "daily" : "monthly", compressed: archive?.compressed === true, path: place.path, bytes, entries: 1 }];
      }
    }
    for (const [seq, batch] of batches) {
      const compressed = archive?.compressed === true;
      const existing = this.#existingSegmentPath(period, seq);
      const rel = existing ?? segmentPath(period, seq, compressed);
      const text = existing ? this.readSegmentText(existing) : "";
      const parsed = text ? parseSegment(text) : { header: segmentHeader(period, seq), sections: [], duplicates: [] };
      const next = renderSegment(parsed.header, [...this.#keep(rel, parsed.sections), ...batch]);
      this.#writeSegment(rel, next, rel.endsWith(".gz"));
      touched.add(rel);
    }
    return [...touched];
  }

  #existingSegmentPath(period: string, seq: number): string | null {
    const { plain, gz } = segmentVariants({ period, seq });
    for (const rel of [plain, gz]) if (fs.existsSync(insideRoll(this.root, rel))) return rel;
    return null;
  }

  /**
   * Hands every entry in a file back the way it was read.
   *
   * An entry somebody wrote by hand has no marker, and GitRoll does not add one
   * just because it happened to write to the same file: appending to September
   * is no reason to edit what else is in September. `adopt` names the entries
   * that *are* being acted on — the one being edited, or all of them when
   * somebody runs `gitroll adopt` — and only those are given a permanent id.
   * Even then nothing but the marker line is added: the words, the spacing and
   * the order are theirs.
   */
  #keep(path: string, sections: EntrySection[], adopt: (s: EntrySection) => boolean = () => false): { id: string; content: string; date?: string; source?: string }[] {
    return sections.map((s) => {
      if (s.id || !adopt(s)) return { id: s.id, content: s.content, date: s.date, source: s.source };
      const id = this.#idOf(path, s);
      // Giving an entry a marker puts that marker in a new commit, so the
      // moment Git was supplying for it is written down at the same time.
      const ref = parseSegmentPath(path);
      const date = s.date ?? (ref ? (this.#entryFromSection(ref, s.id, s.content, false, s.date).date ?? undefined) : undefined);
      return { id, content: s.content, date, source: adoptSection(id, s.source, date) };
    });
  }

  /**
   * The id an entry is known by. One somebody wrote by hand has none, so it is
   * derived from the file and the heading — the same way on every clone, and
   * the same before and after it is given a marker, so adopting an entry never
   * changes what it is called or breaks a link to it.
   */
  #idOf(path: string, section: { id: string; content: string }): string {
    if (section.id) return section.id;
    let title = "";
    try {
      title = parseEntry(path, section.content).title;
    } catch {
      title = section.content.trim().slice(0, 200);
    }
    return derivedEntryId(sha(`${path}\n${title}`));
  }

  /**
   * Gives permanent ids to entries written by hand, on purpose and all at once.
   * Until an entry has one it is identified by its heading, which is enough to
   * list, search and open it, but changes if the heading is rewritten — so a
   * link to it, and sync's sense of which entry it is, are only as stable as
   * its title. This is the one-line fix, and it is somebody's to ask for.
   */
  adoptAll(): { adopted: number; paths: string[] } {
    return withWriteLock(this.#gitDir, "giving entries ids", () => {
      this.scan();
      const paths: string[] = [];
      let adopted = 0;
      for (const segment of this.index.data.segments.filter((x) => parseSegmentPath(x.path) && !x.error)) {
        const parsed = parseSegment(this.readSegmentText(segment.path));
        const unmarked = parsed.sections.filter((x) => !x.id).length;
        if (!unmarked) continue;
        this.#writeSegment(segment.path, renderSegment(parsed.header, this.#keep(segment.path, parsed.sections, () => true)), segment.path.endsWith(".gz"));
        adopted += unmarked;
        paths.push(segment.path);
      }
      this.index.reset();
      this.scan();
      return { adopted, paths };
    });
  }

  /**
   * What regrouping a Roll from monthly to daily files (or back) would do.
   *
   * Nothing is written. An entry's filing date already says which day and which
   * month it belongs to, so this is only a change of which of those two names
   * the file takes — no entry changes period, and none is re-dated.
   */
  planRegroup(target: Exclude<StorageMode, "event">): {
    items: { id: string; title: string; from: string; to: string; date: string | null }[];
    skipped: { path: string; reason: string }[];
  } {
    this.scan();
    const items: { id: string; title: string; from: string; to: string; date: string | null }[] = [];
    const skipped: { path: string; reason: string }[] = [];
    for (const segment of this.index.data.segments) {
      const ref = parseSegmentPath(segment.path);
      if (!ref) continue;
      if (segment.error) {
        skipped.push({ path: segment.path, reason: segment.error });
        continue;
      }
      if (ref.mode === target) continue;
      // An archived period is a decision somebody made about a set of files.
      // Rewriting it under them would undo that quietly; they can reopen it.
      if (segment.archived) {
        skipped.push({ path: segment.path, reason: `archived — reopen it first: gitroll unarchive ${ref.period}` });
        continue;
      }
      for (const entry of this.readSegmentEntries(segment.path)) {
        if (!entry.filed) {
          skipped.push({ path: segment.path, reason: `${entry.title}: no filing date, so there is no day to file it under` });
          continue;
        }
        items.push({ id: entry.id, title: entry.title, from: segment.path, to: segmentPath(periodFor(entry.filed, target), 1), date: entry.date });
      }
    }
    return { items, skipped };
  }

  /**
   * Regroups a Roll into monthly or daily files.
   *
   * Entries keep their ids, their words and their filing dates; only the name
   * of the file around them changes. An entry that was dated by the commit
   * which added it has that moment written into its marker on the way, because
   * moving it would otherwise re-date it to the migration.
   */
  regroup(target: Exclude<StorageMode, "event">): { moved: number; paths: string[] } {
    return withWriteLock(this.#gitDir, "regrouping", () => {
      this.scan();
      const sources: string[] = [];
      const byPeriod = new Map<string, { id: string; content: string; date?: string }[]>();
      for (const segment of this.index.data.segments) {
        const ref = parseSegmentPath(segment.path);
        if (!ref || ref.mode === target || segment.archived || segment.error) continue;
        const parsed = parseSegment(this.readSegmentText(segment.path));
        let moved = 0;
        for (const section of parsed.sections) {
          // The raw id, so an entry written by hand still finds the commit that
          // dated it — those are remembered by heading, not by a derived id.
          const entry = this.#entryFromSection(ref, section.id, section.content, false, section.date);
          const id = entry.id;
          if (!entry.filed) continue;
          const period = periodFor(entry.filed, target);
          const destination = segmentPath(period, 1);
          // A month's file and a day's file sit at different depths, so a link
          // to a receipt has to be rewritten to still find it.
          const content = dirName(segment.path) === dirName(destination) ? section.content : relinkBody(section.content, segment.path, destination);
          const list = byPeriod.get(period) ?? [];
          // The date it already states, or the one Git was supplying for it.
          list.push({ id, content, ...(entry.date ? { date: entry.date } : {}) });
          byPeriod.set(period, list);
          moved += 1;
        }
        if (moved === parsed.sections.length) sources.push(segment.path);
      }
      const paths = new Set<string>();
      for (const [period, items] of [...byPeriod].sort(([a], [b]) => a.localeCompare(b))) {
        for (const written of this.#append(period, items, target)) paths.add(written);
      }
      for (const rel of sources) {
        safeRemove(this.root, rel);
        paths.add(rel);
      }
      this.index.reset();
      this.scan();
      return { moved: [...byPeriod.values()].reduce((n, xs) => n + xs.length, 0), paths: [...paths] };
    });
  }

  /** How many entries are still identified only by their heading. */
  unmarkedCount(): number {
    this.scan();
    let count = 0;
    for (const segment of this.index.data.segments.filter((x) => parseSegmentPath(x.path) && !x.error)) {
      count += parseSegment(this.readSegmentText(segment.path)).sections.filter((x) => !x.id).length;
    }
    return count;
  }

  #writeSegment(rel: string, text: string, compressed: boolean): void {
    writeAtomic(this.root, rel, compressed ? gzipDeterministic(text) : text);
  }

  #segmentStates(period: string): SegmentState[] {
    return this.index.data.segments
      .filter((s) => s.period === period && parseSegmentPath(s.path))
      .map((s) => ({ period: s.period, seq: s.seq, mode: s.path.includes(`/${period.slice(5, 7)}/`) ? "daily" : "monthly", compressed: s.compressed, path: s.path, bytes: s.bytes, entries: s.entries }) as SegmentState)
      .sort((a, b) => a.seq - b.seq);
  }

  /** Rewrites one entry in place, leaving every other entry in its file byte for byte. */
  update(id: string, content: string): StoredEntry {
    return withWriteLock(this.#gitDir, "editing an entry", () => {
      const current = this.find(id);
      if (!current) throw new UserError(`No entry with id ${id}`);
      if (current.storage === "event") {
        writeAtomic(this.root, current.path, content);
        this.scan();
        return this.find(id)!;
      }
      const settings = this.settings();
      const daily = settings.mode === "daily";
      // A date the edit supplied arrives in the front matter; one the entry
      // already had lives in its marker. Either way it ends up in the marker,
      // and an edit that says nothing about the date leaves it alone — an
      // entry must not be re-dated by having its words changed.
      const supplied = splitDate(content);
      // An entry with no date of its own takes the moment from the commit that
      // added it — and rewriting it adds its marker in a *later* commit, which
      // would re-date it. So whatever GitRoll knows the date to be is written
      // down, unless the entry's own front matter already says.
      const markerDate = supplied ?? (current.dateFrom === "metadata" ? undefined : (current.date ?? undefined));
      const body = supplied ? dropKey(content, "date") : content;
      const nextFiled = markerDate ? filingDateFor(markerDate, settings.timezone) : current.filed;
      const stamped = daily ? body : stampContent(body, { filed: nextFiled ?? undefined });
      const nextPeriod = nextFiled ? periodFor(nextFiled, settings.mode) : current.period;
      // An entry whose occurrence moved to another period moves with it, keeping
      // its id — so every link to it still resolves.
      if (nextPeriod && nextPeriod !== current.period) {
        this.#removeFromSegment(current.path, id);
        this.#append(nextPeriod, [{ id, content: stamped, ...(markerDate ? { date: markerDate } : {}), from: current.path }]);
        this.scan();
        return this.find(id)!;
      }
      this.#replaceInSegment(current.path, id, stamped, markerDate);
      this.scan();
      return this.find(id)!;
    });
  }

  remove(id: string): string[] {
    return withWriteLock(this.#gitDir, "deleting an entry", () => {
      const current = this.find(id);
      if (!current) throw new UserError(`No entry with id ${id}`);
      if (current.storage === "event") {
        safeRemove(this.root, current.path);
        this.scan();
        return [current.path];
      }
      this.#removeFromSegment(current.path, id);
      this.scan();
      return [current.path];
    });
  }

  #replaceInSegment(rel: string, id: string, content: string, date?: string): void {
    const parsed = parseSegment(this.readSegmentText(rel));
    // The entry being edited is rendered afresh; every other one is handed back
    // the way it was written.
    // An entry being edited for the first time is given its marker here: it is
    // being acted on, and its id is the one it already had.
    const sections = this.#keep(rel, parsed.sections, (s) => this.#idOf(rel, s) === id).map((s) => (s.id === id ? { id, content, date } : s));
    this.#writeSegment(rel, renderSegment(parsed.header, sections), rel.endsWith(".gz"));
  }

  #removeFromSegment(rel: string, id: string): void {
    const parsed = parseSegment(this.readSegmentText(rel));
    const sections = this.#keep(rel, parsed.sections).filter((s) => this.#idOf(rel, s) !== id);
    this.#writeSegment(rel, renderSegment(parsed.header, sections), rel.endsWith(".gz"));
  }

  // ── Archival ─────────────────────────────────────────────────────────────

  /**
   * Archives a whole period: every segment of it, together. Files stay where
   * they are; what changes is that the period is marked archived, so it drops
   * out of the timeline and out of search unless somebody asks for it. Nothing
   * is deleted, ever — not an entry, not an attachment.
   */
  archive(period: string, opts: { compress?: boolean } = {}): string[] {
    return withWriteLock(this.#gitDir, "archiving", () => {
      this.scan();
      const settings = this.settings();
      const compress = opts.compress ?? settings.archive.compress;
      const state = this.archiveState();
      const touched: string[] = [];
      for (const segment of this.index.data.segments.filter((s) => s.period === period && parseSegmentPath(s.path))) {
        touched.push(...this.#setCompression(segment.path, compress));
      }
      state.periods[period] = { archived: true, at: new Date().toISOString(), compressed: compress, auto: state.periods[period]?.auto ?? true };
      this.#writeArchiveState(state);
      touched.push(ARCHIVE_STATE);
      this.index.reset();
      this.scan();
      return touched;
    });
  }

  /** Reopens a period, and restores plain Markdown. Automatic archival leaves it alone afterwards. */
  unarchive(period: string): string[] {
    return withWriteLock(this.#gitDir, "unarchiving", () => {
      this.scan();
      const state = this.archiveState();
      const touched: string[] = [];
      for (const segment of this.index.data.segments.filter((s) => s.period === period && parseSegmentPath(s.path))) {
        touched.push(...this.#setCompression(segment.path, false));
      }
      state.periods[period] = { archived: false, compressed: false, auto: false };
      this.#writeArchiveState(state);
      touched.push(ARCHIVE_STATE);
      this.index.reset();
      this.scan();
      return touched;
    });
  }

  /** Lets automatic archival consider a period again after a manual unarchive. */
  restoreAuto(period: string): void {
    const state = this.archiveState();
    const current = state.periods[period];
    if (!current) return;
    state.periods[period] = { ...current, auto: true };
    this.#writeArchiveState(state);
  }

  /** Compresses or decompresses one segment, recoverably. Identity, dates and placement don't change. */
  #setCompression(rel: string, compress: boolean): string[] {
    const isGz = rel.endsWith(".gz");
    if (isGz === compress) return [];
    const ref = parseSegmentPath(rel);
    if (!ref) return [];
    const text = this.readSegmentText(rel);
    const target = segmentPath(ref.period, ref.seq, compress);
    replaceFile(this.root, rel, target, compress ? gzipDeterministic(text) : text);
    this.index.forget(rel);
    return [rel, target];
  }

  /**
   * Periods old enough to archive on their own. Eligibility is measured from the
   * end of the whole period in the Roll's zone — September is considered once
   * September is over, not once an entry in it is old — and a period somebody
   * unarchived by hand is left alone.
   */
  dueForArchive(now: Date = new Date()): string[] {
    const settings = this.settings();
    if (!settings.archive.afterDays) return [];
    this.scan();
    const state = this.archiveState();
    const periods = new Set(this.index.data.segments.map((s) => s.period).filter(Boolean));
    const due: string[] = [];
    for (const period of periods) {
      const current = state.periods[period];
      if (current?.archived || current?.auto === false) continue;
      const end = periodEnd(period, settings.timezone).getTime();
      if (now.getTime() - end >= settings.archive.afterDays * 86_400_000) due.push(period);
    }
    return due.sort();
  }

  // ── Housekeeping ─────────────────────────────────────────────────────────

  /**
   * What the Roll costs on this computer. Attachments are counted separately
   * from entries, because they dominate a Roll with photos in it and rollover
   * has nothing to do with them. This is the working copy: Git's own history is
   * not included, and neither archival nor gzip makes history smaller.
   */
  usage(): Usage {
    this.scan();
    let attachmentBytes = 0;
    let attachments = 0;
    for (const rel of walkFiles(this.root, FILES_DIR).files) {
      attachments += 1;
      try {
        attachmentBytes += fs.lstatSync(insideRoll(this.root, rel)).size;
      } catch {
        // a file that vanished between listing and measuring
      }
    }
    let segmentBytes = 0;
    let archivedBytes = 0;
    let largest: Usage["largest"] = null;
    for (const segment of this.index.data.segments) {
      const size = fs.existsSync(insideRoll(this.root, segment.path)) ? fs.lstatSync(insideRoll(this.root, segment.path)).size : 0;
      segmentBytes += size;
      if (segment.archived) archivedBytes += size;
      // Measured uncompressed, because that is what rollover is measured against.
      if (!largest || segment.bytes > largest.bytes) largest = { path: segment.path, bytes: segment.bytes, entries: segment.entries };
    }
    return {
      segmentBytes,
      archivedBytes,
      attachmentBytes,
      attachments,
      segments: this.index.data.segments.length,
      entries: this.index.data.entries.length,
      archivedEntries: this.index.data.entries.filter((e) => e.archived).length,
      largest,
    };
  }
}

export const MOVED_PATH = ".gitroll/moved.yaml";

/** Old path → permanent id, so a link written before the migration still finds its entry. */
export function readMoved(store: { root: string }): Record<string, string> {
  try {
    const text = safeRead(store.root, MOVED_PATH).toString("utf8");
    const out: Record<string, string> = {};
    for (const line of text.split("\n")) {
      const m = /^\s*"?([^"\s:]+)"?:\s*([0-9A-HJKMNP-TV-Z]{26})\s*$/.exec(line);
      if (m) out[m[1]] = m[2];
    }
    return out;
  } catch {
    return {};
  }
}

export function writeMoved(store: { root: string }, moved: Record<string, string>): void {
  const lines = [
    "# Where events went when this Roll was grouped into monthly or daily files.",
    "# Each line maps the old file to the entry's permanent id, so old links still resolve.",
    "moved_version: 1",
  ];
  for (const from of Object.keys(moved).sort()) lines.push(`"${from}": ${moved[from]}`);
  writeAtomic(store.root, MOVED_PATH, `${lines.join("\n")}\n`);
}


// ── Helpers ────────────────────────────────────────────────────────────────

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** The device's zone, used only for a Roll that has never recorded one. */
export function deviceZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

const zonedToday = (now: Date, tz: string) => formatInZone(now, tz).slice(0, 10);

/** Writes the keys GitRoll owns into an entry's front matter, leaving everything else alone. */
export function stampContent(content: string, fields: { date?: string; filed?: string; created?: string; key?: string }): string {
  const changes: Record<string, unknown> = {};
  const { frontMatter } = splitFrontMatter(content);
  const has = (key: string) => !!frontMatter && new RegExp(`^${key}:`, "m").test(frontMatter);
  if (fields.date && !has("date")) changes.date = fields.date;
  if (fields.filed) changes.filed = fields.filed;
  if (fields.created && !has("created")) changes.created = fields.created;
  if (fields.key && !has("key")) changes.key = fields.key;
  let out = content;
  for (const [key, value] of Object.entries(changes)) out = setKey(out, key, String(value));
  return out;
}

function setKey(content: string, key: string, value: string): string {
  const parts = splitFrontMatter(content);
  const front = parts.frontMatter ?? "";
  const line = `${key}: ${value}`;
  const next = new RegExp(`^${key}:.*$`, "m").test(front) ? front.replace(new RegExp(`^${key}:.*$`, "m"), line) : `${front.replace(/\n*$/, "")}\n${line}`.replace(/^\n/, "");
  return `---\n${next.trim()}\n---\n\n${parts.body.replace(/^\s*\n/, "").trimEnd()}\n`;
}

/** Removes one front-matter key, for a value the file's own path now states. */
export function dropKey(content: string, key: string): string {
  const parts = splitFrontMatter(content);
  if (!parts.frontMatter) return content;
  const front = parts.frontMatter.replace(new RegExp(`^${key}:.*(?:\\n|$)`, "m"), "").trim();
  const body = parts.body.replace(/^\s*\n/, "").trimEnd();
  return front ? `---\n${front}\n---\n\n${body}\n` : `${body}\n`;
}

const splitDate = (content: string): string | null => {
  const m = /^date:\s*(.+)$/m.exec(splitFrontMatter(content).frontMatter ?? "");
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
};

function toIndexed(entry: StoredEntry, bytes: number): IndexedEntry {
  const key = typeof (entry.meta as Record<string, unknown>).key === "string" ? ((entry.meta as Record<string, unknown>).key as string) : undefined;
  return {
    id: entry.id,
    path: entry.path,
    date: entry.date,
    filed: entry.filed,
    created: entry.created,
    title: entry.title,
    tags: entry.tags,
    archived: entry.archived,
    bytes,
    ...(key ? { key } : {}),
  };
}

/** .gitroll/archive.yaml is small, versioned and hand-editable; it is parsed strictly. */
export function parseArchiveYaml(text: string): ArchiveState {
  const state: ArchiveState = { version: ARCHIVE_STATE_VERSION, periods: {} };
  let period: string | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trimEnd();
    const version = /^archive_version:\s*(\d+)/.exec(line);
    if (version) {
      state.version = Number(version[1]);
      continue;
    }
    const head = /^ {2}"?([0-9]{4}-[0-9]{2}(?:-[0-9]{2})?)"?:\s*$/.exec(line);
    if (head) {
      period = head[1];
      state.periods[period] = { archived: false, compressed: false, auto: true };
      continue;
    }
    const field = /^ {4}(\w+):\s*(.+)$/.exec(line);
    if (field && period) {
      const value = field[2].trim();
      const current = state.periods[period];
      if (field[1] === "archived") current.archived = value === "true";
      else if (field[1] === "compressed") current.compressed = value === "true";
      else if (field[1] === "auto") current.auto = value !== "false";
      else if (field[1] === "at") current.at = value;
    }
  }
  if (state.version > ARCHIVE_STATE_VERSION) {
    throw new UserError(`.gitroll/archive.yaml is version ${state.version}; this GitRoll understands ${ARCHIVE_STATE_VERSION}. Update GitRoll.`);
  }
  return state;
}

export function serializeArchiveYaml(state: ArchiveState): string {
  const lines = [
    "# Which filing periods are archived, and whether their files are compressed.",
    "# GitRoll writes this file; it is committed like everything else in .gitroll/.",
    `archive_version: ${ARCHIVE_STATE_VERSION}`,
    "periods:",
  ];
  for (const period of Object.keys(state.periods).sort()) {
    const p = state.periods[period];
    lines.push(`  "${period}":`);
    lines.push(`    archived: ${p.archived}`);
    lines.push(`    compressed: ${p.compressed}`);
    lines.push(`    auto: ${p.auto}`);
    if (p.at) lines.push(`    at: ${p.at}`);
  }
  return `${lines.join("\n")}\n`;
}
