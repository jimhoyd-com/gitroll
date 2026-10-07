// Events refer to each other with ordinary Markdown links:
//
//   Follows [the incident on the 14th](2026-09-14-checkout-timeouts.md).
//
// That link is the relationship. Nothing declares it, nothing indexes it, and
// it still reads correctly on GitHub or in a text editor. Backlinks are simply
// the same links read the other way round, worked out when they're needed.

import type { Entry } from "./entry.ts";
import { resolveLink } from "./entry.ts";

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
  // A link in a front matter field (`with:`, `location:`, `resolves:`) is a
  // link too, read after the ones in the text.
  for (const path of documentLinks(entry)) {
    const hit = byPath.get(path);
    if (hit) links.push(hit);
    else missing.push(path);
  }
  const backlinks = all.filter((e) => e.path !== entry.path && linksTo(e, entry.path));
  return { links, backlinks, missing };
}

/** The events and notes a document links to, in its text and then in its front matter. */
export function documentLinks(entry: Entry): string[] {
  const out = [...entry.links];
  for (const path of frontMatterLinks(entry)) if (path.toLowerCase().endsWith(".md") && !out.includes(path)) out.push(path);
  return out;
}

/** Every event that links to `path`, in its text or in its front matter. */
export const backlinks = <T extends Entry>(path: string, all: T[]): T[] => all.filter((e) => linksTo(e, path));

/** The target of a value that is exactly a Markdown link, `[Text](target)`; null for anything else. */
export function markdownLinkTarget(v: string): string | null {
  const s = v.trim();
  if (!s.startsWith("[") || !s.endsWith(")")) return null;
  const at = s.indexOf("](");
  if (at < 0) return null;
  let target = s.slice(at + 2, -1).trim();
  if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
  return target || null;
}

/** Where a front matter value that is a Markdown link points, resolved against its document; null when it isn't one. */
export function fieldLink(from: Entry, v: unknown): string | null {
  if (typeof v !== "string") return null;
  const target = markdownLinkTarget(v);
  return target ? resolveLink(from.path, target) : null;
}

/**
 * The documents a document's front matter links to: every value (or list
 * item) that is a Markdown link, like `location: "[Garage](../places/garage.md)"`.
 * Nested mappings and sealed values are not read.
 */
export function frontMatterLinks(entry: Entry): string[] {
  const out: string[] = [];
  for (const v of Object.values(entry.meta)) {
    for (const x of Array.isArray(v) ? v : [v]) {
      const path = fieldLink(entry, x);
      if (path && path !== entry.path && !out.includes(path)) out.push(path);
    }
  }
  return out;
}

/** Whether a document links to `path`, in its text or in its front matter. */
export const linksTo = (entry: Entry, path: string): boolean => entry.links.includes(path) || frontMatterLinks(entry).includes(path);
