// BOOKMARKS. A web page worth coming back to is a record with a `url`:
//
//   url                                      the page's address (http or https)
//   tags                                     what it is about, as anywhere else in a Roll
//   description                              why it was kept, or what it says
//   added                                    the day it was bookmarked
//
// The record's title is the page's title. It is not a new kind of file:
// `.gitroll/notes/bookmarks/` is a collection like any other, so a bookmark
// can carry any other field, be pinned, sealed or linked to, and events and
// notes that link to it are where it came up, read as backlinks.
//
// Bookmarks go out to, and come in from, the Netscape bookmark file every
// browser and bookmarking service exports and imports. The reader looks only
// at the four tags that file is made of (DL, DT's A, H3 and DD), each found
// by a scan that can't backtrack, so no input can make it slow.

import type { Entry } from "./entry.ts";
import { normalizeTag } from "./entry.ts";
import { metaValue } from "./calendar.ts";
import { values } from "./contacts.ts";
import type { Interaction } from "./contacts.ts";
import { incomingLinks } from "./organizations.ts";
import { isPinned } from "./pins.ts";

export const BOOKMARKS_COLLECTION = "bookmarks";

/** The keys a bookmark record uses, in the order a card shows them. */
export const BOOKMARK_FIELDS = ["url", "tags", "description", "added"];

// ── Addresses ──────────────────────────────────────────────────────────────

/** A web address a bookmark can hold: an absolute http or https URL, or null. */
export function webUrl(text: string): URL | null {
  const s = text.trim();
  if (!/^https?:\/\//i.test(s)) return null;
  try {
    const u = new URL(s);
    return u.hostname ? u : null;
  } catch {
    return null;
  }
}

/**
 * The address two bookmarks share when they are the same page: the scheme
 * and host in lower case, no default port, no fragment, and no trailing slash
 * on the path. `https://Example.com/docs/#intro` and
 * `https://example.com/docs` are one page; the query is kept, since it often
 * says which page it is.
 */
export function urlKey(text: string): string | null {
  const u = webUrl(text);
  if (!u) return null;
  u.hash = "";
  const path = u.pathname.replace(/\/+$/, "");
  return `${u.protocol}//${u.host}${path}${u.search}`;
}

/** A title for a page known only by its address: `example.com/docs/intro`. */
export function titleFromUrl(text: string): string {
  const u = webUrl(text);
  if (!u) return text.trim();
  const path = decodeURIComponentSafe(u.pathname.replace(/\/+$/, ""));
  return `${u.hostname.replace(/^www\./, "")}${path}`;
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// ── The view ───────────────────────────────────────────────────────────────

export interface Bookmark {
  path: string;
  title: string;
  /** The `url` as written; null when it has none, or it is sealed. */
  url: string | null;
  /** The host it is on, without `www.`, when `url` is a web address. */
  site: string | null;
  tags: string[];
  description: string | null;
  /** `added`, as YYYY-MM-DD, or null. */
  added: string | null;
  pinned: boolean;
  /** Events and notes that link to it, newest first. */
  linkedFrom: Interaction[];
}

export interface Bookmarks {
  collection: string;
  bookmarks: Bookmark[];
  /** Every tag on them, most used first, then by name. */
  tags: { tag: string; count: number }[];
  /** Pages bookmarked more than once, by the address they share. */
  duplicates: { url: string; paths: string[] }[];
}

/** One bookmark record, read. `into` is who links to what (see incomingLinks). */
export function bookmarkOf(r: Entry, into: Map<string, Entry[]> = new Map()): Bookmark {
  const url = values(metaValue(r.meta, "url"))[0] ?? null;
  const web = url ? webUrl(url) : null;
  const added = values(metaValue(r.meta, "added"))[0] ?? null;
  const linkedFrom = (into.get(r.path) ?? [])
    .filter((d) => d.path !== r.path)
    .map((d) => ({ path: d.path, title: d.title, date: d.date }))
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "") || a.title.localeCompare(b.title));
  return {
    path: r.path,
    title: r.title,
    url,
    site: web ? web.hostname.replace(/^www\./, "") : null,
    tags: r.tags,
    description: values(metaValue(r.meta, "description"))[0] ?? null,
    added: added && /^\d{4}-\d{2}-\d{2}/.test(added) ? added.slice(0, 10) : null,
    pinned: isPinned(r),
    linkedFrom,
  };
}

/**
 * The bookmarks view: the records given, pinned first, then newest added
 * (those with no `added` last), then by title. `docs` is every document, so
 * what links to each is found.
 */
