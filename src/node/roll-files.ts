// Files on their own, on this computer: listing what is under .gitroll/files/,
// copying a file in (splitting a large one into parts), writing a file's
// sidecar, and putting a file kept in parts back together.
//
// Every path into the Roll goes through fs-safe, so nothing here reads or
// writes outside it or through a symbolic link. The only file read from
// outside the Roll is the one `attach` is given by name.

import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FormatError, baseName } from "../core/entry.ts";
import type { Entry } from "../core/entry.ts";
import { exifDate } from "../core/exif.ts";
import { setFields } from "../core/fields.ts";
import type { FieldInput } from "../core/fields.ts";
import { bareFileEntry, groupFiles, inFiles, linkedFrom, parseSidecar, sidecarPath } from "../core/files.ts";
import type { StoredFile } from "../core/files.ts";
import { FILES_DIR, GITROLL_DIR, applyChanges, attachmentName, freePath, requireWritable } from "../core/layout.ts";
import type { EntryLink, LoadedEntry } from "../core/layout.ts";
import { MAX_PARTS, partCount, partName, partOf, partsRecord } from "../core/parts.ts";
import type { PartsRecord } from "../core/parts.ts";
import { removeJpegLocation } from "../core/privacy.ts";
import { SearchIndex } from "../core/search.ts";
import { ConflictError, NotFoundError, UserError, summarize } from "../core/util.ts";
import { insideRoll, safeRead, safeWrite, walkFiles } from "./fs-safe.ts";
import { sha256Of } from "./fs-source.ts";
import type { GitRoll } from "./repo.ts";

/** One file in the Roll, as `gitroll files` reports it. */
export interface FileInfo {
  /** The path links use, e.g. .gitroll/files/passport.pdf (for a file in parts, the whole name). */
  path: string;
  /** The sidecar's title, else the file's name. */
  title: string;
  /** Bytes, whole or summed over its parts; null when the file isn't here. */
  size: number | null;
  /** How many parts it is kept in, or null when it is one file. */
  parts: number | null;
  sidecar: string | null;
  /** SHA-256 of the sidecar's text, for `set --expect`; null without one. */
  revision: string | null;
  /** The sidecar's front matter. */
  fields: Record<string, unknown>;
  /** Events and notes that link to it. */
  linkedFrom: string[];
  /** Nothing links to it. */
  unfiled: boolean;
  /** A sidecar with no file (or parts) beside it. */
  missing: boolean;
}

const JPEG = /\.jpe?g$/i;
/** EXIF sits in the first segments of a JPEG; this is far more than any camera writes there. */
const EXIF_HEAD = 256 * 1024;

/** Every file under files/, grouped by the name a link uses. */
export function storedFiles(roll: GitRoll): StoredFile[] {
  return groupFiles(walkFiles(roll.root, FILES_DIR).files);
}

/** A file's record: its sidecar read, or just its name when there is no sidecar (or it can't be read). */
function recordOf(roll: GitRoll, f: StoredFile): Entry {
  if (f.sidecar) {
    try {
      return parseSidecar(f.sidecar, safeRead(roll.root, f.sidecar).toString("utf8"), f.path);
    } catch {
      // `gitroll check` reports a sidecar it can't read.
    }
  }
  return bareFileEntry(f.path);
}

/** Every sidecar in the Roll, read as a record. These are what `find` searches as is:file. */
export function sidecarEntries(roll: GitRoll): Entry[] {
  return storedFiles(roll)
    .filter((f) => f.sidecar)
    .map((f) => recordOf(roll, f))
    .filter((e) => e.path !== e.attachments[0]?.path);
}

/** What `gitroll find` searches: events, notes and file sidecars. */
export function searchRoll(roll: GitRoll, query: string): LoadedEntry[] {
  return new SearchIndex([...roll.documents(), ...sidecarEntries(roll)]).search(query);
}

const sizeOf = (roll: GitRoll, rel: string): number => fs.lstatSync(insideRoll(roll.root, rel)).size;

