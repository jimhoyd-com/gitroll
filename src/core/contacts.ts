// CONTACTS. People are records with vCard's (RFC 6350) names for their fields,
// lower-cased the way front matter keys are written:
//
//   email, tel, url, impp                   how to reach them (one, or a list)
//   adr                                     where: vCard's seven parts, split by ";"
//   org, jobTitle, role                     where they work, and as what
//   n, nickname                             their name in parts ("Lovelace;Ada"), what they're called
//   bday, anniversary                       1815-12-10, or --1210 when the year isn't known
//   categories, note, uid, gender           the rest of vCard's everyday properties
//
// The record's title is the formatted name (vCard's FN). vCard's TITLE, the
// job title, is `jobTitle`, schema.org's name for it, because `title` already
// means the record's own title in front matter.
//
// It is not a new kind of file: `.gitroll/notes/people/` is a collection like
// any other. Events that link to a person are their history, read as
// backlinks, and birthdays and anniversaries are on the calendar every year.
//
// A whole address book goes out as a vCard 4.0 file and comes in from a 3.0
// or 4.0 one. The reader is a hand-written scanner that looks at each
// character a bounded number of times, so no input can make it slow.

import type { Entry } from "./entry.ts";
import { backlinks } from "./relations.ts";
import { metaValue, yearlyDate } from "./calendar.ts";
import { escapeText, foldLine } from "./ical.ts";
import { isSealedValue } from "./sealed.ts";
import { slugify } from "./util.ts";

export const PEOPLE_COLLECTION = "people";

/** The vCard property each front matter key stands for, in the order a card is written. */
const PROPERTIES: [key: string, property: string][] = [
  ["n", "N"],
  ["nickname", "NICKNAME"],
  ["email", "EMAIL"],
  ["tel", "TEL"],
  ["adr", "ADR"],
  ["org", "ORG"],
  ["jobTitle", "TITLE"],
  ["role", "ROLE"],
  ["bday", "BDAY"],
  ["anniversary", "ANNIVERSARY"],
  ["url", "URL"],
  ["impp", "IMPP"],
  ["gender", "GENDER"],
  ["categories", "CATEGORIES"],
  ["note", "NOTE"],
  ["uid", "UID"],
];

/** The keys a contact may use (besides `fn`, the formatted name when it isn't the title). */
export const CONTACT_FIELDS = ["fn", ...PROPERTIES.map(([k]) => k)];

/** Values made of parts split by ";". */
const STRUCTURED = new Set(["N", "ADR", "ORG", "GENDER"]);
/** Values that are a list split by ",". */
const LISTS = new Set(["NICKNAME", "CATEGORIES"]);
/** What vCard allows once in a card (cardinality *1). */
const ONCE = new Set(["N", "BDAY", "ANNIVERSARY", "GENDER", "UID"]);
/** How many parts vCard 4.0 gives each structured value. */
const PARTS: Record<string, number> = { N: 5, ADR: 7 };

// ── Reading a contact ──────────────────────────────────────────────────────

/** Every value of a field, as text: a list's elements, or the one value. Sealed values are left out. */
export function values(v: unknown): string[] {
  const one = (x: unknown): string | null => {
    if (x == null || x === "" || isSealedValue(x)) return null;
    if (x instanceof Date) return Number.isNaN(x.getTime()) ? null : x.toISOString().slice(0, 10);
    if (typeof x === "object") return null;
    const s = String(x).trim();
    return s || null;
  };
  return (Array.isArray(v) ? v : [v]).map(one).filter((x): x is string => x !== null);
}

const first = (meta: Record<string, unknown>, key: string): string | null => values(metaValue(meta, key))[0] ?? null;

/** A structured value as somebody reads it: "Acme;Research" is "Acme, Research". */
export const partsText = (s: string): string => s.split(";").map((p) => p.trim()).filter(Boolean).join(", ");

export interface Interaction {
  path: string;
  title: string;
  date: string | null;
}