export function bookmarks(records: Entry[], docs: Entry[] = records, collection = BOOKMARKS_COLLECTION): Bookmarks {
  const into = incomingLinks(docs);
  const list = records
    .map((r) => bookmarkOf(r, into))
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        (b.added ?? "").localeCompare(a.added ?? "") ||
        a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) ||
        a.path.localeCompare(b.path),
    );
  const tags = new Map<string, number>();
  for (const b of list) for (const t of b.tags) tags.set(t, (tags.get(t) ?? 0) + 1);
  const byUrl = new Map<string, string[]>();
  for (const b of list) {
    const key = b.url ? urlKey(b.url) : null;
    if (!key) continue;
    const paths = byUrl.get(key);
    if (paths) paths.push(b.path);
    else byUrl.set(key, [b.path]);
  }
  return {
    collection,
    bookmarks: list,
    tags: [...tags].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
    duplicates: [...byUrl].filter(([, paths]) => paths.length > 1).map(([url, paths]) => ({ url, paths: [...paths].sort() })),
  };
}

/** The bookmark among `records` for the same page as `url`, if there is one. */
export function findBookmark<T extends Entry>(records: T[], url: string): T | null {
  const key = urlKey(url);
  if (!key) return null;
  return records.find((r) => values(metaValue(r.meta, "url")).some((u) => urlKey(u) === key)) ?? null;
}

// ── Netscape bookmark files ────────────────────────────────────────────────

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The bookmarks as a Netscape bookmark file, the format every browser imports:
 * one flat list, each with its tags in TAGS (as Firefox and Pinboard write
 * them), its `added` day in ADD_DATE and its description in a DD. Bookmarks
 * without a web address are left out.
 */