/** `gitroll files [query] [--unfiled]`: every file, what links to it, and whether anything does. */
export function listFiles(roll: GitRoll, opts: { query?: string; unfiled?: boolean } = {}): FileInfo[] {
  const files = storedFiles(roll);
  const links = linkedFrom(files, roll.documents());
  const records = new Map(files.map((f) => [f.path, recordOf(roll, f)]));
  let chosen = files;
  if (opts.query?.trim()) {
    const hits = new Set(new SearchIndex([...records.values()]).search(opts.query));
    chosen = files.filter((f) => hits.has(records.get(f.path)!));
  }
  return chosen
    .map((f): FileInfo => {
      const e = records.get(f.path)!;
      const stored = f.whole ? [f.path] : f.parts;
      const linkers = links.get(f.path) ?? [];
      return {
        path: f.path,
        title: e.title,
        size: stored.length ? stored.reduce((n, p) => n + sizeOf(roll, p), 0) : null,
        parts: f.parts.length ? f.parts.length : null,
        sidecar: f.sidecar,
        revision: f.sidecar ? createHash("sha256").update(safeRead(roll.root, f.sidecar)).digest("hex") : null,
        fields: f.sidecar ? e.meta : {},
        linkedFrom: linkers,
        unfiled: linkers.length === 0,
        missing: !stored.length,
      };
    })
    .filter((f) => !opts.unfiled || f.unfiled);
}

/**
 * The file a person means: its path (`.gitroll/files/x.pdf`, `files/x.pdf`, or
 * its sidecar's), its file name, or a distinctive part of its path. Null when
 * nothing under files/ matches; an error when several do.
 */