export interface Contact {
  path: string;
  /** The formatted name: `fn`, else the record's title. */
  name: string;
  emails: string[];
  tels: string[];
  org: string | null;
  jobTitle: string | null;
  nickname: string | null;
  addresses: string[];
  urls: string[];
  categories: string[];
  /** As written: 1815-12-10, or --1210. */
  bday: string | null;
  anniversary: string | null;
  /** Events that link to this person, newest first: their history. */
  interactions: Interaction[];
  /** The date of the newest of those. */
  lastContacted: string | null;
}

const isEvent = (e: Entry) => e.path.toLowerCase().startsWith(".gitroll/events/");

/** One record, read as a person. `events` are searched for links to it. */
export function contactOf(r: Entry, events: Entry[]): Contact {
  const interactions = backlinks(r.path, events)
    .filter((e) => e.path !== r.path)
    .map((e) => ({ path: e.path, title: e.title, date: e.date }))
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "") || a.title.localeCompare(b.title));
  const dated = interactions.find((i) => i.date);
  return {
    path: r.path,
    name: first(r.meta, "fn") ?? r.title,
    emails: values(metaValue(r.meta, "email")),
    tels: values(metaValue(r.meta, "tel")),
    org: (() => {
      const org = first(r.meta, "org");
      return org ? partsText(org) : null;
    })(),
    jobTitle: first(r.meta, "jobTitle"),
    nickname: values(metaValue(r.meta, "nickname")).join(", ") || null,
    addresses: values(metaValue(r.meta, "adr")).map(partsText).filter(Boolean),
    urls: values(metaValue(r.meta, "url")),
    categories: values(metaValue(r.meta, "categories")),
    bday: first(r.meta, "bday"),
    anniversary: first(r.meta, "anniversary"),
    interactions,
    lastContacted: dated?.date ? dated.date.slice(0, 10) : null,
  };
}

export interface Contacts {
  collection: string;
  contacts: Contact[];
}

/** The contacts view: the records given, as people, by name. `docs` is every document, so links from events are found. */
export function contacts(records: Entry[], docs: Entry[], collection = PEOPLE_COLLECTION): Contacts {
  const events = docs.filter(isEvent);
  return {
    collection,
    contacts: records.map((r) => contactOf(r, events)).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.path.localeCompare(b.path)),
  };
}

// ── vCard out (RFC 6350, version 4.0) ──────────────────────────────────────

/** A date as vCard 4.0 writes one, in its basic form: 18151210, or --1210 with no year. */
function vcardDate(s: string): string | null {
  const d = yearlyDate(s);
  if (!d) return null;
  const md = `${String(d.month).padStart(2, "0")}${String(d.day).padStart(2, "0")}`;
  return d.year === null ? `--${md}` : `${String(d.year).padStart(4, "0")}${md}`;
}

/** One value of a property, escaped as its kind of value needs. */
function encode(property: string, value: string): string {
  if (STRUCTURED.has(property)) {
    const parts = value.split(";").map((p) => escapeText(p.trim()));
    while (PARTS[property] && parts.length < PARTS[property]) parts.push("");
    return parts.join(";");
  }
  return escapeText(value);
}

/** One record as a vCard 4.0, as content lines (not yet folded). */
function cardLines(r: Entry): string[] {
  const lines = ["BEGIN:VCARD", "VERSION:4.0", `FN:${escapeText(first(r.meta, "fn") ?? r.title)}`];
  for (const [key, property] of PROPERTIES) {
    const all = values(metaValue(r.meta, key));
    if (!all.length) continue;
    if (LISTS.has(property)) {
      lines.push(`${property}:${all.map((v) => escapeText(v)).join(",")}`);
      continue;
    }
    const take = ONCE.has(property) ? all.slice(0, 1) : all;
    for (const v of take) {
      if (property === "BDAY" || property === "ANNIVERSARY") {
        const date = vcardDate(v);
        lines.push(date ? `${property}:${date}` : `${property};VALUE=text:${escapeText(v)}`);
      } else lines.push(`${property}:${encode(property, v)}`);
    }
  }
  lines.push("END:VCARD");
  return lines;
}

/**
 * Records as a vCard 4.0 file (RFC 6350): CRLF line endings, lines folded at
 * 75 octets (never inside a character), and text escaped (\\ \, \; and \n).
 */
export function toVCard(records: Entry[]): string {
  return records.flatMap(cardLines).map(foldLine).join("\r\n") + (records.length ? "\r\n" : "");
}

