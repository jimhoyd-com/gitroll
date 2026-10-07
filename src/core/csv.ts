// CSV, as RFC 4180 writes it: comma-separated fields, CRLF between records,
// and a field that holds a comma, a double quote, a CR or an LF in double
// quotes, with each double quote inside written twice.
//
// A collection goes out as a table (`gitroll records <collection> --csv`) and a
// spreadsheet comes in as records, one per row (`gitroll import csv`).

import { parse } from "yaml";
import type { Entry } from "./entry.ts";
import { columnsOf } from "./fields.ts";
import { slugify } from "./util.ts";

/** One field, quoted only when it has to be. */
export function csvField(s: string): string {
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows to RFC 4180 text, CRLF after every record. */
export function toCsv(rows: string[][]): string {
  return rows.map((r) => r.map(csvField).join(",")).join("\r\n") + "\r\n";
}

/**
 * Reads RFC 4180 text into rows. A quoted field may hold commas, quotes ("")
 * and line breaks. LF alone is accepted as a line break as well as CRLF, and a
 * byte-order mark at the start is ignored. Throws on a quote left open.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let wasQuoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const endField = () => {
    row.push(field);
    field = "";
    wasQuoted = false;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };
  for (; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && !field && !wasQuoted) {
      quoted = true;
      wasQuoted = true;
    } else if (c === ",") endField();
    else if (c === "\r" && text[i + 1] === "\n") {
      endRow();
      i++;
    } else if (c === "\n" || c === "\r") endRow();
    else field += c;
  }
  if (quoted) throw new Error("a quoted field is never closed");
  if (field || wasQuoted || row.length) endRow();
  return rows;
}

/** A value as one cell: lists in YAML's flow style ([a, b]), mappings as JSON, everything else as text. */
export function cellOf(v: unknown): string {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (Array.isArray(v)) return `[${v.map((x) => (typeof x === "string" && /[,[\]{}"':#]/.test(x) ? JSON.stringify(x) : cellOf(x))).join(", ")}]`;
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** A collection as a table: title, then a column for every field in use (the bookkeeping `source` left out). */
export function recordsToCsv(records: Entry[], columns: string[] = columnsOf(records)): string {
  const cols = columns.filter((c) => c.toLowerCase() !== "title");
  const field = (r: Entry, key: string): unknown => {
    if (Object.hasOwn(r.meta, key)) return r.meta[key];
    const k = key.toLowerCase();
    for (const own of Object.keys(r.meta)) if (own.toLowerCase() === k) return r.meta[own];
    return undefined;
  };
  return toCsv([["title", ...cols], ...records.map((r) => [r.title, ...cols.map((c) => cellOf(field(r, c)))])]);
}

const NUMBER = /^-?(?:0|[1-9]\d{0,14})(?:\.\d+)?$/;

/**
 * A cell as a field value. Numbers (without leading zeros, so an SKU like 00123
 * stays text), true and false, and [lists] or {mappings} become those; anything
 * else, dates included, is text.
 */
export function valueOfCell(cell: string): unknown {
  const s = cell.trim();
  if (NUMBER.test(s)) return Number(s);
  if (s === "true" || s === "false") return s === "true";
  if ((s.startsWith("[") && s.endsWith("]")) || (s.startsWith("{") && s.endsWith("}"))) {
    try {
      const v: unknown = parse(s);
      if (v && typeof v === "object") return v;
    } catch {
      // not a list after all: keep the words
    }
  }
  return cell;
}

export interface CsvRow {
  /** 1-based row number in the file, header included, for messages. */
  row: number;
  title: string;
  /** The idempotency id: the title as a slug. */
  id: string;
  fields: [string, unknown][];
}

export interface CsvPlan {
  titleColumn: string;
  create: CsvRow[];
  /** Rows whose id is already a record in the collection, or repeated in the file. */
  skip: CsvRow[];
  /** Rows left out, and why. */
  problems: { row: number; message: string }[];
}

const FIELD_NAME = /^[A-Za-z_][\w-]*$/;

/**
 * Plans an import: the `title` (or `name`) column, else the first, is each
 * record's title; every other column is a field. A row whose title slug is
 * already the `source: {adapter: csv, id}` of a record in the collection is
 * skipped, so importing the same file twice creates each record once.
 */
export function planCsvImport(text: string, existing: Entry[]): CsvPlan {
  const rows = parseCsv(text).filter((r) => r.some((c) => c.trim()));
  if (!rows.length) return { titleColumn: "", create: [], skip: [], problems: [] };
  const header = rows[0].map((h) => h.trim());
  let titleAt = header.findIndex((h) => h.toLowerCase() === "title");
  if (titleAt < 0) titleAt = header.findIndex((h) => h.toLowerCase() === "name");
  if (titleAt < 0) titleAt = 0;
  const problems: CsvPlan["problems"] = [];
  const columns = header.map((h, i) => {
    if (i === titleAt) return null;
    const name = h.replace(/\s+/g, "_");
    if (!FIELD_NAME.test(name)) {
      if (h) problems.push({ row: 1, message: `column "${h}" isn't a field name (letters, digits, - and _), so it was left out` });
      return null;
    }
    return name;
  });
  const taken = new Set(existing.flatMap((e) => (e.source?.adapter === "csv" ? [e.source.id] : [])));
  const plan: CsvPlan = { titleColumn: header[titleAt] ?? "", create: [], skip: [], problems };
  rows.slice(1).forEach((cells, n) => {
    const row = n + 2;
    const title = (cells[titleAt] ?? "").replace(/\s+/g, " ").trim();
    if (!title) {
      problems.push({ row, message: "no title, so it was left out" });
      return;
    }
    const id = slugify(title) || title.toLowerCase();
    const fields: [string, unknown][] = [];
    columns.forEach((name, i) => {
      if (!name || cells[i] === undefined || !cells[i].trim()) return;
      if (name.toLowerCase() === "source") return; // the import's own bookkeeping key
      fields.push([name, valueOfCell(cells[i])]);
    });
    const r = { row, title, id, fields };
    if (taken.has(id)) plan.skip.push(r);
    else {
      taken.add(id);
      plan.create.push(r);
    }
  });
  return plan;
}
