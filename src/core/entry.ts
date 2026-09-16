// A GitRoll event is an ordinary Markdown file under events/.
//
//   events/2026-09-15-ac-serviced.md
//
// Front matter is optional. A file with nothing but a heading and a paragraph
// is a valid event: the date comes from the file name, the title from the first
// heading, and attachments from ordinary Markdown links. Anything a person
// writes by hand is kept exactly as written; GitRoll never rewrites a file it
// was not asked to change.

import { parseDocument } from "yaml";
import type { Document } from "yaml";
import { isRealTimestamp, slugify } from "./util.ts";

export interface Amount {
  value: number;
  currency: string;
}

/** A file linked from an event, e.g. [Receipt](../files/ac-receipt.pdf). */
export interface Attachment {
  /** Repository-relative path, e.g. files/ac-receipt.pdf */
  path: string;
  /** What the link says, or the file name. */
  name: string;
  /** Guessed from the extension. */
  type: string;
  /** Written with image syntax (![...]). */
  image: boolean;
}

/** Where an event came from, for imports. Optional, and only ever written by an importer. */
export interface Source {
  adapter: string;
  id: string;
  url?: string;
}

/** One event: a Markdown file, read. */
export interface Entry {
  /** The event's identity: its repository-relative path, e.g. events/2026-09-15-ac-serviced.md */
  id: string;
  path: string;
  /** First heading, else the first line of text, else the file name. */
  title: string;
  /** ISO date (or date-time) the event happened; null when nothing supplies one. */
  date: string | null;
  /** Where the date came from. */
  dateFrom: "metadata" | "filename" | "none";
  projects: string[];
  tags: string[];
  amount?: Amount;
  attachments: Attachment[];
  /** Other events this one links to, as repository-relative paths. */
  links: string[];
  source?: Source;
  /** The front matter exactly as parsed. Unknown keys are kept and never dropped. */
  meta: Record<string, unknown>;
  /** Everything after the front matter, verbatim. */
  body: string;
}

export class FormatError extends Error {}

const FRONT_MATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/;
const HASHTAG = /(?:^|[^\p{L}\p{N}_&/#])#(\p{L}[\p{L}\p{N}_-]*)/gu;
const DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})(?:[-_. ]|$)/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?$/;

export function normalizeTag(tag: string): string {
  return tag
    .trim()
    .replace(/^#+/, "")
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}_-]/gu, "");
}

export function extractHashtags(text: string): string[] {
  return [...stripCode(text).matchAll(HASHTAG)].map((m) => m[1]);
}

/** Fenced code, inline code and HTML comments aren't prose, so #include and #4 aren't tags. */
function stripCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, "\n").replace(/`[^`\n]*`/g, " ").replace(/<!--[\s\S]*?-->/g, " ");
}

export const baseName = (p: string): string => p.split("/").pop() ?? "";

/** The date a file name carries, e.g. events/2026-09-15-ac-serviced.md → 2026-09-15 */
export function dateFromFilename(path: string): string | null {
  const m = DATE_PREFIX.exec(baseName(path));
  return m && isRealTimestamp(m[1]) ? m[1] : null;
}

/** Splits a file into its front matter text and body. Both may be empty. */
export function splitFrontMatter(source: string): { frontMatter: string | null; body: string } {
  const text = source.replace(/^﻿/, "");
  const m = FRONT_MATTER.exec(text);
  if (!m) return { frontMatter: null, body: text };
  return { frontMatter: m[1], body: m[2] };
}

function metaFrom(frontMatter: string | null): Record<string, unknown> {
  if (frontMatter === null || !frontMatter.trim()) return {};
  const doc = parseDocument(frontMatter);
  if (doc.errors.length) throw new FormatError(`invalid YAML front matter: ${doc.errors[0].message}`);
  const data = doc.toJS({ maxAliasCount: 100 }) as unknown;
  if (data == null) return {};
  if (typeof data !== "object" || Array.isArray(data)) throw new FormatError("front matter must be a mapping, e.g. date: 2026-09-15");
  return data as Record<string, unknown>;
}

const scalar = (v: unknown): string => {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return typeof v === "object" ? "" : String(v);
};

const list = (v: unknown): string[] =>
  (v == null ? [] : Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [v]).map(scalar).map((s) => s.trim()).filter(Boolean);

/**
 * Accepts a date (2026-09-15) or a full ISO timestamp. A bare date stays a bare
 * date, so it means that day in every time zone.
 */
export function normalizeDate(input: string): string | null {
  const s = input.trim();
  if (ISO_DATE.test(s)) return isRealTimestamp(s) ? s : null;
  if (ISO_DATE_TIME.test(s) && isRealTimestamp(s)) return s;
  return null;
}

export function amountFromMeta(meta: Record<string, unknown>): Amount | undefined {
  const raw = meta.amount;
  if (raw == null || raw === "") return undefined;
  const currency = (scalar(meta.currency) || "USD").toUpperCase().slice(0, 3);
  if (typeof raw === "number") return Number.isFinite(raw) ? { value: raw, currency } : undefined;
  if (typeof raw === "string") {
    const value = Number(raw.replace(/[$€£¥,\s]/g, ""));
    return Number.isFinite(value) ? { value, currency } : undefined;
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const v = raw as Record<string, unknown>;
    const value = Number(v.value);
    if (Number.isFinite(value)) return { value, currency: (scalar(v.currency) || currency).toUpperCase().slice(0, 3) };
  }
  return undefined;
}

function sourceFrom(v: unknown): Source | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const d = v as Record<string, unknown>;
  const adapter = scalar(d.adapter);
  const id = scalar(d.id);
  if (!adapter || !id) return undefined;
  const url = scalar(d.url);
  return url ? { adapter, id, url } : { adapter, id };
}

/** The title shown in lists: the first heading, the first line of prose, or the file name. */
export function titleOf(body: string, path: string): string {
  for (const line of body.split("\n")) {
    const text = line.trim();
    if (!text) continue;
    const heading = /^#{1,6}\s+(.*\S)/.exec(text);
    if (heading) return heading[1].trim();
    if (/^(---|```)/.test(text)) continue;
    return text.replace(/^[>*-]\s*/, "").slice(0, 200);
  }
  return baseName(path).replace(/\.md$/i, "").replace(DATE_PREFIX, "").replace(/[-_]+/g, " ").trim() || baseName(path);
}

