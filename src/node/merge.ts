// Merges two versions of the same event file when it was edited in two places.
//
// An event is a Markdown file, so the merge is the ordinary line-based one Git
// would do — and it succeeds whenever the two people touched different parts of
// the file. Nothing is ever dropped: when the same lines changed on both sides,
// this device's version stays as it is and the other version is kept in a note
// at the bottom, tagged #conflict so it's easy to find and tidy up.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isoDate } from "../core/util.ts";

export const CONFLICT_TAG = "conflict";

/** Three-way merge of an event file. `base` is null when both sides created it. */
export function mergeEntry(baseSource: string | null, mineSource: string, theirsSource: string): { text: string; conflicted: boolean } {
  if (mineSource === theirsSource) return { text: mineSource, conflicted: false };
  if (baseSource !== null && baseSource === theirsSource) return { text: mineSource, conflicted: false };
  if (baseSource !== null && baseSource === mineSource) return { text: theirsSource, conflicted: false };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gitroll-merge-"));
  try {
    const files = { mine: path.join(dir, "mine"), base: path.join(dir, "base"), theirs: path.join(dir, "theirs") };
    fs.writeFileSync(files.mine, mineSource);
    fs.writeFileSync(files.base, baseSource ?? "");
    fs.writeFileSync(files.theirs, theirsSource);
    try {
      const text = execFileSync("git", ["merge-file", "-p", "--diff3", files.mine, files.base, files.theirs], { encoding: "utf8" });
      return { text, conflicted: false };
    } catch (e) {
      const status = (e as { status?: number }).status ?? 0;
      if (status <= 0 || status >= 128) throw e;
      return { text: keepBoth(mineSource, theirsSource), conflicted: true };
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const NOTE = (day: string) => `**Sync note (${day}):** this event was changed on another device too. That version said: #${CONFLICT_TAG}`;
const NOTE_LINE = /^\*\*Sync note \((\d{4}-\d{2}-\d{2})\):\*\* this event was changed on another device too\. That version said: #conflict\s*$/m;

/** Overlapping edits: this device's file is left intact and the other version is appended. */
function keepBoth(mine: string, theirs: string): string {
  return [
    mine.trimEnd(),
    "",
    "---",
    "",
    NOTE(isoDate()),
    "",
    theirs
      .trim()
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n"),
    "",
  ].join("\n");
}

export interface SplitConflict {
  /** The version this device had, with the sync note removed. */
  mine: string;
  /** The other version, unquoted. */
  theirs: string;
  noted: string;
}

/**
 * Takes a conflicted event back apart into the two versions it holds, so they
 * can be shown side by side. Returns null when the file has no sync note — a
 * person may have tidied it up by hand, which is theirs to do.
 */
export function splitConflict(source: string): SplitConflict | null {
  const body = source.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n/, "").replace(/^\s*\n/, "");
  const note = NOTE_LINE.exec(body);
  if (!note) return null;
  const before = body.slice(0, note.index);
  const after = body.slice(note.index + note[0].length);
  const mine = before.replace(/\n*-{3,}\s*$/, "").trimEnd();
  const theirs = after
    .trim()
    .split("\n")
    .map((line) => line.replace(/^>\s?/, ""))
    .join("\n")
    .trim();
  return { mine, theirs, noted: note[1] };
}
