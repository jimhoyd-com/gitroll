// WIKI LINKS. `[[Ada Lovelace]]` is how Obsidian, Logseq, Foam and most
// agents write a link between notes: by name, not by path. A reader resolves
// one against every event and note in the Roll, so it counts as a link
// wherever an ordinary relative link does (related, backlinks, an issue's
// activity, a contact's history):
//
//   [[Ada Lovelace]]                 by title, file name, path or alias
//   [[Ada Lovelace|Ada]]             shown as "Ada"
//   [[Ada Lovelace#Letters]]         a heading in it; the link is to the note
//   ![[Ada Lovelace]]                an embed, read as a link
//   org: "[[Acme]]"                  a front matter value that is exactly one
//
// A name is matched, ignoring case, against each document's path (with or
// without `.gitroll/`, `notes/` or `events/`, and `.md`), then its file name,
// then its title, then its `aliases:` (Obsidian's key; `alias:` also), and
// the first of those that names exactly one document wins. A name that
// matches nothing, or two documents equally, links nowhere and `gitroll
// check` says so. GitRoll itself still writes relative links, which GitHub
// and every editor follow; wiki links are read, never written.

import type { Entry } from "./entry.ts";
import { baseName, stripCode } from "./entry.ts";

export interface WikiLink {
  /** The name as written, before any `|label` or `#heading`. */
  target: string;
  label: string | null;
  heading: string | null;
  embed: boolean;
}

/** Reads `[[target#heading|label]]` once the brackets are taken off; null when there is no name in it. */
function readInner(inner: string, embed: boolean): WikiLink | null {
  const bar = inner.indexOf("|");
  const head = bar < 0 ? inner : inner.slice(0, bar);
  const label = bar < 0 ? null : inner.slice(bar + 1).trim() || null;
  const hash = head.indexOf("#");
  const target = (hash < 0 ? head : head.slice(0, hash)).trim();
  const heading = hash < 0 ? null : head.slice(hash + 1).trim() || null;
  return target ? { target, label, heading, embed } : null;
}

/**
 * The wiki links in a document's text, in order: `[[…]]` on one line, with no
 * brackets inside. Scanned by hand, so no text can make a pattern backtrack.
 */
export function wikiLinksIn(text: string): WikiLink[] {
  const s = stripCode(text);
  const out: WikiLink[] = [];
  let i = 0;
  while (i < s.length) {
    const open = s.indexOf("[[", i);
    if (open < 0) break;
    let j = open + 2;
    while (j < s.length && s[j] !== "]" && s[j] !== "[" && s[j] !== "\n") j++;
    if (s[j] === "]" && s[j + 1] === "]") {
      const link = readInner(s.slice(open + 2, j), open > 0 && s[open - 1] === "!");
      if (link) out.push(link);
      i = j + 2;
    } else i = open + 2;
  }
  return out;
}

/** A front matter value that is exactly one wiki link, `[[Acme]]`; null for anything else. */
export function wikiValue(v: unknown): WikiLink | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s.startsWith("[[") || !s.endsWith("]]")) return null;
  const inner = s.slice(2, -2);
  return /[[\]\n]/.test(inner) ? null : readInner(inner, false);
}

/** How a name is compared: ignoring case, runs of space, and a trailing `.md`. */
export const wikiKey = (s: string): string => s.trim().replace(/\s+/g, " ").replace(/\.md$/i, "").toLowerCase();

/** A document's `aliases:` (or `alias:`), one name or a list of them. */
export function aliasesOf(e: Entry): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(e.meta)) {
    const key = k.toLowerCase();
    if (key !== "aliases" && key !== "alias") continue;
    for (const x of Array.isArray(v) ? v : [v]) if (typeof x === "string" && x.trim()) out.push(x.trim());
  }
  return out;
}

export type WikiResolution = { path: string } | { ambiguous: string[] } | null;

