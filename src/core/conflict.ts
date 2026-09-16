// An event changed in two places keeps both texts: this device's, and the other
// one quoted underneath a note. Writing that note and reading it back are the
// same rule, so they live together — and reading it is pure, so every interface
// can show the two versions side by side without a filesystem or a Git command.

export const CONFLICT_TAG = "conflict";

export const conflictNote = (day: string): string =>
  `**Sync note (${day}):** this event was changed on another device too. That version said: #${CONFLICT_TAG}`;

const NOTE_LINE = /^\*\*Sync note \((\d{4}-\d{2}-\d{2})\):\*\* this event was changed on another device too\. That version said: #conflict\s*$/m;

export interface SplitConflict {
  /** The version this device had, with the sync note removed. */
  mine: string;
  /** The other version, unquoted. */
  theirs: string;
  noted: string;
}

/**
 * Takes a conflicted event back apart into the two versions it holds. Returns
 * null when the file has no sync note — a person may have tidied it up by hand,
 * which is theirs to do.
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
