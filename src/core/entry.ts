import { parse, stringify } from "yaml";

export const FORMAT_VERSION = 1;
export const DEFAULT_TYPE = "log";

export interface Attachment {
  hash: string;
  name: string;
  type: string;
  size?: number;
}

export interface Amount {
  value: number;
  currency: string;
}

/** Where an event came from. `adapter` + `id` is unique, which makes ingestion idempotent. */
export interface Source {
  adapter: string;
  id: string;
  url?: string;
}

/** A GitRoll event: something that happened. Stored as Markdown with YAML front matter. */
export interface Entry {
  version: number;
  id: string;
  /** Event type, e.g. log, payment, maintenance. Unknown types still render as a general log. */
  type: string;
  /** When the entry was recorded. */
  created: string;
  /** When the event happened. Defaults to `created`. */
  occurred: string;
  author: string;
  projects: string[];
  tags: string[];
  attachments: Attachment[];
  amount?: Amount;
  /** Type-specific structured fields. */
  data: Record<string, unknown>;
  source?: Source;
  /** Front matter keys this version doesn't know about, preserved on rewrite. */
  extra: Record<string, unknown>;
  body: string;
}

export class FormatError extends Error {}

const KNOWN = new Set(["version", "id", "type", "created", "occurred", "author", "projects", "tags", "attachments", "amount", "data", "source"]);
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/;
const HASHTAG = /(?:^|[^\p{L}\p{N}_&/#])#(\p{L}[\p{L}\p{N}_-]*)/gu;
export const TYPE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function normalizeTag(tag: string): string {
  return tag
    .trim()
    .replace(/^#+/, "")
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}_-]/gu, "");
}

export function extractHashtags(text: string): string[] {
  return [...text.matchAll(HASHTAG)].map((m) => m[1]);
}

export function parseEntry(source: string): Entry {
  const m = FRONT_MATTER.exec(source.replace(/^﻿/, ""));
  if (!m) throw new FormatError("missing YAML front matter");
  let data: unknown;
  try {
    data = parse(m[1]);
  } catch (e) {
    throw new FormatError(`invalid YAML: ${(e as Error).message}`);
  }
  if (!isMapping(data)) throw new FormatError("front matter must be a mapping");
  const d = data;

  const id = scalar(d.id);
  if (!id) throw new FormatError("missing required field: id");
  const type = scalar(d.type).trim().toLowerCase() || DEFAULT_TYPE;
  if (!TYPE_ID.test(type)) throw new FormatError(`invalid type: ${type}`);
  const created = timestamp(d.created, "created");
  const occurred = d.occurred == null ? created : timestamp(d.occurred, "occurred");
  if (d.data != null && !isMapping(d.data)) throw new FormatError("data must be a mapping");

  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) if (!KNOWN.has(k)) extra[k] = v;

  const entry: Entry = {
    version: Number(d.version ?? FORMAT_VERSION),
    id,
    type,
    created,
    occurred,
    author: scalar(d.author),
    projects: list(d.projects),
    tags: list(d.tags).map(normalizeTag).filter(Boolean),
    attachments: attachments(d.attachments),
    data: isMapping(d.data) ? { ...d.data } : {},
    extra,
    body: m[2].replace(/^\s*\n/, "").trimEnd(),
  };
  const amt = amount(d.amount);
  if (amt) entry.amount = amt;
  const src = source_(d.source);
  if (src) entry.source = src;
  return entry;
}

export function serializeEntry(e: Entry): string {
  const fm: Record<string, unknown> = {
    version: e.version || FORMAT_VERSION,
    id: e.id,
    type: e.type || DEFAULT_TYPE,
    created: e.created,
    occurred: e.occurred,
    author: e.author,
    projects: e.projects,
    tags: e.tags,
  };
  if (e.attachments.length) fm.attachments = e.attachments.map((a) => ({ ...a }));
  if (e.amount) fm.amount = { value: e.amount.value, currency: e.amount.currency };
  if (Object.keys(e.data).length) fm.data = e.data;
  if (e.source) fm.source = { ...e.source };
  for (const [k, v] of Object.entries(e.extra)) if (!KNOWN.has(k)) fm[k] = v;
  const body = e.body.trim();
  return `---\n${stringify(fm, { lineWidth: 0 })}---\n${body ? `\n${body}\n` : ""}`;
}

export function isMapping(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date);
}

function scalar(v: unknown): string {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString();
  return typeof v === "object" ? "" : String(v);
}

function timestamp(v: unknown, field: string): string {
  const s = scalar(v);
  if (!s) throw new FormatError(`missing required field: ${field}`);
  if (Number.isNaN(Date.parse(s))) throw new FormatError(`invalid ${field} timestamp: ${s}`);
  return s;
}

function list(v: unknown): string[] {
  if (v == null) return [];
  return (Array.isArray(v) ? v : [v])
    .map(scalar)
    .map((s) => s.trim())
    .filter(Boolean);
}

function attachments(v: unknown): Attachment[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((a): Attachment[] => {
    if (!isMapping(a)) return [];
    const hash = scalar(a.hash);
    if (!hash) return [];
    const out: Attachment = { hash, name: scalar(a.name) || hash, type: scalar(a.type) || "application/octet-stream" };
    if (typeof a.size === "number") out.size = a.size;
    return [out];
  });
}

function amount(v: unknown): Amount | undefined {
  if (v == null) return undefined;
  if (typeof v === "number") return { value: v, currency: "USD" };
  if (isMapping(v)) {
    const value = Number(v.value);
    if (v.value != null && Number.isFinite(value)) return { value, currency: scalar(v.currency).toUpperCase() || "USD" };
  }
  return undefined;
}

function source_(v: unknown): Source | undefined {
  if (!isMapping(v)) return undefined;
  const adapter = scalar(v.adapter);
  const id = scalar(v.id);
  if (!adapter || !id) return undefined;
  const out: Source = { adapter, id };
  const url = scalar(v.url);
  if (url) out.url = url;
  return out;
}