/** Every document's names, by how strongly each names it: path, then file name, then title, then alias. */
export class WikiIndex {
  #tiers: Map<string, string[]>[] = [new Map(), new Map(), new Map(), new Map()];

  constructor(docs: Entry[]) {
    for (const d of docs) {
      const bare = d.path.replace(/^\.gitroll\//i, "").replace(/\.md$/i, "");
      const paths = new Set([d.path, bare, bare.replace(/^(notes|events)\//i, "")].map(wikiKey));
      for (const p of paths) this.#add(0, p, d.path);
      this.#add(1, wikiKey(baseName(d.path)), d.path);
      if (d.title.trim()) this.#add(2, wikiKey(d.title), d.path);
      for (const a of aliasesOf(d)) this.#add(3, wikiKey(a), d.path);
    }
  }

  #add(tier: number, key: string, path: string): void {
    if (!key) return;
    const list = this.#tiers[tier].get(key);
    if (!list) this.#tiers[tier].set(key, [path]);
    else if (!list.includes(path)) list.push(path);
  }

  /** The document a name means: the first tier that names exactly one; ambiguous when the first that names any names several. */
  resolve(name: string): WikiResolution {
    const key = wikiKey(name);
    for (const tier of this.#tiers) {
      const hits = tier.get(key);
      if (!hits) continue;
      return hits.length === 1 ? { path: hits[0] } : { ambiguous: [...hits].sort() };
    }
    return null;
  }
}

/** Every wiki link a document has, in its text and then in its front matter values. */
export function documentWikiLinks(e: Entry): WikiLink[] {
  const out = wikiLinksIn(e.body);
  for (const v of Object.values(e.meta)) {
    for (const x of Array.isArray(v) ? v : [v]) {
      const link = wikiValue(x);
      if (link) out.push(link);
    }
  }
  return out;
}

/**
 * The documents with their wiki links resolved: each one that has any gets
 * `wikiLinks` (name → path, for front matter values) and the documents its
 * text names added to `links`, after its relative links. Documents without
 * wiki links are returned as they are, never copied.
 */
export function withWikiLinks<T extends Entry>(docs: T[]): T[] {
  let index: WikiIndex | null = null;
  return docs.map((d) => {
    if (!d.body.includes("[[") && !Object.values(d.meta).some((v) => JSON.stringify(v ?? "").includes("[["))) return d;
    const links = documentWikiLinks(d);
    if (!links.length) return d;
    index ??= new WikiIndex(docs);
    const resolved: Record<string, string> = {};
    const added: string[] = [];
    const inText = new Set(wikiLinksIn(d.body).map((l) => wikiKey(l.target)));
    for (const l of links) {
      const hit = index.resolve(l.target);
      if (!hit || !("path" in hit) || hit.path === d.path) continue;
      resolved[wikiKey(l.target)] = hit.path;
      if (inText.has(wikiKey(l.target)) && !d.links.includes(hit.path) && !added.includes(hit.path)) added.push(hit.path);
    }
    return { ...d, links: [...d.links, ...added], wikiLinks: resolved };
  });
}

/** The wiki links in `docs` that lead nowhere, or to two documents at once: what `gitroll check` reports. */
export function wikiProblems(docs: Entry[]): { path: string; target: string; ambiguous: string[] | null }[] {
  const index = new WikiIndex(docs);
  const out: { path: string; target: string; ambiguous: string[] | null }[] = [];
  for (const d of docs) {
    const seen = new Set<string>();
    for (const l of documentWikiLinks(d)) {
      const key = wikiKey(l.target);
      if (seen.has(key)) continue;
      seen.add(key);
      const hit = index.resolve(l.target);
      if (!hit) out.push({ path: d.path, target: l.target, ambiguous: null });
      else if ("ambiguous" in hit) out.push({ path: d.path, target: l.target, ambiguous: hit.ambiguous });
    }
  }
  return out;
}
