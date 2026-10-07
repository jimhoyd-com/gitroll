// LARGE FILES IN PARTS. GitHub warns about a file over 50 MB and refuses one
// over 100 MB, so a large file is kept as numbered parts, named the way
// `split`, 7-Zip and HJSplit name volumes:
//
//   files/house-walkthrough.mp4.001
//   files/house-walkthrough.mp4.002
//   files/house-walkthrough.mp4.md     sidecar: parts, size and sha256 of the whole file
//
// `cat house-walkthrough.mp4.0* > house-walkthrough.mp4` puts it back together
// with nothing but a shell, and `sha256sum` checks it against the sidecar.
// Links keep pointing at the whole name; readers resolve it to the parts.
//
// Platform-free: no hashing or file access here, only names and numbers.

/** Parts are 45 MB by default: under GitHub's 50 MB warning, far under its 100 MB limit. */
export const DEFAULT_PART_SIZE = 45 * 1024 * 1024;
/** No part may be larger than this, whatever config.yaml says: GitHub refuses files over 100 MB. */
export const MAX_PART_SIZE = 95 * 1024 * 1024;
/**
 * Three-digit volume numbers, as `split -a 3 --numeric-suffixes=1` and 7-Zip
 * write them. Past 999 the names stop sorting as a shell glob sorts them, and
 * `cat name.0*` would join them in the wrong order, so that is the limit.
 */
export const MAX_PARTS = 999;

const UNITS: Record<string, number> = { "": 1024 * 1024, b: 1, k: 1024, kb: 1024, kib: 1024, m: 1024 * 1024, mb: 1024 * 1024, mib: 1024 * 1024, g: 1024 ** 3, gb: 1024 ** 3, gib: 1024 ** 3 };
const SIZE = /^(\d{1,12}(?:\.\d{1,6})?)\s?([a-z]{0,3})$/;

/**
 * `part_size` from config.yaml: a number of megabytes (`part_size: 45`) or a
 * size with a unit (`part_size: 45MB`, `512 KB`). Anything unreadable, zero or
 * negative means the default; anything over the ceiling is held to it.
 */
export function parsePartSize(v: unknown): number {
  let bytes = Number.NaN;
  if (typeof v === "number") bytes = v * UNITS[""];
  else if (typeof v === "string") {
    const m = SIZE.exec(v.trim().toLowerCase());
    if (m && Object.hasOwn(UNITS, m[2])) bytes = Number(m[1]) * UNITS[m[2]];
  }
  if (!Number.isFinite(bytes) || bytes < 1) return DEFAULT_PART_SIZE;
  return Math.min(Math.floor(bytes), MAX_PART_SIZE);
}

/** The name of part `n` (from 1) of a file: `name.ext.001`. */
export const partName = (path: string, n: number): string => `${path}.${String(n).padStart(3, "0")}`;

/** How many parts a file of this size needs. A file at or under the part size isn't split. */
export function partCount(size: number, partSize: number): number {
  return size <= partSize ? 1 : Math.ceil(size / partSize);
}

/** `name.ext.002` → { base: "name.ext", n: 2 }; anything else → null. */
export function partOf(path: string): { base: string; n: number } | null {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  if (dot <= slash + 1) return null;
  const digits = path.slice(dot + 1);
  if (digits.length < 3 || digits.length > 4) return null;
  for (let i = 0; i < digits.length; i++) if (digits.charCodeAt(i) < 48 || digits.charCodeAt(i) > 57) return null;
  const n = Number(digits);
  return n >= 1 ? { base: path.slice(0, dot), n } : null;
}

/** What a parts sidecar records, read from its front matter. */
export interface PartsRecord {
  parts: number | null;
  size: number | null;
  /** Lower-case hex, as `sha256sum` prints it. */
  sha256: string | null;
}

const HEX64 = /^[0-9a-f]{64}$/;

const wholeNumber = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,16}$/.test(v.trim()) ? Number(v) : Number.NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};

export function partsRecord(meta: Record<string, unknown>): PartsRecord {
  const hash = typeof meta.sha256 === "string" ? meta.sha256.trim().toLowerCase() : "";
  return { parts: wholeNumber(meta.parts), size: wholeNumber(meta.size), sha256: HEX64.test(hash) ? hash : null };
}

/** Whether a string is a SHA-256 digest in hex. */
export const isSha256 = (s: string): boolean => HEX64.test(s);

/**
 * What's wrong with a set of parts, given what the sidecar says: missing parts
 * (the file can't be put back together), and parts beyond the count. `found`
 * are the part numbers present.
 */
export function partProblems(found: number[], expected: number | null): { missing: number[]; extra: number[] } {
  const have = new Set(found);
  const count = expected ?? Math.max(0, ...found);
  const missing: number[] = [];
  for (let n = 1; n <= Math.min(count, MAX_PARTS); n++) if (!have.has(n)) missing.push(n);
  const extra = expected === null ? [] : found.filter((n) => n > expected).sort((a, b) => a - b);
  return { missing, extra };
}
