// FIELDS. Every front matter key is a field somebody can search, sort and set.
//
// There is no schema. A field's type is whatever its YAML value already is:
//
//   rating: 5              number
//   expires: 2026-11-01    date (a YAML string that is an ISO date or timestamp)
//   price: $12.50          amount (a currency sign and a number; `amount:` is one too)
//   read: true             boolean
//   authors: [Le Guin]     list (each element is matched and compared on its own)
//   status: reading        text (anything else, and anything quoted)
//
// Every regular expression here is anchored and unambiguous, so it runs in
// linear time on whatever a person or a program types.

import { isMap, isScalar, parseDocument } from "yaml";
import type { Document, Node, Scalar, YAMLMap } from "yaml";
import type { Entry } from "./entry.ts";
import { FormatError, splitFrontMatter, yamlText } from "./entry.ts";
import { NOTES_DIR } from "./layout.ts";
import { UserError, isRealTimestamp } from "./util.ts";

export type FieldType = "text" | "number" | "date" | "amount" | "boolean" | "list";
export type CompareOp = ">" | ">=" | "<" | "<=";

/** What a field name can be: what a search token can spell, so every field is findable. */
export const FIELD_NAME = /^[A-Za-z_][\w-]*$/;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?$/;
const PARTIAL_DAY = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/;
const MONEY = /^([$€£¥])\s?(-?\d[\d,]*)(\.\d+)?$/;
const NUMBER = /^[$€£¥]?\s?(-?\d[\d,]*)(\.\d+)?$/;
/** `[text](target)` at the start of a typed value: a link to a record, not YAML. */
const MARKDOWN_LINK_VALUE = /^\s*\[[^\]\n]*\]\([^()\s]*\)/;

const isDateText = (s: string): boolean => (DAY.test(s) || TIMESTAMP.test(s)) && isRealTimestamp(s);

/** The type a value already has, read from its YAML. */
export function fieldType(v: unknown): FieldType {
  if (Array.isArray(v)) return "list";
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "boolean";
  if (v instanceof Date) return "date";
  if (typeof v === "string") {
    if (isDateText(v)) return "date";
    if (MONEY.test(v.trim())) return "amount";
    return "text";
  }
  if (v && typeof v === "object" && Number.isFinite(Number((v as Record<string, unknown>).value)) && "currency" in v) return "amount";
  return "text";
}

/** The value of a field, by name, case-insensitively. A few names mean what GitRoll reads, not only what's written. */
export function fieldValue(e: Entry, key: string): unknown {
  const k = key.toLowerCase();
  switch (k) {
    case "title":
      return e.title;
    case "path":
      return e.path;
    case "date":
      return e.date ?? undefined;
    case "amount":
      return e.amount;
    case "tags":
    case "tag":
      return e.tags.length ? e.tags : undefined;
    case "projects":
    case "project":
      return e.projects.length ? e.projects : undefined;
  }
  if (Object.hasOwn(e.meta, key)) return e.meta[key];
  for (const own of Object.keys(e.meta)) if (own.toLowerCase() === k) return e.meta[own];
  return undefined;
}

/** A field is there when it has something in it: not missing, null, empty, an empty list, or false. */
export function hasField(e: Entry, key: string): boolean {
  const v = fieldValue(e, key);
  return v != null && v !== "" && v !== false && !(Array.isArray(v) && !v.length);
}

/** A number read from a number, an amount ({value}) or numeric text like 48,210 or $12.50; null otherwise. */
export const numberOf = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v && typeof v === "object" && !Array.isArray(v)) return numberOf(Number((v as Record<string, unknown>).value));
  if (typeof v !== "string") return null;
  const m = NUMBER.exec(v.trim());
  if (!m) return null;
  const n = Number(`${m[1].replace(/,/g, "")}${m[2] ?? ""}`);
  return Number.isFinite(n) ? n : null;
};

const textOf = (v: unknown): string => {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return typeof v === "object" ? JSON.stringify(v) : String(v);
};

const pad = (n: number) => String(n).padStart(2, "0");

/** The first and last day a partial date covers: 2026-09 is 2026-09-01 to 2026-09-30. */
export function dayRange(s: string): { start: string; end: string } | null {
  const m = PARTIAL_DAY.exec(s.trim());
  if (!m) return null;
  const start = `${m[1]}-${m[2] ?? "01"}-${m[3] ?? "01"}`;
  const end = m[3] ? start : m[2] ? `${m[1]}-${m[2]}-${pad(new Date(Number(m[1]), Number(m[2]), 0).getDate())}` : `${m[1]}-12-31`;
  return { start, end };
}