/** Reads one event file. `path` is repository-relative and supplies the fallback date. */
export function parseEntry(path: string, source: string): Entry {
  const { frontMatter, body: rawBody } = splitFrontMatter(source);
  const meta = metaFrom(frontMatter);
  const body = rawBody.replace(/^\s*\n/, "").trimEnd();

  const fromMeta = meta.date == null ? null : normalizeDate(scalar(meta.date));
  if (meta.date != null && !fromMeta) throw new FormatError(`invalid date: ${scalar(meta.date)} (use 2026-09-15 or 2026-09-15T14:30:00-07:00)`);
  const fromName = dateFromFilename(path);
  const date = fromMeta ?? fromName;

  const entry: Entry = {
    id: path,
    path,
    title: scalar(meta.title).trim() || titleOf(body, path),
    date,
    dateFrom: fromMeta ? "metadata" : fromName ? "filename" : "none",
    projects: unique(list(meta.projects ?? meta.project).map((p) => slugify(p)).filter(Boolean)),
    tags: unique([...list(meta.tags ?? meta.tag), ...extractHashtags(body)].map(normalizeTag).filter(Boolean)),
    attachments: linkedFiles(path, body),
    links: linkedEvents(path, body),
    meta,
    body,
  };
  const amount = amountFromMeta(meta);
  if (amount) entry.amount = amount;
  const source_ = sourceFrom(meta.source);
  if (source_) entry.source = source_;
  return entry;
}

const unique = <T>(xs: T[]): T[] => [...new Set(xs)];

// ── Links and attachments ──────────────────────────────────────────────────

const LINK = /(!)?\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;

/** The directory part of a repository-relative path ("" at the root). */
export const dirName = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

/**
 * Resolves a Markdown link against the file it appears in. Returns a
 * repository-relative path, or null when the target is not a file inside the
 * repository (a URL, an absolute path, or a path that climbs out of the root).
 */
export function resolveLink(fromPath: string, target: string): string | null {
  const raw = target.trim().split("#")[0].split("?")[0];
  if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//") || raw.startsWith("/") || raw.includes("\\")) return null;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // keep the raw text: a stray % is not an escape
  }
  if (decoded.includes("\0")) return null;
  const parts = dirName(fromPath).split("/").filter(Boolean);
  for (const part of decoded.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null; // climbs out of the repository
      parts.pop();
    } else parts.push(part);
  }
  return parts.length ? parts.join("/") : null;
}

const EXT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
};

export function typeForPath(p: string): string {
  const ext = /\.([A-Za-z0-9]+)$/.exec(p)?.[1].toLowerCase() ?? "";
  return EXT_TYPES[ext] ?? "application/octet-stream";
}