// ── vCard in (RFC 6350 4.0, RFC 2426 3.0) ──────────────────────────────────

export interface VCardProperty {
  /** Upper-cased, without its group (`item1.EMAIL` is EMAIL). */
  name: string;
  /** Parameter names upper-cased; values as written, quotes removed. */
  params: Record<string, string[]>;
  /** As written: still escaped. */
  value: string;
}

/** Content lines, unfolded: a line starting with a space or a tab continues the one before. */
function unfold(text: string): string[] {
  const out: string[] = [];
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (i <= text.length) {
    let end = i;
    while (end < text.length && text[end] !== "\r" && text[end] !== "\n") end++;
    const line = text.slice(i, end);
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length) out[out.length - 1] += line.slice(1);
    else if (line.trim()) out.push(line);
    if (end >= text.length) break;
    i = end + (text[end] === "\r" && text[end + 1] === "\n" ? 2 : 1);
  }
  return out;
}

/** One content line: `[group.]NAME *(;PARAM=value) : value`. Null when it isn't one. */
export function parseContentLine(line: string): VCardProperty | null {
  let i = 0;
  while (i < line.length && line[i] !== ";" && line[i] !== ":") i++;
  if (i >= line.length) return null;
  let name = line.slice(0, i).trim().toUpperCase();
  const dot = name.lastIndexOf(".");
  if (dot >= 0) name = name.slice(dot + 1);
  if (!/^[A-Z0-9-]+$/.test(name)) return null;
  const params: Record<string, string[]> = {};
  while (line[i] === ";") {
    i++;
    const start = i;
    while (i < line.length && line[i] !== "=" && line[i] !== ";" && line[i] !== ":") i++;
    const key = line.slice(start, i).trim().toUpperCase();
    if (line[i] !== "=") {
      // vCard 3.0 allows a bare type: TEL;CELL:…
      if (key) (params.TYPE ??= []).push(key);
      continue;
    }
    const list = (params[key] ??= []);
    i++;
    for (;;) {
      if (line[i] === '"') {
        const close = line.indexOf('"', i + 1);
        if (close < 0) return null;
        list.push(line.slice(i + 1, close));
        i = close + 1;
      } else {
        const s = i;
        while (i < line.length && line[i] !== "," && line[i] !== ";" && line[i] !== ":") i++;
        list.push(line.slice(s, i));
      }
      if (line[i] !== ",") break;
      i++;
    }
  }
  if (line[i] !== ":") return null;
  return { name, params, value: line.slice(i + 1) };
}

/** Splits at every `sep` that isn't escaped with a backslash. */
function splitUnescaped(s: string, sep: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === sep) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

/** Undoes vCard's escapes: \\ \, \; \: and \n (or \N) for a line break. */
export function unescapeText(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== "\\" || i + 1 >= s.length) {
      out += c;
      continue;
    }
    const next = s[++i];
    out += next === "n" || next === "N" ? "\n" : next;
  }
  return out;
}

/** The cards in a vCard file, each a list of its properties. Lines outside BEGIN:VCARD … END:VCARD are ignored. */
export function parseVCards(text: string): VCardProperty[][] {
  const cards: VCardProperty[][] = [];
  let card: VCardProperty[] | null = null;
  let depth = 0;
  for (const line of unfold(text)) {
    const p = parseContentLine(line);
    if (!p) continue;
    const value = p.value.trim().toUpperCase();
    if (p.name === "BEGIN" && value === "VCARD") {
      // A card inside a card (vCard 2.1's AGENT) belongs to the outer one; it isn't read.
      if (depth++ === 0) card = [];
      continue;
    }
    if (p.name === "END" && value === "VCARD") {
      if (depth > 0 && --depth === 0 && card) {
        cards.push(card);
        card = null;
      }
      continue;
    }
    if (card && depth === 1) card.push(p);
  }
  return cards;
}