const BOOL: Record<string, boolean> = { true: true, yes: true, y: true, on: true, false: false, no: false, n: false, off: false };

/** `key:value`: does this value match? Text contains it (any case); numbers, amounts and booleans equal it; dates start with it. */
export function matchesValue(v: unknown, needle: string): boolean {
  if (v == null) return false;
  const want = needle.toLowerCase();
  if (Array.isArray(v)) return v.some((x) => matchesValue(x, needle));
  switch (fieldType(v)) {
    case "number":
    case "amount": {
      const n = numberOf(needle);
      return n !== null ? numberOf(v) === n : textOf(v).toLowerCase().includes(want);
    }
    case "boolean":
      return Object.hasOwn(BOOL, want) && BOOL[want] === v;
    case "date":
      return textOf(v).startsWith(want);
    default:
      return textOf(v).toLowerCase().includes(want);
  }
}

/** `key>=value` and friends. A value of a different type never matches. A list matches when any element does. */
export function compareValue(v: unknown, op: CompareOp, needle: string): boolean {
  if (v == null) return false;
  if (Array.isArray(v)) return v.some((x) => compareValue(x, op, needle));
  switch (fieldType(v)) {
    case "number":
    case "amount": {
      const a = numberOf(v);
      const b = numberOf(needle);
      return a !== null && b !== null && test(a, op, b);
    }
    case "date": {
      const day = textOf(v);
      if (TIMESTAMP.test(needle)) return test(day, op, needle);
      const range = dayRange(needle);
      if (!range) return false;
      const d = day.slice(0, 10);
      // A day bound covers the whole of it: `<2026-11` is before November starts,
      // `<=2026-11` is up to and including its last day.
      return op === ">=" ? d >= range.start : op === ">" ? d > range.end : op === "<" ? d < range.start : d <= range.end;
    }
    case "text":
      return test(textOf(v).toLowerCase(), op, needle.toLowerCase());
    default:
      return false;
  }
}

function test<T extends number | string>(a: T, op: CompareOp, b: T): boolean {
  switch (op) {
    case ">":
      return a > b;
    case ">=":
      return a >= b;
    case "<":
      return a < b;
    default:
      return a <= b;
  }
}

// ── Sorting ────────────────────────────────────────────────────────────────

export interface SortKey {
  key: string;
  descending: boolean;
}

/** `rating`, `-rating` or `rating:desc` (descending), or several: `-rating,title`. */
export function parseSort(spec: string): SortKey[] {
  const keys = spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const lower = s.toLowerCase();
      if (lower.endsWith(":desc")) return { key: s.slice(0, -5), descending: true };
      if (lower.endsWith(":asc")) return { key: s.slice(0, -4), descending: false };
      return s.startsWith("-") ? { key: s.slice(1), descending: true } : { key: s.replace(/^\+/, ""), descending: false };
    });
  if (!keys.length || keys.some((k) => !FIELD_NAME.test(k.key))) throw new UserError(`--sort takes field names, e.g. --sort rating or --sort=-rating,title (got "${spec}").`);
  return keys;
}

const RANK: Record<FieldType, number> = { number: 0, amount: 0, date: 1, text: 2, boolean: 3, list: 4 };

const rankOf = (v: unknown): number => RANK[fieldType(Array.isArray(v) ? v[0] : v)];

/** Two values of the same kind, in order. Values of different kinds are grouped by kind before this is asked. */
function compareFields(a: unknown, b: unknown): number {
  if (Array.isArray(a)) a = a[0];
  if (Array.isArray(b)) b = b[0];
  const ta = fieldType(a);
  if (ta === "number" || ta === "amount") return (numberOf(a) ?? 0) - (numberOf(b) ?? 0);
  if (ta === "boolean") return Number(a) - Number(b);
  return textOf(a).localeCompare(textOf(b), undefined, { sensitivity: "base", numeric: true });
}

/** Sorts by fields, stably. A record without the field goes last whichever way the sort runs. */
export function sortByFields<T extends Entry>(entries: T[], keys: SortKey[]): T[] {
  return entries
    .map((e, i) => ({ e, i }))
    .sort((x, y) => {
      for (const { key, descending } of keys) {
        const a = fieldValue(x.e, key);
        const b = fieldValue(y.e, key);
        const ma = a == null || a === "" || (Array.isArray(a) && !a.length);
        const mb = b == null || b === "" || (Array.isArray(b) && !b.length);
        if (ma || mb) {
          if (ma && mb) continue;
          return ma ? 1 : -1;
        }
        // Mixed kinds (a number here, a word there) stay grouped the same way
        // whichever direction the sort runs: numbers, dates, text, booleans.
        const rank = rankOf(a) - rankOf(b);
        if (rank) return rank;
        const c = compareFields(a, b);
        if (c) return descending ? -c : c;
      }
      return x.i - y.i;
    })
    .map(({ e }) => e);
}

