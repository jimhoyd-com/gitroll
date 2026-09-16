// Where a grouped log segment lives, and what its name means.
//
//   .gitroll/logs/2026/09.md        September 2026, first segment
//   .gitroll/logs/2026/09-002.md    …and the next one, when the first filled up
//   .gitroll/logs/2026/09/16.md     a daily Roll: 16 September 2026
//   .gitroll/logs/2026/09/16-002.md
//   .gitroll/logs/2026/09.md.gz     the same file, archived and compressed
//
// The unnumbered file is segment one. Overflow numbering starts at 002, is at
// least three digits wide, and only ever goes up: nothing is renamed or
// renumbered when a segment is added or removed, so a link, a `git log` and a
// person's memory all keep working. Numbers are compared as numbers, so 010
// comes after 009 and 1000 after 999.

import { GITROLL_DIR } from "./layout.ts";
import { UserError } from "./util.ts";

export const LOGS_DIR = `${GITROLL_DIR}/logs`;

/** How a Roll groups its entries into files. */
export type StorageMode = "event" | "monthly" | "daily";

/** Any segment file, compressed or not. */
export const SEGMENT_FILE = /^\.gitroll\/logs\/(\d{4})\/(\d{2})(?:\/(\d{2}))?(?:-(\d{3,}))?\.md(\.gz)?$/;

export interface SegmentRef {
  /** The filing period the segment holds: 2026-09 for a month, 2026-09-16 for a day. */
  period: string;
  /** 1 for the unnumbered file, then 2, 3, … */
  seq: number;
  mode: Exclude<StorageMode, "event">;
  compressed: boolean;
  path: string;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** The period a filing date belongs to under a given mode. */
export function periodFor(filingDate: string, mode: StorageMode): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(filingDate.slice(0, 10));
  if (!m) throw new UserError(`Invalid filing date: ${filingDate} (use 2026-09-16)`);
  return mode === "daily" ? `${m[1]}-${m[2]}-${m[3]}` : `${m[1]}-${m[2]}`;
}

export const modeOfPeriod = (period: string): Exclude<StorageMode, "event"> => (period.length > 7 ? "daily" : "monthly");

/** The file a segment of a period is stored in. Segment 1 has no number. */
export function segmentPath(period: string, seq = 1, compressed = false): string {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(period);
  if (!m) throw new UserError(`Invalid period: ${period}`);
  if (!Number.isInteger(seq) || seq < 1) throw new UserError(`Invalid segment number: ${seq}`);
  const dir = m[3] ? `${LOGS_DIR}/${m[1]}/${m[2]}` : `${LOGS_DIR}/${m[1]}`;
  const stem = m[3] ? m[3] : m[2];
  const suffix = seq > 1 ? `-${pad(seq, 3)}` : "";
  return `${dir}/${stem}${suffix}.md${compressed ? ".gz" : ""}`;
}

/** Reads a segment path back. Returns null for anything that isn't one. */
export function parseSegmentPath(path: string): SegmentRef | null {
  const m = SEGMENT_FILE.exec(path.replace(/^\.?\//, ""));
  if (!m) return null;
  const [, year, month, day, num, gz] = m;
  const seq = num ? Number(num) : 1;
  // "-001" would be a second name for segment one; there is only ever one name.
  if (num && seq < 2) return null;
  const period = day ? `${year}-${month}-${day}` : `${year}-${month}`;
  return { period, seq, mode: day ? "daily" : "monthly", compressed: !!gz, path };
}

/** Both names of a segment: the plain file and the compressed one. */
export const segmentVariants = (ref: Pick<SegmentRef, "period" | "seq">): { plain: string; gz: string } => ({
  plain: segmentPath(ref.period, ref.seq, false),
  gz: segmentPath(ref.period, ref.seq, true),
});

/** Period first, then segment number as a number. Deterministic everywhere. */
export const compareSegments = (a: SegmentRef, b: SegmentRef): number => a.period.localeCompare(b.period) || a.seq - b.seq;

export const sortSegments = <T extends SegmentRef>(refs: T[]): T[] => refs.sort(compareSegments);

/** Every segment of one period, in order. */
export const segmentsOfPeriod = <T extends SegmentRef>(refs: T[], period: string): T[] => sortSegments(refs.filter((r) => r.period === period));

/** The number a new segment of this period takes: one past the highest there is. */
export function nextSeq(refs: SegmentRef[], period: string): number {
  const used = refs.filter((r) => r.period === period).map((r) => r.seq);
  return used.length ? Math.max(...used) + 1 : 1;
}
