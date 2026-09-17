// How a Roll stores entries, and the rules that every part of GitRoll follows
// when it writes one. Pure: the app, the CLI, imports, sync and archival all
// call into here rather than each working out their own answer.

import { parse } from "yaml";
import { periodFor, segmentPath } from "./segments.ts";
import type { SegmentRef, StorageMode } from "./segments.ts";
import { isValidZone } from "./tz.ts";
import { UserError } from "./util.ts";

/** Rollover targets. They shape files; they never restrict what a person may write. */
export interface StorageLimits {
  /** Uncompressed bytes of file content. */
  maxBytes: number;
  maxEntries: number;
}

export interface ArchiveSettings {
  /** Archive a period automatically this many days after the period ends. 0 means never. */
  afterDays: number;
  /** Whether archiving also gzips the period's files. Archival and compression are separate settings. */
  compress: boolean;
}

export interface StorageSettings {
  mode: StorageMode;
  /** One IANA zone for the whole Roll. Filing dates are decided in it. */
  timezone: string;
  limits: StorageLimits;
  archive: ArchiveSettings;
}

export const DEFAULT_LIMITS: StorageLimits = { maxBytes: 1024 * 1024, maxEntries: 1000 };
/** New Rolls group by month; existing Rolls keep whatever they already do. */
export const DEFAULT_MODE: StorageMode = "monthly";
export const LEGACY_MODE: StorageMode = "event";

export const defaultStorage = (timezone: string, mode: StorageMode = DEFAULT_MODE): StorageSettings => ({
  mode,
  timezone,
  limits: { ...DEFAULT_LIMITS },
  archive: { afterDays: 0, compress: false },
});

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

const positive = (v: unknown, fallback: number): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.trim()) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

/**
 * Reads the `storage:` block of .gitroll/config.yaml.
 *
 * A Roll with no block at all is an existing one, and existing Rolls keep
 * per-event storage: a configuration change moves new entries, never old ones.
 * `fallbackZone` is the device's zone, used only when a Roll has never recorded
 * one — and it is written down the first time GitRoll files anything.
 */
export function parseStorage(configText: string, fallbackZone: string): StorageSettings {
  const data = isRecord(parse(configText || "")) ? (parse(configText) as Record<string, unknown>) : {};
  const block = isRecord(data.storage) ? data.storage : {};
  const rawMode = String(block.mode ?? "").trim().toLowerCase();
  const mode: StorageMode = rawMode === "monthly" || rawMode === "daily" || rawMode === "event" ? rawMode : LEGACY_MODE;
  const zone = String(block.timezone ?? data.timezone ?? "").trim();
  const limits = isRecord(block.limits) ? block.limits : {};
  const archive = isRecord(block.archive) ? block.archive : {};
  return {
    mode,
    timezone: zone && isValidZone(zone) ? zone : fallbackZone,
    limits: {
      maxBytes: positive(limits.max_bytes, DEFAULT_LIMITS.maxBytes),
      maxEntries: positive(limits.max_entries, DEFAULT_LIMITS.maxEntries),
    },
    archive: {
      afterDays: Math.max(0, positive(archive.after_days, 0)),
      compress: archive.compress === true,
    },
  };
}

/**
 * The zone a Roll has written down, or null when it has never recorded one.
 *
 * Which zone a logbook files by is a property of the Roll, not of whatever
 * machine happens to be reading it: the same entry must not be Tuesday on a
 * laptop and Wednesday on GitRoll.com. A Roll that hasn't recorded one yet is
 * read with the reader's own zone — and that is what the two disagree about,
 * so it is written down the first time anything is filed.
 */
export function recordedZone(configText: string): string | null {
  const data = isRecord(parse(configText || "")) ? (parse(configText) as Record<string, unknown>) : {};
  const block = isRecord(data.storage) ? data.storage : {};
  const zone = String(block.timezone ?? data.timezone ?? "").trim();
  return zone && isValidZone(zone) ? zone : null;
}

/**
 * A Roll's config with this `storage:` block in it, replacing any block it had.
 * Everything else in the file — the template version, the name, anything
 * somebody added by hand — comes back exactly as it was written.
 */
export function withStorage(configText: string, s: StorageSettings): string {
  const without = configText.replace(/^storage:\n(?:[ \t]+.*\n|\n(?=[ \t]))*/m, "");
  return `${without.replace(/\n*$/, "\n")}\n${serializeStorage(s)}`;
}

/** The `storage:` block as YAML, for a new Roll or a migration. */
export function serializeStorage(s: StorageSettings): string {
  return [
    "storage:",
    `  mode: ${s.mode}              # event | monthly | daily`,
    `  timezone: ${s.timezone}      # the one zone this Roll files entries in`,
    "  limits:",
    `    max_bytes: ${s.limits.maxBytes}   # rollover target, not a limit on what you can write`,
    `    max_entries: ${s.limits.maxEntries}`,
    "  archive:",
    `    after_days: ${s.archive.afterDays}   # 0 = only when you ask`,
    `    compress: ${s.archive.compress}`,
    "",
  ].join("\n");
}

// ── Rollover ───────────────────────────────────────────────────────────────

/** What a reader knows about one segment on disk. */
export interface SegmentState extends SegmentRef {
  /** Uncompressed content size. Compression never changes whether a segment is full. */
  bytes: number;
  entries: number;
}

export interface Placement {
  period: string;
  seq: number;
  path: string;
  /** True when this segment does not exist yet and has to be created. */
  created: boolean;
}

/**
 * Which segment a new entry joins.
 *
 * New entries always append to the highest-numbered segment of their period —
 * gaps left by deletions are not filled and nothing is redistributed — and a
 * new segment starts when adding this entry would push that one past either
 * target. An entry bigger than the whole target still gets written: it simply
 * sits in a segment of its own.
 */
export function placeEntry(segments: SegmentState[], period: string, entryBytes: number, limits: StorageLimits): Placement {
  const here = segments.filter((s) => s.period === period).sort((a, b) => a.seq - b.seq);
  const last = here[here.length - 1];
  if (!last) return { period, seq: 1, path: segmentPath(period, 1), created: true };
  const wouldExceed = last.bytes + entryBytes > limits.maxBytes || last.entries + 1 > limits.maxEntries;
  // An edit can leave a segment over target; the entry stays put and the *next*
  // addition opens a new one. An empty segment always takes the entry, however
  // big it is, so nothing a person writes is ever refused.
  if (!wouldExceed || last.entries === 0) return { period, seq: last.seq, path: last.path, created: false };
  const seq = last.seq + 1;
  return { period, seq, path: segmentPath(period, seq), created: true };
}

/** The period an entry with this filing date belongs to. */
export const periodOf = (filingDate: string, settings: StorageSettings): string => periodFor(filingDate, settings.mode);

/** A byte count for text, using only what every runtime has. */
export const byteLength = (text: string): number =>
  typeof TextEncoder === "function" ? new TextEncoder().encode(text).length : text.length;

export function requireGrouped(settings: StorageSettings): void {
  if (settings.mode === "event") throw new UserError("This Roll stores one event per file. Run `gitroll migrate --to monthly` first.");
}
