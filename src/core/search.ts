// FIND IT. A disposable, in-memory index over parsed events. It is rebuilt from
// the repository whenever the repository changes and is never persisted.
//
// Plain words match anywhere. Optional filters (OR within a filter, AND across):
//   topic:house  project:house  tag:payment  #payment
//   after:2026-01-01  before:2026-06-30  on:2026-09  amount:>500  has:receipt|photo|file|amount|date|todo|done
//   is:note  is:event  is:file (a file's sidecar record, files/<name>.md)
//   <key>:<value> matches any front matter field, e.g. vendor:carlos, rating:5
//   <key>>=<value>, <key><<value> (also >, <=) compare one, e.g. rating>=4, expires<2026-11-01
//   has:<key> is any field that has something in it
// Field types come from the YAML itself; see fields.ts.

import type { Entry } from "./entry.ts";
import { normalizeTag } from "./entry.ts";
import { todosIn } from "./todos.ts";
import { slugify } from "./util.ts";
import { compareValue, fieldValue, hasField, matchesValue } from "./fields.ts";
import { isSealedValue, withoutSealed } from "./sealed.ts";
import type { CompareOp } from "./fields.ts";

export interface Token {
  key?: string;
  value: string;
  /** A comparison (`rating>=4`); a plain `key:value` has none. */
  op?: CompareOp;
}

export interface AmountFilter {
  op: ">" | ">=" | "<" | "<=" | "=";
  value: number;
}

export interface Query {
  terms: string[];
  projects: string[];
  tags: string[];
  /** Inclusive day bounds as YYYY-MM-DD. */
  after?: string;
  before?: string;
  amounts: AmountFilter[];
  has: string[];
  /** `is:note`, `is:event` or `is:file`: which kind of record, by where it lives. */
  kinds: ("note" | "event" | "file")[];
  fields: { key: string; value: string }[];
  /** `rating>=4`, `expires<2026-11-01`, `rating:>=4`: a field compared with a value. */
  compares: { key: string; op: CompareOp; value: string }[];
}

const ALIASES: Record<string, string> = {
  p: "project",
  project: "project",
  projects: "project",
  // "Topic" is what the interface calls a project; the stored key stays `projects`.
  topic: "project",
  topics: "project",
  t: "tag",
  tag: "tag",
  tags: "tag",
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
  is: "is",
};

export const canonicalKey = (key: string) => ALIASES[key.toLowerCase()] ?? key.toLowerCase();

/** The field a comparison is about. `on` is the date it's an alias for; anything else is the field's own name. */
const fieldKey = (key: string): string => {
  const k = key.toLowerCase();
  return k === "on" ? "date" : k;
};

const KEY_START = /[A-Za-z_]/;
const KEY_CHAR = /[\w-]/;
const SPACE = /\s/;

/** Splits a query into tokens: an optional `key:` or `key>=` (also `>`, `<`, `<=`) and a
 * value that is either one quoted string or a run of non-space characters. Scanned by hand,
 * one pass, so no input can make it backtrack. */
function scan(input: string): { key?: string; sep?: string; value: string }[] {
  const out: { key?: string; sep?: string; value: string }[] = [];
  let noQuoteAfter = Infinity; // once a search for a closing quote fails, every later one would too
  const closing = (from: number) => {
    if (from >= noQuoteAfter) return -1;
    const at = input.indexOf('"', from);
    if (at < 0) noQuoteAfter = from;
    return at;
  };
  // A value at `at`: a quoted string if its quote closes, otherwise the run of non-space.
  const value = (at: number): [string, number] | null => {
    if (at >= input.length || SPACE.test(input[at])) return null;
    if (input[at] === '"') {
      const end = closing(at + 1);
      if (end >= 0) return [input.slice(at + 1, end), end + 1];
    }
    let end = at;
    while (end < input.length && !SPACE.test(input[end])) end++;
    return [input.slice(at, end), end];
  };
  let i = 0;
  while (i < input.length) {
    if (SPACE.test(input[i])) {
      i++;
      continue;
    }
    let j = i;
    let sep = "";
    if (KEY_START.test(input[j])) {
      j++;
      while (j < input.length && KEY_CHAR.test(input[j])) j++;
      if (input[j] === ":") sep = ":";
      else if (input[j] === "<" || input[j] === ">") sep = input[j + 1] === "=" ? `${input[j]}=` : input[j];
    }
    const keyed = sep ? value(j + sep.length) : null;
    if (keyed) {
      out.push({ key: input.slice(i, j), sep, value: keyed[0] });
      i = keyed[1];
    } else {
      const plain = value(i)!;
      out.push({ value: plain[0] });
      i = plain[1];
    }
  }
  return out;
}

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  for (const m of scan(input)) {
    const rawKey = m.key;
    const sep = m.sep;
    const value = m.value.trim();
    if (rawKey && sep === ":" && value.startsWith("//")) {
      tokens.push({ value: `${rawKey}:${value}` }); // a URL, not a filter
      continue;
    }
    if (!value) continue;
    if (!rawKey && /^#[\p{L}\p{N}]/u.test(value)) tokens.push({ key: "tag", value: value.slice(1) });
    else if (rawKey && sep !== ":") tokens.push({ key: fieldKey(rawKey), op: sep as CompareOp, value });
    else tokens.push(rawKey ? { key: canonicalKey(rawKey), value } : { value });
  }
  return tokens;
}