/** Every file in the repository that this event links to, in the order they appear. */
export function linkedFiles(path: string, body: string): Attachment[] {
  const out: Attachment[] = [];
  const seen = new Set<string>();
  for (const m of stripCode(body).matchAll(LINK)) {
    const target = resolveLink(path, m[3]);
    if (!target || target.toLowerCase().endsWith(".md")) continue;
    const key = `${m[1] ? "!" : ""}${target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path: target, name: m[2].trim() || baseName(target), type: typeForPath(target), image: !!m[1] });
  }
  return out;
}

/** Other Markdown files this event links to: the events it is about, or that explain it. */
export function linkedEvents(path: string, body: string): string[] {
  const out: string[] = [];
  for (const m of stripCode(body).matchAll(LINK)) {
    const target = resolveLink(path, m[3]);
    if (target && target !== path && target.toLowerCase().endsWith(".md") && !out.includes(target)) out.push(target);
  }
  return out;
}

/** Rewrites relative links so they still point at the same files after a move. */
export function relinkBody(body: string, fromPath: string, toPath: string): string {
  if (dirName(fromPath) === dirName(toPath)) return body;
  return body.replace(LINK, (whole, bang: string | undefined, text: string, target: string) => {
    const resolved = resolveLink(fromPath, target);
    if (!resolved) return whole;
    return `${bang ?? ""}[${text}](${relativeLink(toPath, resolved)})`;
  });
}

/** A relative link from one repository file to another, e.g. events/x.md → files/a.pdf gives ../files/a.pdf */
export function relativeLink(fromPath: string, toPath: string): string {
  const from = dirName(fromPath).split("/").filter(Boolean);
  const to = toPath.split("/").filter(Boolean);
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
  const up = from.slice(i).map(() => "..");
  const rest = to.slice(i);
  const link = [...up, ...rest].join("/") || baseName(toPath);
  return encodeURI(up.length ? link : `./${link}`).replace(/\(/g, "%28").replace(/\)/g, "%29");
}

// ── Writing ────────────────────────────────────────────────────────────────

/** Metadata a program may set. Anything else a person wrote is left untouched. */
/** Any plain mapping written to `source:`, such as a code reference. */
export type SourceLike = { [key: string]: unknown };

export interface MetaChanges {
  /** null removes the key. */
  date?: string | null;
  projects?: string[] | null;
  tags?: string[] | null;
  amount?: Amount | null;
  title?: string | null;
  source?: Source | SourceLike | null;
}

const EMPTY: MetaChanges = {};

function applyMeta(doc: Document, changes: MetaChanges): void {
  const set = (key: string, value: unknown) => {
    if (value === null || value === undefined || (Array.isArray(value) && !value.length)) doc.delete(key);
    else doc.set(key, value);
  };
  if (changes.title !== undefined) set("title", changes.title);
  if (changes.date !== undefined) set("date", changes.date);
  if (changes.projects !== undefined) set("projects", changes.projects);
  if (changes.tags !== undefined) set("tags", changes.tags);
  if (changes.amount !== undefined) {
    set("amount", changes.amount === null ? null : changes.amount.value);
    set("currency", changes.amount === null ? null : changes.amount.currency);
  }
  if (changes.source !== undefined) set("source", changes.source);
}

const hasMeta = (c: MetaChanges) => Object.values(c).some((v) => v !== undefined && v !== null && !(Array.isArray(v) && !v.length));

/**
 * Rewrites an event file. Only what changed is touched: the body is left byte
 * for byte when `body` is undefined, and front matter keys GitRoll doesn't know
 * about (and any comments) survive, because the YAML document is edited in
 * place rather than regenerated.
 */
export function updateEntrySource(source: string, changes: MetaChanges = EMPTY, body?: string): string {
  const parts = splitFrontMatter(source);
  const nextBody = `${(body === undefined ? parts.body : body).trim()}\n`;
  const yaml = editFrontMatter(parts.frontMatter, changes);
  return yaml ? `---\n${yaml}\n---\n\n${nextBody}` : nextBody;
}

/** Edits the YAML document in place, so comments, key order and style survive. Returns "" when nothing is left. */
function editFrontMatter(frontMatter: string | null, changes: MetaChanges): string {
  const doc = parseDocument(frontMatter ?? "");
  if (doc.errors.length) throw new FormatError(`invalid YAML front matter: ${doc.errors[0].message}`);
  if (doc.contents == null || (doc.contents as { items?: unknown[] }).items === undefined) {
    (doc as { contents: unknown }).contents = doc.createNode({});
  }
  applyMeta(doc, changes);
  const text = doc.toString({ lineWidth: 0 }).trim();
  return text === "{}" ? "" : text;
}

/** A brand new event file: front matter only when there is metadata worth writing. */
export function newEntrySource(body: string, changes: MetaChanges = EMPTY): string {
  const text = `${body.trim()}\n`;
  if (!hasMeta(changes)) return text;
  const yaml = editFrontMatter(null, changes);
  return yaml ? `---\n${yaml}\n---\n\n${text}` : text;
}

/** A readable file name for an event: 2026-09-15-ac-serviced.md */
export function entryFilename(date: string | null, title: string): string {
  const slug = slugify(title).slice(0, 60).replace(/-+$/, "") || "event";
  const day = date ? date.slice(0, 10) : "";
  return `${day ? `${day}-` : ""}${slug}.md`;
}
