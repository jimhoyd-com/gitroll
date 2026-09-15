// FIND IT. A disposable, in-memory index over parsed events. It is rebuilt from
// the repository whenever the repository changes and is never persisted.
//
// Plain words match anywhere. Optional filters (OR within a filter, AND across):
//   project:house  tag:payment  #payment  type:expense  author:jimmy  person:jimmy
//   after:2026-01-01  before:2026-06-30  on:2026-09  amount:>500  has:receipt|photo|attachment|amount
//   <field>:<value> matches structured data, e.g. vendor:carlos

import type { Entry } from "./entry.ts";
import { normalizeTag } from "./entry.ts";
import { slugify } from "./util.ts";

export interface Token {
  key?: string;
  value: string;
}

export interface AmountFilter {
  op: ">" | ">=" | "<" | "<=" | "=";
  value: number;
}

export interface Query {
  terms: string[];
  projects: string[];
  tags: string[];
  types: string[];
  authors: string[];
  after?: number;
  before?: number;
  amounts: AmountFilter[];
  has: string[];
  fields: { key: string; value: string }[];
}

const ALIASES: Record<string, string> = {
  p: "project",
  project: "project",
  projects: "project",
  t: "tag",
  tag: "tag",
  tags: "tag",
  type: "type",
  author: "author",
  by: "author",
  person: "author",
  who: "author",
  after: "after",
  from: "after",
  since: "after",
  before: "before",
  to: "before",
  until: "before",
  on: "on",
  date: "on",
  amount: "amount",
  has: "has",
};

export const canonicalKey = (key: string) => ALIASES[key.toLowerCase()] ?? key.toLowerCase();

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  for (const m of input.matchAll(/(?:([A-Za-z_][\w-]*):)?(?:"([^"]*)"|(\S+))/g)) {
    const rawKey = m[1];
    const value = (m[2] ?? m[3] ?? "").trim();
    if (rawKey && value.startsWith("//")) {
      tokens.push({ value: `${rawKey}:${value}` }); // a URL, not a filter
      continue;
    }
    if (!value) continue;
    if (!rawKey && /^#[\p{L}\p{N}]/u.test(value)) tokens.push({ key: "tag", value: value.slice(1) });
    else tokens.push(rawKey ? { key: canonicalKey(rawKey), value } : { value });
  }
  return tokens;
}