export function serialize(tokens: Token[]): string {
  return tokens
    .map((t) => {
      const v = /[\s"]/.test(t.value) ? `"${t.value.replace(/"/g, "")}"` : t.value;
      return t.key ? `${t.key}${t.op ?? ":"}${v}` : v;
    })
    .join(" ");
}

/** `>=4` as a value: a comparison written the way `amount:>500` always has been. */
const OP_VALUE = /^(>=|<=|>|<)(.+)$/;

export function parseQuery(input: string): Query {
  const q: Query = { terms: [], projects: [], tags: [], amounts: [], has: [], kinds: [], fields: [], compares: [] };
  for (const { key, value, op } of tokenize(input)) {
    if (op && key) {
      q.compares.push({ key, op, value });
      continue;
    }
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
      case "is": {
        const kind = value.toLowerCase().replace(/s$/, "");
        if (kind === "note" || kind === "event" || kind === "file") q.kinds.push(kind);
        else q.fields.push({ key, value: value.toLowerCase() });
        break;
      }
      default: {
        const m = OP_VALUE.exec(value);
        if (m) q.compares.push({ key, op: m[1] as CompareOp, value: m[2].trim() });
        else q.fields.push({ key, value: value.toLowerCase() });
      }
    }
  }
  return q;
}

export interface IndexContext {
  projectNames?: Map<string, string>;
}

const flat = (v: unknown): string => (v !== null && typeof v === "object" ? JSON.stringify(v) : String(v));

/**
 * The calendar day an event is on, as written: 2026-09-15. Date filters compare
 * days, not instants, so an event sits on the day its author put it on no matter
 * where the Roll is opened.
 */
export function dayOf(e: Entry): string | null {
  return e.date ? e.date.slice(0, 10) : null;
}

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
    if (q.kinds.length && !q.kinds.includes(kindOf(e))) return false;
    if (q.projects.length && !q.projects.some((p) => e.projects.includes(p))) return false;
    if (q.tags.length && !q.tags.some((t) => e.tags.includes(t))) return false;
    if (q.after !== undefined || q.before !== undefined) {
      const day = dayOf(e);
      if (day === null) return false;
      if (q.after !== undefined && day < q.after) return false;
      if (q.before !== undefined && day > q.before) return false;
    }
    if (q.amounts.length && !(e.amount && q.amounts.every((f) => compare(e.amount!.value, f)))) return false;
    if (!q.has.every((h) => has(e, h))) return false;
    for (const f of q.fields) if (!matchesValue(fieldValue(e, f.key), f.value)) return false;
    for (const c of q.compares) if (!compareValue(fieldValue(e, c.key), c.op, c.value)) return false;
    if (!q.terms.length) return true;
    const text = this.#haystack(e);
    return q.terms.every((term) => text.includes(term));
  }

  #haystack(e: T): string {
    let text = this.#text.get(e);
    if (text === undefined) {
      text = [
        e.title,
        // Sealed content is never indexed: not its ciphertext, and never its plaintext.
        withoutSealed(e.body),
        e.path,
        ...e.tags,
        ...e.projects.flatMap((p) => [p, this.#ctx.projectNames?.get(p) ?? ""]),
        ...e.attachments.map((a) => `${a.name} ${a.path}`),
        e.amount ? `${e.amount.value} ${e.amount.currency}` : "",
        ...Object.entries(e.meta).map(([k, v]) => (isSealedValue(v) ? k : `${k} ${flat(v)}`)),
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
      return atts.some((a) => a.type === "application/pdf" || /receipt|invoice/i.test(`${a.name} ${a.path}`));
    case "pdf":
    case "document":
      return atts.some((a) => a.type === "application/pdf");
    case "amount":
    case "money":
      return !!e.amount;
    case "date":
      return !!e.date;
    // A to-do still to do; `has:done` is one that has been ticked off.
    case "todo":
    case "todos":
      return todosIn(e.body).some((t) => !t.done);
    case "done":
      return todosIn(e.body).some((t) => t.done);
    default:
      return hasField(e, what);
  }
}

/** Notes live under notes/, files and their sidecars under files/; everything else a reader is handed is an event. */
const kindOf = (e: Entry): "note" | "event" | "file" => (/^\.gitroll\/notes\//i.test(e.path) ? "note" : /^\.gitroll\/files\//i.test(e.path) ? "file" : "event");

const pad = (n: number) => String(n).padStart(2, "0");

/** The first day a filter covers: 2026 → 2026-01-01, 2026-09 → 2026-09-01. */
function dayStart(s: string): string | undefined {
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(s.trim());
  return m ? `${m[1]}-${m[2] ?? "01"}-${m[3] ?? "01"}` : undefined;
}

/** The last day a filter covers: 2026 → 2026-12-31, 2026-09 → 2026-09-30. */
function dayEnd(s: string): string | undefined {
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(s.trim());
  if (!m) return undefined;
  if (m[3]) return `${m[1]}-${m[2]}-${m[3]}`;
  if (m[2]) return `${m[1]}-${m[2]}-${pad(new Date(Number(m[1]), Number(m[2]), 0).getDate())}`;
  return `${m[1]}-12-31`;
}