export function toNetscapeBookmarks(list: Bookmark[], title = "Bookmarks"): string {
  const lines = [
    "<!DOCTYPE NETSCAPE-Bookmark-file-1>",
    "<!-- This is an automatically generated file.",
    "     It will be read and overwritten.",
    "     DO NOT EDIT! -->",
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    `<TITLE>${escapeHtml(title)}</TITLE>`,
    `<H1>${escapeHtml(title)}</H1>`,
    "<DL><p>",
  ];
  for (const b of list) {
    if (!b.url || !webUrl(b.url)) continue;
    const added = b.added ? Date.parse(`${b.added}T00:00:00Z`) / 1000 : NaN;
    const attrs = [`HREF="${escapeHtml(b.url)}"`, ...(Number.isFinite(added) ? [`ADD_DATE="${added}"`] : []), ...(b.tags.length ? [`TAGS="${escapeHtml(b.tags.join(","))}"`] : [])];
    lines.push(`    <DT><A ${attrs.join(" ")}>${escapeHtml(b.title)}</A>`);
    if (b.description) lines.push(`    <DD>${escapeHtml(b.description.replace(/\s+/g, " "))}`);
  }
  lines.push("</DL><p>", "");
  return lines.join("\n");
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/**
 * HTML text as it reads: tags dropped, entities decoded, spaces collapsed.
 * Any < or > left over from a broken tag (`<<b>b>`) goes too, so no tag
 * survives as written; one written as `&lt;b&gt;` is text, and stays.
 */
export function htmlText(s: string): string {
  return s
    .replace(/<[^<>]*>/g, "")
    .replace(/[<>]/g, "")
    .replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,6});/gi, (m, e: string) => {
      const lower = e.toLowerCase();
      if (lower.startsWith("#")) {
        const n = lower.startsWith("#x") ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
        return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : m;
      }
      return ENTITIES[lower] ?? m;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/** The attributes of a start tag's inside (`HREF="…" ADD_DATE="…"`), names lower-cased. */
function attributes(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const attr = /([a-z_:][a-z0-9_:.-]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/giy;
  let at = 0;
  while (at < s.length) {
    while (at < s.length && /\s/.test(s[at])) at++;
    if (at >= s.length) break;
    attr.lastIndex = at;
    const m = attr.exec(s);
    if (!m) {
      at++;
      continue;
    }
    out[m[1].toLowerCase()] = htmlText(m[2] ?? m[3] ?? m[4] ?? "");
    at = attr.lastIndex;
  }
  return out;
}

/** One bookmark read from a file, before it is a record. */
export interface ImportedBookmark {
  /** Its place in the file, from 1. */
  item: number;
  title: string;
  url: string;
  tags: string[];
  description: string | null;
  added: string | null;
}

/** Folders browsers make for themselves, which say nothing about what's in them. */
const BROWSER_FOLDERS = new Set(["bookmarks", "bookmarks bar", "bookmarks toolbar", "bookmarks menu", "favorites bar", "favourites bar", "other bookmarks", "mobile bookmarks", "unsorted bookmarks"]);

/**
 * The bookmarks in a Netscape bookmark file. A bookmark's folders become tags
 * (Work › Reading is `work` and `reading`), beside any it has in TAGS; the
 * folders a browser makes for itself (Bookmarks bar, Other bookmarks) don't.
 * Links that aren't web addresses (javascript:, place:) are problems.
 */
export function parseNetscapeBookmarks(html: string): { bookmarks: ImportedBookmark[]; problems: { item: number; message: string }[] } {
  const bookmarks: ImportedBookmark[] = [];
  const problems: { item: number; message: string }[] = [];
  const folders: (string | null)[] = [];
  let pendingFolder: string | null = null;
  let last: ImportedBookmark | null = null;
  let item = 0;
  // Each match is one tag the format is made of; text between them is read only after an A, an H3 or a DD.
  const tag = /<(\/?)(dl|dt|dd|h3|a)\b([^<>]*)>/gi;
  // Where the text after an A, an H3 or a DD ends. Each search starts where the
  // last tag ended, and one that finds nothing never runs again, so the file is
  // read a bounded number of times however it is written.
  const ends: Record<string, { re: RegExp; none: boolean }> = {
    a: { re: /<\/a\s*>/gi, none: false },
    h3: { re: /<\/h3\s*>/gi, none: false },
    dd: { re: /<\/?(?:dl|dt|dd|h3)\b/gi, none: false },
  };
  const until = (kind: string, from: number): { text: string; next: number } => {
    const e = ends[kind];
    if (!e.none) {
      e.re.lastIndex = from;
      const found = e.re.exec(html);
      if (found) return { text: html.slice(from, found.index), next: kind === "dd" ? found.index : e.re.lastIndex };
      e.none = true;
    }
    return { text: html.slice(from), next: html.length };
  };
  let m: RegExpExecArray | null;
  while ((m = tag.exec(html))) {
    const closing = m[1] === "/";
    const name = m[2].toLowerCase();
    if (name === "dl") {
      if (closing) folders.pop();
      else {
        folders.push(pendingFolder);
        pendingFolder = null;
      }
      last = null;
      continue;
    }
    if (closing || name === "dt") continue;
    if (name === "h3") {
      const { text: raw, next } = until("h3", tag.lastIndex);
      const text = htmlText(raw);
      const attrs = attributes(m[3]);
      const own = "personal_toolbar_folder" in attrs || "unfiled_bookmarks_folder" in attrs || BROWSER_FOLDERS.has(text.toLowerCase());
      pendingFolder = own ? null : text;
      tag.lastIndex = next;
      last = null;
      continue;
    }
    if (name === "dd") {
      // A DD's text runs to the next tag of the format.
      const { text: raw, next } = until("dd", tag.lastIndex);
      const text = htmlText(raw);
      if (last && text) last.description = text;
      tag.lastIndex = next;
      continue;
    }
    // An A: a bookmark.
    item++;
    const { text: raw, next } = until("a", tag.lastIndex);
    const label = htmlText(raw);
    tag.lastIndex = next;
    const attrs = attributes(m[3]);
    const href = (attrs.href ?? "").trim();
    last = null;
    if (!webUrl(href)) {
      problems.push({ item, message: href ? `${label || href} isn't a web page (${href.slice(0, 40)}), so it was left out.` : `${label || "A link"} has no address, so it was left out.` });
      continue;
    }
    const seconds = Number(attrs.add_date);
    const added = Number.isFinite(seconds) && seconds > 0 ? new Date((seconds > 1e11 ? seconds / 1000 : seconds) * 1000).toISOString().slice(0, 10) : null;
    const tags = [...new Set([...folders, ...(attrs.tags ?? "").split(",")].filter((t): t is string => !!t).map(normalizeTag).filter(Boolean))];
    last = { item, title: label || titleFromUrl(href), url: href, tags, description: null, added };
    bookmarks.push(last);
  }
  return { bookmarks, problems };
}

export interface BookmarkPlan {
  create: ImportedBookmark[];
  /** Already in the collection, or earlier in the same file. */
  skip: ImportedBookmark[];
  problems: { item: number; message: string }[];
}

/** What importing a bookmark file into a collection would do: each page once, whatever the collection already holds. */
export function planBookmarkImport(html: string, existing: Entry[]): BookmarkPlan {
  const { bookmarks: found, problems } = parseNetscapeBookmarks(html);
  const taken = new Set(existing.flatMap((e) => values(metaValue(e.meta, "url")).map(urlKey).filter((k): k is string => !!k)));
  const plan: BookmarkPlan = { create: [], skip: [], problems };
  for (const b of found) {
    const key = urlKey(b.url)!;
    if (taken.has(key)) plan.skip.push(b);
    else {
      taken.add(key);
      plan.create.push(b);
    }
  }
  return plan;
}

/** The fields a new bookmark record is written with, in BOOKMARK_FIELDS order, leaving out what it hasn't got. */
export function bookmarkFields(b: { url: string; tags?: string[]; description?: string | null; added?: string | null }): [string, unknown][] {
  const out: [string, unknown][] = [["url", b.url.trim()]];
  const tags = [...new Set((b.tags ?? []).map(normalizeTag).filter(Boolean))];
  if (tags.length) out.push(["tags", tags]);
  if (b.description?.trim()) out.push(["description", b.description.trim()]);
  if (b.added) out.push(["added", b.added]);
  return out;
}
