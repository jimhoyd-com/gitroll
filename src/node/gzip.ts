// Archived segments may be gzipped. Two properties matter more than the saving:
//
//   • **Deterministic output.** The same Markdown compresses to the same bytes
//     on every machine, so re-archiving a period doesn't show up as a change in
//     `git diff`. Node writes an mtime and an OS byte into the gzip header by
//     default; both are zeroed here.
//   • **Recoverable.** Compressing writes the new file beside the old one, makes
//     it durable, and only then removes the old one, so an interrupted run
//     leaves either the plain file or the compressed one — plus, at worst, a
//     half-written temporary that the next run cleans up. There is never a
//     moment where both look authoritative.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { insideRoll } from "./fs-safe.ts";

const TEMP_SUFFIX = ".gitroll-tmp";

/** Byte-for-byte reproducible gzip of UTF-8 text. */
export function gzipDeterministic(text: string): Buffer {
  const out = zlib.gzipSync(Buffer.from(text, "utf8"), { level: 9 });
  // Header: magic, method, flags, mtime(4), XFL, OS. Zeroing the timestamp and
  // pinning OS to 255 ("unknown") keeps the bytes from recording when and where
  // they were made, so re-archiving a period is not a diff.
  out.writeUInt32LE(0, 4);
  out[9] = 0xff;
  return out;
}

export const gunzipText = (data: Buffer): string => zlib.gunzipSync(data).toString("utf8");

/** Writes a file durably: full content to a temporary, fsync, then rename over the target. */
export function writeAtomic(root: string, rel: string, data: Buffer | string): void {
  const abs = insideRoll(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}${TEMP_SUFFIX}`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, abs);
}

/**
 * Replaces `fromRel` with `toRel`, content first. Interrupted at any point, the
 * repository still holds exactly one readable copy of the segment.
 */
export function replaceFile(root: string, fromRel: string, toRel: string, data: Buffer | string): void {
  if (fromRel === toRel) {
    writeAtomic(root, toRel, data);
    return;
  }
  writeAtomic(root, toRel, data);
  fs.rmSync(insideRoll(root, fromRel), { force: true });
}

/** Clears temporaries a previous run left behind. Safe to call at any time. */
export function sweepTemporaries(root: string, relDir: string): string[] {
  const swept: string[] = [];
  const walk = (rel: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(insideRoll(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of entries) {
      const child = `${rel}/${d.name}`;
      if (d.isDirectory()) walk(child);
      else if (d.isFile() && d.name.endsWith(TEMP_SUFFIX)) {
        fs.rmSync(insideRoll(root, child), { force: true });
        swept.push(child);
      }
    }
  };
  walk(relDir);
  return swept;
}