export function serialize(tokens: Token[]): string {
  return tokens
    .map((t) => {
      const v = /[\s"]/.test(t.value) ? `"${t.value.replace(/"/g, "")}"` : t.value;
      return t.key ? `${t.key}:${v}` : v;
    })
    .join(" ");
}

export function parseQuery(input: string): Query {
  const q: Query = { terms: [], projects: [], tags: [], types: [], authors: [], amounts: [], has: [], fields: [] };
  for (const { key, value } of tokenize(input)) {
    switch (key) {
      case undefined:
        q.terms.push(value.toLowerCase());
        break;
      case "project":
        q.projects.push(slugify(value));
        break;
      case "tag":
        q.tags.push(normalizeTag(value));
        break;
      case "type":
        q.types.push(value.toLowerCase());
        break;
      case "author":
        q.authors.push(value.toLowerCase());
        break;
      case "after":
        q.after = dayStart(value) ?? q.after;
        break;
      case "before":
        q.before = dayEnd(value) ?? q.before;
        break;
      case "on":
        q.after = dayStart(value) ?? q.after;
        q.before = dayEnd(value) ?? q.before;
        break;
      case "amount": {
        const m = /^(>=|<=|>|<|=)?\s*[$€£¥]?([\d,]*\.?\d+)$/.exec(value);
        if (m) q.amounts.push({ op: (m[1] ?? "=") as AmountFilter["op"], value: Number(m[2].replace(/,/g, "")) });
        break;
      }
      case "has":
        q.has.push(value.toLowerCase());
        break;
      default:
        q.fields.push({ key, value: value.toLowerCase() });
    }
  }
  return q;
}

export interface IndexContext {
  projectNames?: Map<string, string>;
  typeLabels?: Map<string, string>;
}

const flat = (v: unknown): string => (v !== null && typeof v === "object" ? JSON.stringify(v) : String(v));
const RECEIPT_TYPES = new Set(["expense", "purchase", "payment"]);

export class SearchIndex<T extends Entry> {
  readonly entries: T[];
  #ctx: IndexContext;
  #text = new WeakMap<T, string>();

  constructor(entries: T[], ctx: IndexContext = {}) {
    this.entries = entries;
    this.#ctx = ctx;
  }

  search(query: string): T[] {
    if (!query.trim()) return this.entries;
    const q = parseQuery(query);
    return this.entries.filter((e) => this.matches(e, q));
  }

  matches(e: T, q: Query): boolean {
    if (q.projects.length && !q.projects.some((p) => e.projects.includes(p))) return false;
    if (q.tags.length && !q.tags.some((t) => e.tags.includes(t))) return false;
    if (q.types.length && !q.types.includes(e.type)) return false;
    if (q.authors.length && !q.authors.some((a) => e.author.toLowerCase().includes(a))) return false;
    const t = Date.parse(e.occurred);
    if (q.after !== undefined && t < q.after) return false;
    if (q.before !== undefined && t > q.before) return false;
    if (q.amounts.length && !(e.amount && q.amounts.every((f) => compare(e.amount!.value, f)))) return false;
    if (!q.has.every((h) => has(e, h))) return false;
    for (const f of q.fields) {
      const v = e.data[f.key];
      if (v == null || !flat(v).toLowerCase().includes(f.value)) return false;
    }
    if (!q.terms.length) return true;
    const text = this.#haystack(e);
    return q.terms.every((term) => text.includes(term));
  }

  #haystack(e: T): string {
    let text = this.#text.get(e);
    if (text === undefined) {
      text = [
        e.body,
        e.author,
        e.type,
        this.#ctx.typeLabels?.get(e.type) ?? "",
        ...e.tags,
        ...e.projects.flatMap((p) => [p, this.#ctx.projectNames?.get(p) ?? ""]),
        ...e.attachments.map((a) => a.name),
        e.amount ? `${e.amount.value} ${e.amount.currency}` : "",
        ...Object.values(e.data).map(flat),
        e.source?.adapter ?? "",
      ]
        .join("\n")
        .toLowerCase();
      this.#text.set(e, text);
    }
    return text;
  }
}

export function searchEntries<T extends Entry>(entries: T[], query: string, projectNames?: Map<string, string>): T[] {
  return new SearchIndex(entries, { projectNames }).search(query);
}

export interface Facets {
  projects: [string, number][];
  tags: [string, number][];
  types: [string, number][];
  authors: [string, number][];
}

export function facets(entries: Entry[]): Facets {
  const count = (values: string[][]) => {
    const m = new Map<string, number>();
    for (const vs of values) for (const v of vs) if (v) m.set(v, (m.get(v) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  };
  return {
    projects: count(entries.map((e) => e.projects)),
    tags: count(entries.map((e) => e.tags)),
    types: count(entries.map((e) => [e.type])),
    authors: count(entries.map((e) => [e.author])),
  };
}

function compare(v: number, f: AmountFilter): boolean {
  switch (f.op) {
    case ">":
      return v > f.value;
    case ">=":
      return v >= f.value;
    case "<":
      return v < f.value;
    case "<=":
      return v <= f.value;
    default:
      return v === f.value;
  }
}

function has(e: Entry, what: string): boolean {
  const atts = e.attachments;
  switch (what) {
    case "attachment":
    case "attachments":
    case "file":
    case "files":
      return atts.length > 0;
    case "photo":
    case "photos":
    case "image":
    case "images":
      return atts.some((a) => a.type.startsWith("image/"));
    case "receipt":
    case "receipts":
      return atts.some((a) => a.type === "application/pdf" || /receipt/i.test(a.name)) || (atts.length > 0 && RECEIPT_TYPES.has(e.type));
    case "pdf":
    case "document":
      return atts.some((a) => a.type === "application/pdf");
    case "amount":
    case "money":
      return !!e.amount;
    default: {
      const v = e.data[what];
      return v != null && v !== "" && v !== false;
    }
  }
}

function parseDay(s: string): [number, number, number | null] | null {
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(s);
  if (!m) return null;
  return [Number(m[1]), m[2] ? Number(m[2]) - 1 : 0, m[3] ? Number(m[3]) : null];
}

function dayStart(s: string): number | undefined {
  const p = parseDay(s);
  return p ? new Date(p[0], p[1], p[2] ?? 1).getTime() : undefined;
}

function dayEnd(s: string): number | undefined {
  const p = parseDay(s);
  if (!p) return undefined;
  const yearOnly = /^\d{4}$/.test(s);
  const next = yearOnly ? new Date(p[0] + 1, 0, 1) : p[2] === null ? new Date(p[0], p[1] + 1, 1) : new Date(p[0], p[1], p[2] + 1);
  return next.getTime() - 1;
}