// ── Collections ────────────────────────────────────────────────────────────

const README = /^readme\.md$/i;

/** The collection a note belongs to: the folder under notes/ it sits in ("books", "books/scifi"), or null at the top. */
export function collectionOf(path: string): string | null {
  if (!path.toLowerCase().startsWith(`${NOTES_DIR.toLowerCase()}/`)) return null;
  const rest = path.slice(NOTES_DIR.length + 1);
  const cut = rest.lastIndexOf("/");
  return cut > 0 ? rest.slice(0, cut) : null;
}

/**
 * Whether a note is in a collection, named in any case: in its folder or in a
 * folder under it, so `inventory` holds `inventory/tools/drill.md` too.
 */
export function inCollection(path: string, name: string): boolean {
  const at = collectionOf(path)?.toLowerCase();
  const want = trimSlashes(name).toLowerCase();
  return !!at && !!want && (at === want || at.startsWith(`${want}/`));
}

const trimSlashes = (name: string): string => {
  let start = 0;
  let end = name.length;
  while (start < end && name[start] === "/") start++;
  while (end > start && name[end - 1] === "/") end--;
  return name.slice(start, end);
};

/** A collection's README.md describes it; it isn't one of its records. */
export const isCollectionReadme = (path: string): boolean => collectionOf(path) !== null && README.test(path.slice(path.lastIndexOf("/") + 1));

export interface Collection {
  name: string;
  path: string;
  records: number;
  description: string | null;
}

/** The first paragraph of prose in a README, for a one-line description. */
function describe(readme: Entry | undefined): string | null {
  if (!readme) return null;
  const para: string[] = [];
  for (const line of readme.body.split("\n")) {
    const text = line.trim();
    if (!text) {
      if (para.length) break;
      continue;
    }
    if (/^#{1,6}\s/.test(text)) {
      if (para.length) break;
      continue;
    }
    para.push(text);
  }
  return para.join(" ") || readme.title || null;
}

/**
 * Every collection the notes are in, by name, with how many records each
 * holds: its own and those in the folders under it, as recordsIn reads it.
 */
export function collections(notes: Entry[]): Collection[] {
  const found = new Map<string, { readme?: Entry }>();
  for (const n of notes) {
    const name = collectionOf(n.path);
    if (name === null) continue;
    const c = found.get(name) ?? {};
    if (isCollectionReadme(n.path)) c.readme = n;
    found.set(name, c);
  }
  return [...found]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, c]) => ({ name, path: `${NOTES_DIR}/${name}`, records: recordsIn(notes, name).length, description: describe(c.readme) }));
}

/** The records in one collection (named in any case) and the folders under it, READMEs excluded. */
export function recordsIn<T extends Entry>(notes: T[], name: string): T[] {
  return notes.filter((n) => inCollection(n.path, name) && !isCollectionReadme(n.path));
}

/** A GitRoll bookkeeping mapping (`source: {adapter, id}`) isn't something a person reads as a column. */
const isBookkeeping = (key: string, v: unknown) => key === "source" && !!v && typeof v === "object" && "adapter" in v && "id" in v;

/** The front matter keys in use across some records, in the order they first appear. */
export function columnsOf(records: Entry[]): string[] {
  const seen = new Map<string, string>();
  for (const r of records) for (const [k, v] of Object.entries(r.meta)) if (!isBookkeeping(k, v) && !seen.has(k.toLowerCase())) seen.set(k.toLowerCase(), k);
  return [...seen.values()];
}

/** One record as a row: its path, title, and the value of each column (null when it has none). */
export function recordRow(r: Entry, columns: string[]): { path: string; title: string; fields: Record<string, unknown> } {
  return { path: r.path, title: r.title, fields: Object.fromEntries(columns.map((c) => [c, rawField(r, c) ?? null])) };
}

/** The front matter value itself, by name in any case: no computed values. */
function rawField(e: Entry, key: string): unknown {
  if (Object.hasOwn(e.meta, key)) return e.meta[key];
  const k = key.toLowerCase();
  for (const own of Object.keys(e.meta)) if (own.toLowerCase() === k) return e.meta[own];
  if (k === "title") return e.title;
  if (k === "path") return e.path;
  return undefined;
}

