// Events refer to each other with ordinary Markdown links:
//
//   Follows [the incident on the 14th](2026-09-14-checkout-timeouts.md).
//
// That link is the relationship. Nothing declares it, nothing indexes it, and
// it still reads correctly on GitHub or in a text editor. Backlinks are simply
// the same links read the other way round, worked out when they're needed.

import type { Entry } from "./entry.ts";

export interface Related<T extends Entry> {
  /** Events this one links to, in the order they appear in the text. */
  links: T[];
  /** Events that link to this one, newest first. */
  backlinks: T[];
  /** Paths this event links to that aren't in the Roll (a typo, or a file not pushed yet). */
  missing: string[];
}

export function related<T extends Entry>(entry: Entry, all: T[]): Related<T> {
  const byPath = new Map(all.map((e) => [e.path, e]));
  const links: T[] = [];
  const missing: string[] = [];
  for (const path of entry.links) {
    const hit = byPath.get(path);
    if (hit) links.push(hit);
    else missing.push(path);
  }
  const backlinks = all.filter((e) => e.path !== entry.path && e.links.includes(entry.path));
  return { links, backlinks, missing };
}

/** Every event that links to `path`. */
export const backlinks = <T extends Entry>(path: string, all: T[]): T[] => all.filter((e) => e.links.includes(path));