/** A BDAY or ANNIVERSARY as front matter writes it: 1815-12-10, or --1210 when there's no year. */
function dateValue(p: VCardProperty): string {
  const raw = unescapeText(p.value).trim();
  if ((p.params.VALUE ?? []).some((v) => v.toLowerCase() === "text")) return raw;
  const d = yearlyDate(raw);
  if (!d) return raw;
  const md = `${String(d.month).padStart(2, "0")}${String(d.day).padStart(2, "0")}`;
  // Apple writes a birthday without a year as 1604-03-15 with X-APPLE-OMIT-YEAR=1604.
  const omit = p.params["X-APPLE-OMIT-YEAR"]?.[0];
  if (d.year === null || (omit && Number(omit) === d.year)) return `--${md}`;
  return `${String(d.year).padStart(4, "0")}-${md.slice(0, 2)}-${md.slice(2)}`;
}

/** One property's value as front matter keeps it: parts joined with ";", lists split, escapes undone. */
function decode(p: VCardProperty): string[] {
  if (p.name === "BDAY" || p.name === "ANNIVERSARY") return [dateValue(p)];
  if (STRUCTURED.has(p.name)) {
    const parts = splitUnescaped(p.value, ";").map((x) => unescapeText(x).replace(/;/g, ",").trim());
    while (parts.length && !parts[parts.length - 1]) parts.pop();
    return parts.length ? [parts.join(";")] : [];
  }
  if (LISTS.has(p.name)) return splitUnescaped(p.value, ",").map((x) => unescapeText(x).trim()).filter(Boolean);
  let v = unescapeText(p.value).trim();
  if (p.name === "TEL" && v.toLowerCase().startsWith("tel:")) v = v.slice(4);
  if (p.name === "EMAIL" && v.toLowerCase().startsWith("mailto:")) v = v.slice(7);
  return v ? [v] : [];
}

export interface VCardRecord {
  /** 1-based position of the card in the file, for messages. */
  card: number;
  title: string;
  /** The idempotency id: the card's UID, else its name as a slug. */
  id: string;
  fields: [string, unknown][];
}

/** A card as a record: its name as the title, and a field for each vCard property GitRoll has a key for. */
export function cardRecord(props: VCardProperty[], card: number): VCardRecord | { card: number; message: string } {
  const byName = new Map<string, string[]>();
  for (const p of props) {
    const list = byName.get(p.name) ?? [];
    list.push(...decode(p));
    byName.set(p.name, list);
  }
  const one = (name: string) => byName.get(name)?.[0] ?? "";
  let title = one("FN");
  if (!title) {
    // vCard 3.0 requires N, not FN: family;given;additional;prefixes;suffixes.
    const [family = "", given = "", additional = "", prefix = "", suffix = ""] = one("N").split(";");
    title = [prefix, given, additional, family, suffix].map((s) => s.trim()).filter(Boolean).join(" ") || partsText(one("ORG")) || one("EMAIL");
  }
  title = title.replace(/\s+/g, " ").trim();
  if (!title) return { card, message: "no name (FN, N, ORG or EMAIL), so it was left out" };
  const fields: [string, unknown][] = [];
  for (const [key, property] of PROPERTIES) {
    const all = byName.get(property);
    if (!all?.length) continue;
    const many = !ONCE.has(property);
    fields.push([key, many && all.length > 1 ? all : all[0]]);
  }
  const uid = one("UID");
  return { card, title, id: uid || slugify(title) || title.toLowerCase(), fields };
}

export interface VcfPlan {
  create: VCardRecord[];
  /** Cards already imported into the collection, or repeated in the file. */
  skip: VCardRecord[];
  problems: { card: number; message: string }[];
}

/**
 * Plans an import of a vCard file: a record per card. A card whose id (its UID,
 * else its name as a slug) is already the `source: {adapter: vcf, id}` of a
 * record in the collection is skipped, so importing the same file twice
 * creates each person once.
 */
export function planVcfImport(text: string, existing: Entry[]): VcfPlan {
  const plan: VcfPlan = { create: [], skip: [], problems: [] };
  const taken = new Set(existing.flatMap((e) => (e.source?.adapter === "vcf" ? [e.source.id] : [])));
  parseVCards(text).forEach((props, n) => {
    const r = cardRecord(props, n + 1);
    if (!("title" in r)) {
      plan.problems.push(r);
      return;
    }
    if (taken.has(r.id)) plan.skip.push(r);
    else {
      taken.add(r.id);
      plan.create.push(r);
    }
  });
  return plan;
}