// ── Setting fields ─────────────────────────────────────────────────────────

/** A value to write: YAML text as somebody typed it (`5`, `2026-11-01`, `"5"`), or a value from a program. */
export type FieldInput = { yaml: string } | { value: unknown };

/** `key=value` as typed on a command line. The value is YAML: `rating=5` is a number, `rating="5"` text. */
export function parseAssignment(text: string): { key: string; input: FieldInput } {
  const at = text.indexOf("=");
  const key = at > 0 ? text.slice(0, at).trim() : "";
  if (!FIELD_NAME.test(key)) throw new UserError(`"${text}" isn't key=value. A field name starts with a letter and has only letters, digits, - and _, e.g. rating=5`);
  const yaml = text.slice(at + 1);
  if (!yaml.trim()) throw new UserError(`${key}= has no value. To remove a field use --unset ${key}; for empty text write ${key}='""'.`);
  return { key, input: { yaml } };
}

function nodeFor(doc: Document, input: FieldInput, key: string): Node {
  if ("value" in input) return doc.createNode(input.value) as Node;
  // A Markdown link (`within=[House](house.md)`, `org=[Acme](acme.md);Research`)
  // is how a field links to a record. As YAML it is a list followed by junk,
  // so it is written as the text it plainly is.
  if (MARKDOWN_LINK_VALUE.test(input.yaml)) return doc.createNode(input.yaml.trim()) as Node;
  const parsed = parseDocument(input.yaml);
  if (parsed.errors.length || parsed.contents == null) throw new UserError(`${key}=${input.yaml} isn't a value GitRoll can write: ${parsed.errors[0]?.message ?? "it is empty"}. Quote it to write it as text.`);
  if (isMap(parsed.contents)) throw new UserError(`${key} can be text, a number, a date, true or false, or a list like [a, b] — not a mapping.`);
  return parsed.contents as Node;
}

/**
 * Sets and removes front matter fields, touching nothing else. The YAML is
 * edited in place, so other keys, their order, comments and formatting stay as
 * they were; the body is left byte for byte. A key is matched in any case, so
 * `rating=5` updates an existing `Rating:` rather than adding a second one.
 */
export function setFields(source: string, set: Map<string, FieldInput> | [string, FieldInput][], unset: string[] = []): string {
  const { frontMatter, body } = splitFrontMatter(source);
  const doc = parseDocument(frontMatter ?? "");
  if (doc.errors.length) throw new FormatError(`invalid YAML front matter: ${doc.errors[0].message}`);
  if (doc.contents == null) (doc as { contents: unknown }).contents = doc.createNode({});
  if (!isMap(doc.contents)) throw new FormatError("front matter must be a mapping, e.g. date: 2026-09-15");
  const map = doc.contents as YAMLMap<unknown, unknown>;
  const existing = (key: string): Scalar | undefined => {
    const k = key.toLowerCase();
    return map.items.map((p) => p.key).find((n): n is Scalar => isScalar(n) && String(n.value).toLowerCase() === k);
  };
  for (const key of unset) {
    const at = existing(key);
    if (at) map.delete(at);
  }
  for (const [key, input] of set) {
    const node = nodeFor(doc, input, key);
    const at = existing(key);
    const old = at ? (map.get(at, true) as Node | undefined) : undefined;
    // Keep a comment written beside the old value: `rating: 4 # reread`.
    if (old && isScalar(old) && isScalar(node)) {
      node.comment = old.comment;
      node.spaceBefore = old.spaceBefore;
    }
    map.set(at ?? key, node);
  }
  const yaml = map.items.length ? yamlText(doc, frontMatter ?? "").trimEnd() : "";
  if (!yaml) return frontMatter === null ? source : body.replace(/^\r?\n/, "");
  return frontMatter === null ? `---\n${yaml}\n---\n\n${source.replace(/^﻿/, "")}` : `---\n${yaml}\n---\n${body}`;
}

/**
 * A front matter value as the YAML somebody would type to write it back with
 * `key=value`: `5`, `true`, `2026-11-01`, `[a, b]`, and text as it is unless
 * that would read back as something else (`"5"`). Null for a value that can't
 * be written that way, such as a mapping (an amount with its currency).
 */
export function fieldYaml(v: unknown): string | null {
  if (v == null) return "";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "string") {
    if (v && !v.includes("\n")) {
      const doc = parseDocument(v);
      if (!doc.errors.length && isScalar(doc.contents) && doc.contents.value === v) return v;
    }
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return JSON.stringify(v);
  return null;
}