export function findFile(roll: GitRoll, target: string): StoredFile | null {
  const q = target.trim().replace(/\\/g, "/").replace(/^\.?\//, "");
  if (!q) return null;
  const files = storedFiles(roll);
  const forms = [q, `${GITROLL_DIR}/${q}`, `${FILES_DIR}/${q}`];
  const exact = files.find((f) => forms.includes(f.path) || (f.sidecar !== null && forms.includes(f.sidecar)));
  if (exact) return exact;
  const lower = q.toLowerCase();
  const byName = files.filter((f) => baseName(f.path).toLowerCase() === lower);
  if (byName.length === 1) return byName[0];
  const matches = files.filter((f) => f.path.toLowerCase().includes(lower));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new UserError(`More than one file matches "${target}":\n  ${matches.slice(0, 8).map((f) => f.path).join("\n  ")}`);
  return null;
}

/** Like findFile, but a file must be found. */
export function requireFile(roll: GitRoll, target: string): StoredFile {
  const f = findFile(roll, target);
  if (!f) throw new NotFoundError(`No file under ${FILES_DIR}/ matches "${target}". Try: gitroll files`);
  return f;
}

/** Text a sidecar change would produce, checked by reading it back, so a bad date or YAML is refused before anything is written. */
function sidecarText(rel: string, filePath: string, make: () => string): string {
  try {
    const text = make();
    parseSidecar(rel, text, filePath);
    return text;
  } catch (e) {
    if (e instanceof FormatError) throw new UserError(`Nothing was changed: ${rel} would have ${e.message}.`);
    throw e;
  }
}

/** The date a JPEG was taken, from its first bytes. */
function photoDate(abs: string): string | null {
  const fd = fs.openSync(abs, "r");
  try {
    const head = Buffer.alloc(EXIF_HEAD);
    const n = fs.readSync(fd, head, 0, head.length, 0);
    return exifDate(head.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
}

const hasKey = (fields: [string, FieldInput][], key: string) => fields.some(([k]) => k.toLowerCase() === key);

export interface AttachResult {
  /** Where it is now, the path links use. */
  path: string;
  size: number;
  /** How many parts it was split into, or null when it was small enough to keep whole. */
  parts: number | null;
  sha256: string;
  sidecar: string | null;
  /** The event or note now linking to it. */
  linkedFrom: string[];
  notices: string[];
}

/**
 * `gitroll attach <file>`: copies a file on this computer into files/, under a
 * readable name that isn't taken (`name-2.ext`; nothing is overwritten). A
 * file larger than the Roll's part size is written as numbered parts with a
 * sidecar recording their count, the whole file's size and its sha256. With
 * `to`, the event or note gets a link to it; with `fields`, the sidecar gets
 * those fields. A JPEG's EXIF date fills `date` when a sidecar is created and
 * no date was given.
 *
 * The only file read outside the Roll is `source`, exactly as named: no
 * globbing, no directories.
 */
export function attachFile(roll: GitRoll, source: string, opts: { to?: string; fields?: [string, FieldInput][] } = {}): AttachResult {
  const config = roll.config();
  requireWritable(config);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(source);
  } catch {
    throw new NotFoundError(`File not found: ${source}`);
  }
  if (!stat.isFile()) throw new UserError(`${source} isn't a file. Attach files one at a time.`);
  if (config.maxAttachmentMb !== undefined && stat.size > config.maxAttachmentMb * 1024 * 1024) {
    throw new UserError(`${path.basename(source)} is ${(stat.size / 1048576).toFixed(1)} MB. This Roll's limit (attachments.max_mb) is ${config.maxAttachmentMb} MB per file.`);
  }
  const count = partCount(stat.size, config.partSize);
  if (count > MAX_PARTS) throw new UserError(`${path.basename(source)} would take more than ${MAX_PARTS} parts of ${(config.partSize / 1048576).toFixed(0)} MB. Raise part_size in .gitroll/config.yaml, or keep a file this large outside Git.`);
  // Everything that can be refused is refused before a byte is written.
  const target = opts.to ? roll.entry(opts.to) : null;
  const fields = opts.fields ?? [];
  const exists = (rel: string) => fs.existsSync(path.join(roll.root, rel));
  const rel = freePath(FILES_DIR, attachmentName(path.basename(source)), (p) => exists(p) || exists(partName(p, 1)) || exists(sidecarPath(p)));
  const sidecar = count > 1 || fields.length ? sidecarPath(rel) : null;
  if (sidecar) sidecarText(sidecar, rel, () => setFields("", fields));

  const notices: string[] = [];
  const written: string[] = [];
  const hash = createHash("sha256");
  let date: string | null = null;
  if (count === 1) {
    let data: Uint8Array = fs.readFileSync(source);
    if (JPEG.test(rel)) {
      date = exifDate(data);
      if (config.removeLocation) {
        const cleaned = removeJpegLocation(data);
        if (cleaned.removed) notices.push(`Removed location data from ${path.basename(source)}.`);
        data = cleaned.bytes;
      }
    }
    hash.update(data);
    safeWrite(roll.root, rel, data);
    written.push(rel);
  } else {
    if (JPEG.test(rel)) {
      date = photoDate(source);
      if (config.removeLocation) notices.push(`${path.basename(source)} is too large for GitRoll to remove its location data; it was kept as it was.`);
    }
    const fd = fs.openSync(source, "r");
    try {
      let left = stat.size;
      for (let n = 1; n <= count; n++) {
        const buf = Buffer.alloc(Math.min(config.partSize, left));
        let got = 0;
        while (got < buf.length) {
          const read = fs.readSync(fd, buf, got, buf.length - got, null);
          if (read === 0) throw new UserError(`${source} got shorter while it was being read. Nothing was attached.`);
          got += read;
        }
        hash.update(buf);
        const part = partName(rel, n);
        safeWrite(roll.root, part, buf);
        written.push(part);
        left -= buf.length;
      }
    } finally {
      fs.closeSync(fd);
    }
  }
  const sha256 = hash.digest("hex");
  if (sidecar) {
    const record: [string, FieldInput][] = count > 1 ? [["parts", { value: count }], ["size", { value: stat.size }], ["sha256", { value: sha256 }]] : [];
    const dated: [string, FieldInput][] = date && !hasKey(fields, "date") ? [["date", { value: date }]] : [];
    safeWrite(roll.root, sidecar, sidecarText(sidecar, rel, () => setFields("", [...record, ...dated, ...fields])));
    written.push(sidecar);
  }
  const linked: string[] = [];
  if (target) {
    const link: EntryLink = { path: rel, name: path.basename(source), image: /\.(jpe?g|png|gif|webp|heic)$/i.test(rel) };
    safeWrite(roll.root, target.path, applyChanges(roll.entrySource(target.path), {}, [link], target.path));
    written.push(target.path);
    linked.push(target.path);
  }
  roll.commitPaths(written, `attach: ${summarize(baseName(rel))}`);
  return { path: rel, size: stat.size, parts: count > 1 ? count : null, sha256, sidecar, linkedFrom: linked, notices };
}

/**
 * `gitroll set <file> key=value`: sets fields in a file's sidecar, creating
 * the sidecar the first time. Only the YAML changes; the file is never
 * touched. A new sidecar for a JPEG takes `date` from its EXIF data unless a
 * date is being set.
 */
export function setFileFields(roll: GitRoll, f: StoredFile, set: [string, FieldInput][], unset: string[] = [], opts: { expect?: string } = {}): { entry: Entry; notices: string[]; changed: boolean } {
  requireWritable(roll.config());
  const rel = f.sidecar ?? sidecarPath(f.path);
  const before = f.sidecar ? safeRead(roll.root, rel).toString("utf8") : "";
  if (opts.expect !== undefined && opts.expect !== createHash("sha256").update(before).digest("hex")) {
    throw new ConflictError("This file's sidecar changed on disk since you read it, so nothing was saved.");
  }
  let fields = set;
  if (!f.sidecar && JPEG.test(f.path) && !hasKey(set, "date")) {
    const first = f.whole ? f.path : f.parts[0];
    const date = first ? photoDate(insideRoll(roll.root, first)) : null;
    if (date) fields = [["date", { value: date }], ...set];
  }
  const next = sidecarText(rel, f.path, () => setFields(before, fields, unset));
  if (next === before || (!f.sidecar && !next.trim())) return { entry: f.sidecar ? parseSidecar(rel, before, f.path) : bareFileEntry(f.path), notices: [], changed: false };
  safeWrite(roll.root, rel, next);
  const entry = parseSidecar(rel, next, f.path);
  roll.commitPaths([rel], `set: ${summarize(entry.title)}`);
  return { entry, notices: [], changed: true };
}

/** A file's bytes as stored: the file itself, or its parts in order. */
export interface WholeFile {
  path: string;
  /** Absolute paths to read, in order. */
  files: string[];
  size: number;
  parted: boolean;
  record: PartsRecord;
}

/**
 * What a link to `rel` reads: the file, or — when it isn't there and numbered
 * parts are — the parts in order. Null when it is neither, or not inside the
 * Roll. Parts are only looked for under files/, and a set with a gap, or with
 * fewer parts than its sidecar lists, is refused rather than served short.
 */
export function wholeFile(roll: GitRoll, rel: string): WholeFile | null {
  let abs: string;
  try {
    abs = insideRoll(roll.root, rel);
  } catch {
    return null;
  }
  const norm = path.relative(roll.root, abs).split(path.sep).join("/");
  const record = sidecarRecord(roll, norm);
  const file = roll.attachmentFile(norm);
  if (file) return { path: norm, files: [file], size: fs.lstatSync(file).size, parted: false, record };
  if (!inFiles(norm)) return null;
  const files: string[] = [];
  let size = 0;
  for (let n = 1; n <= MAX_PARTS; n++) {
    const part = roll.attachmentFile(partName(norm, n));
    if (!part) break;
    files.push(part);
    size += fs.lstatSync(part).size;
  }
  if (!files.length) return null;
  // A gap (001, 003) would otherwise stop at 001 and serve a file cut short.
  const base = path.basename(abs);
  const highest = Math.max(0, ...fs.readdirSync(path.dirname(abs)).map((name) => partOf(name)).filter((p) => p?.base === base).map((p) => p!.n));
  if (highest !== files.length || (record.parts !== null && record.parts !== files.length)) {
    throw new UserError(`${norm} is missing parts, so it can't be put back together. Run: gitroll check`);
  }
  return { path: norm, files, size, parted: true, record };
}

function sidecarRecord(roll: GitRoll, rel: string): PartsRecord {
  try {
    const sidecar = sidecarPath(rel);
    return partsRecord(parseSidecar(sidecar, safeRead(roll.root, sidecar).toString("utf8"), rel).meta);
  } catch {
    return { parts: null, size: null, sha256: null };
  }
}

/** Copies the bytes of `whole` into a new file at `out`, hashing as it goes. Written beside it first, then renamed, so `out` is never half there. */
function writeJoined(whole: WholeFile, out: string): string {
  const temp = `${out}.${randomBytes(6).toString("hex")}.partial`;
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    for (const file of whole.files) {
      const src = fs.openSync(file, "r");
      try {
        for (let n = fs.readSync(src, chunk, 0, chunk.length, null); n > 0; n = fs.readSync(src, chunk, 0, chunk.length, null)) {
          hash.update(chunk.subarray(0, n));
          fs.writeSync(fd, chunk, 0, n);
        }
      } finally {
        fs.closeSync(src);
      }
    }
  } catch (e) {
    fs.closeSync(fd);
    fs.rmSync(temp, { force: true });
    throw e;
  }
  fs.closeSync(fd);
  const sha256 = hash.digest("hex");
  if (whole.record.sha256 && whole.record.sha256 !== sha256) {
    fs.rmSync(temp, { force: true });
    throw new UserError(`${whole.path} doesn't match the sha256 in its sidecar, so it wasn't written. Run: gitroll check`);
  }
  if (fs.existsSync(out)) {
    fs.rmSync(temp, { force: true });
    throw new UserError(`${out} already exists. Nothing was overwritten.`);
  }
  fs.renameSync(temp, out);
  return sha256;
}

/**
 * `gitroll reassemble <file> --out <path>`: puts a file kept in parts back together
 * at `out` and checks it against the sha256 in its sidecar. Never overwrites.
 * Without GitRoll, `cat name.ext.0* > name.ext` does the same.
 */
export function joinFile(roll: GitRoll, target: string, out: string): { path: string; out: string; size: number; parts: number | null; sha256: string; verified: boolean } {
  const f = requireFile(roll, target);
  const whole = wholeFile(roll, f.path);
  if (!whole) throw new NotFoundError(`${f.path} isn't in this Roll: only its sidecar is.`);
  const dest = path.resolve(out);
  if (fs.existsSync(dest)) throw new UserError(`${out} already exists. Nothing was overwritten.`);
  const sha256 = writeJoined(whole, dest);
  return { path: f.path, out: dest, size: whole.size, parts: whole.parted ? whole.files.length : null, sha256, verified: whole.record.sha256 !== null };
}

/**
 * A file to hand to another app: the file itself when it is whole, or — for
 * one kept in parts — a private copy put back together in a new temporary
 * folder and checked against its sha256 first.
 */
export function openableFile(roll: GitRoll, target: string): { file: string; temporary: boolean } {
  const f = requireFile(roll, target);
  const whole = wholeFile(roll, f.path);
  if (!whole) throw new NotFoundError(`${f.path} isn't in this Roll: only its sidecar is.`);
  if (!whole.parted) return { file: whole.files[0], temporary: false };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gitroll-open-"));
  const file = path.join(dir, baseName(f.path));
  writeJoined(whole, file);
  return { file, temporary: true };
}

/** Opens a file in whatever app this computer uses for it. */
export function openInApp(file: string): void {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [file]] : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", file]] : ["xdg-open", [file]];
  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

/**
 * How much room the Roll takes: everything Git keeps (every version of every
 * file, which is what a clone downloads) and the largest files under files/ now.
 */
export function sizeReport(roll: GitRoll, top = 5): { gitBytes: number | null; filesBytes: number; largest: { path: string; size: number; parts: number | null }[] } {
  let gitBytes: number | null = null;
  try {
    const out = roll.git(["count-objects", "-v"]);
    const values = new Map(out.split("\n").map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1).trim()]));
    const kib = (key: string) => (/^\d+$/.test(values.get(key) ?? "") ? Number(values.get(key)) : 0);
    gitBytes = (kib("size") + kib("size-pack") + kib("size-garbage")) * 1024;
  } catch {
    gitBytes = null;
  }
  const sized = storedFiles(roll)
    .map((f) => {
      const stored = f.whole ? [f.path] : f.parts;
      return { path: f.path, size: stored.reduce((n, p) => n + sizeOf(roll, p), 0), parts: f.parts.length ? f.parts.length : null };
    })
    .filter((f) => f.size > 0);
  return { gitBytes, filesBytes: sized.reduce((n, f) => n + f.size, 0), largest: sized.sort((a, b) => b.size - a.size).slice(0, top) };
}

/** Bytes as a person reads them: 1.2 GB, 45 MB, 900 KB. */
export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(n >= 10 * 1024 ** 2 ? 0 : 1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

export { sha256Of };
