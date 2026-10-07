// PINS. An event or a note with `pinned: true` in its front matter is pinned:
// shown first, above everything else, wherever a list of them is read in
// order (the timeline, `gitroll recent`, a search). Pinning is a field like
// any other, so it is set and removed with the same one-key edit as `gitroll
// set`, and the file never moves or changes its name.

import type { Entry } from "./entry.ts";
import { metaValue } from "./calendar.ts";

export const PINNED_FIELD = "pinned";

/** Whether a document is pinned: its `pinned` field is `true` (the key in any case). */
export const isPinned = (e: Entry): boolean => metaValue(e.meta, PINNED_FIELD) === true;

/** The same documents with the pinned ones first, each part keeping the order it was given in. */
export function pinnedFirst<T extends Entry>(entries: T[]): T[] {
  const pinned = entries.filter(isPinned);
  return pinned.length ? [...pinned, ...entries.filter((e) => !isPinned(e))] : entries;
}
