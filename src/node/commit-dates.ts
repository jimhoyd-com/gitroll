// When each entry was written down, read from Git.
//
// An entry logged as it happens records nothing about when: the commit that
// added it already says, to the second, with the author's own UTC offset. The
// permanent id is what makes that answerable per entry rather than per file —
// a marker line appears in exactly one commit's diff, the one that wrote it.
//
// Doing that per entry would mean a pickaxe search per entry. Instead one pass
// over the history of .gitroll/logs/ attributes every id to the commit that
// introduced it, and the result is cached in the local index. Afterwards only
// the commits since the last pass are read, so a sync or a save costs what it
// added, not what the Roll holds.

import { execFileSync } from "node:child_process";
import { LOGS_DIR } from "../core/segments.ts";

const ADDED_MARKER = /^\+<!--\s*gitroll:entry\s+([0-9A-HJKMNP-TV-Z]{26})/;
const ADDED_HEADING = /^\+#\s+(\S.*?)\s*$/;
const FILE_LINE = /^\+\+\+ b\/(.+)$/;
const COMMIT_LINE = /^\x1e([0-9a-f]+)\x1f(.+)$/;

export interface CommitScan {
  /** id → the author date of the commit that added it, e.g. 2026-09-16T06:51:57-05:00 */
  dates: Record<string, string>;
  /**
   * The same, for entries somebody typed into a file without a marker: keyed by
   * the file and the heading they wrote. Best effort — two entries with one
   * title in one file share a key — and only until GitRoll gives them an id.
   */
  headings: Record<string, string>;
  /** The commit this scan ran up to, so the next one can start there. */
  head: string | null;
}

/**
 * Reads the commits that added entries. `since` is the head of the previous
 * scan; the range after it is all that is read.
 */
export function scanCommitDates(root: string, since: string | null): CommitScan {
  const head = git(root, ["rev-parse", "HEAD"])?.trim() ?? null;
  if (!head) return { dates: {}, headings: {}, head: null };
  if (since === head) return { dates: {}, headings: {}, head };
  // Reachable from HEAD but not from the last scan. A rebase or a reset makes
  // `since` unreachable; Git then errors, and the caller rescans from scratch.
  const range = since ? `${since}..HEAD` : "HEAD";
  const out = git(root, ["log", "--reverse", "--format=%x1e%H%x1f%aI", "-p", "-U0", range, "--", LOGS_DIR]);
  if (out === null) return { dates: {}, headings: {}, head: null };

  const dates: Record<string, string> = {};
  const headings: Record<string, string> = {};
  let date = "";
  let file = "";
  for (const line of out.split("\n")) {
    const commit = COMMIT_LINE.exec(line);
    if (commit) {
      date = commit[2];
      continue;
    }
    const target = FILE_LINE.exec(line);
    if (target) {
      file = target[1];
      continue;
    }
    const heading = ADDED_HEADING.exec(line);
    if (heading && date && file) {
      const key = headingKey(file, heading[1]);
      if (!headings[key]) headings[key] = date;
    }
    const added = ADDED_MARKER.exec(line);
    // Oldest first, so the first commit to carry a marker is the one that
    // wrote it; later ones moved it between files and don't change when it
    // was written down.
    if (added && date && !dates[added[1]]) dates[added[1]] = date;
  }
  return { dates, headings, head };
}

/** The key an entry without a marker is remembered by. */
export const headingKey = (file: string, heading: string): string => `${file}\n${heading.replace(/\s+/g, " ").trim()}`;

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}
