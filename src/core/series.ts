// SERIES. One numeric field followed over time: an odometer, a weight, a meter.
//
// Nothing new is written. Every event or note that has the field and a date is
// a reading: the field's number on the day the document is dated (an event by
// its file name or `date:`, a note by `date:`). A document with the field but
// no number in it, or with no date, can't be placed on the line; it is counted
// as skipped, with the reason, rather than quietly left out.
//
// Grouping `by` a day, week, month or year keeps the LAST reading in each
// period, not a sum or an average: these are readings of something that
// accumulates or drifts (the odometer at the end of March is what it read last
// in March), so a total of them means nothing. The summary is always worked out
// from every reading, so grouping changes what is listed, never min or max.
//
// Money ({value, currency}, `$12.50`, `99.50 EUR`) is only ever compared with
// money in the same currency: a field that holds two currencies (or money and
// plain numbers) gets one summary per unit, and nothing is converted.

import type { Entry } from "./entry.ts";
import { FIELD_NAME, fieldType, fieldValue, numberOf } from "./fields.ts";
import { parseAmount } from "./util.ts";

export type SeriesBy = "day" | "week" | "month" | "year";
export const SERIES_BY: readonly SeriesBy[] = ["day", "week", "month", "year"];

export interface SeriesPoint {
  /** The document's date as written: YYYY-MM-DD, or an ISO date-time. */
  date: string;
  value: number;
  /** The currency when the value is money; null for a plain number. */
  currency: string | null;
  path: string;
  title: string;
  /** With `by`: the period this reading closes (2026-09, 2026-W38, ...) and how many readings it had. */
  period?: string;
  readings?: number;
}

export interface SeriesSummary {
  currency: string | null;
  count: number;
  first: SeriesPoint;
  last: SeriesPoint;
  min: SeriesPoint;
  max: SeriesPoint;
  /** last − first. */
  change: number;
  /** Whole days from the first reading's day to the last's. */
  days: number;
  /** Change per day, when the readings span at least a day. */
  perDay: number | null;
  /** Change per (average) month, when the readings span at least 28 days. */
  perMonth: number | null;
}

export type SkipReason = "not a number" | "no date";

export interface SeriesSkip {
  path: string;
  title: string;
  reason: SkipReason;
}

export interface Series {
  field: string;
  by: SeriesBy | null;
  /** By date, oldest first. With `by`, one per period (and per currency). */
  points: SeriesPoint[];
  /** One per unit: usually exactly one. Empty when there are no readings. */
  summaries: SeriesSummary[];
  skipped: { notNumeric: number; undated: number; items: SeriesSkip[] };
}

const DAY = /^\d{4}-\d{2}-\d{2}/;
/** "99.50 EUR": an ISO 4217 code, written in capitals, after the number. */
const CODE_AT_END = /\d\s?[A-Z]{3}$/;
const AVERAGE_MONTH = 365.2425 / 12;

/** Twelve significant digits are plenty for a reading and hide 0.1 + 0.2 noise. */
const tidy = (n: number): number => (Number.isFinite(n) ? Number(n.toPrecision(12)) : n);

/** A field value as a reading: a plain number, or money with its currency. Null when it isn't a number. */
export function readingOf(v: unknown): { value: number; currency: string | null } | null {
  if (v == null || Array.isArray(v) || typeof v === "boolean" || v instanceof Date) return null;
  if (typeof v === "number") return Number.isFinite(v) ? { value: v, currency: null } : null;
  if (typeof v === "object") {
    if (fieldType(v) !== "amount") return null;
    const o = v as Record<string, unknown>;
    const value = numberOf(o.value);
    return value === null ? null : { value, currency: String(o.currency).trim().toUpperCase() || null };
  }
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (fieldType(s) === "date") return null;
  if (fieldType(s) === "amount" || (s.length > 3 && CODE_AT_END.test(s))) {
    const a = parseAmount(s);
    if (a) return { value: a.value, currency: a.currency };
  }
  const n = numberOf(s);
  return n === null ? null : { value: n, currency: null };
}

const dayOf = (date: string): string | null => (DAY.test(date) ? date.slice(0, 10) : null);

const dayNumber = (day: string): number => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / 86_400_000;

/** The ISO 8601 week a day falls in, e.g. 2026-W41. A week belongs to the year its Thursday is in. */
export function isoWeek(day: string): string {
  const d = new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))));
  const weekday = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function periodOf(day: string, by: SeriesBy): string {
  switch (by) {
    case "day":
      return day;
    case "week":
      return isoWeek(day);
    case "month":
      return day.slice(0, 7);
    default:
      return day.slice(0, 4);
  }
}

export function isSeriesBy(s: string): s is SeriesBy {
  return (SERIES_BY as readonly string[]).includes(s.toLowerCase());
}

function summarize(points: SeriesPoint[]): SeriesSummary {
  const first = points[0];
  const last = points[points.length - 1];
  let min = first;
  let max = first;
  for (const p of points) {
    if (p.value < min.value) min = p;
    if (p.value > max.value) max = p;
  }
  const change = tidy(last.value - first.value);
  const days = Math.round(dayNumber(dayOf(last.date)!) - dayNumber(dayOf(first.date)!));
  return {
    currency: first.currency,
    count: points.length,
    first,
    last,
    min,
    max,
    change,
    days,
    perDay: days >= 1 ? tidy(change / days) : null,
    perMonth: days >= 28 ? tidy((change / days) * AVERAGE_MONTH) : null,
  };
}

/**
 * A field's readings over time, with a summary per unit. `field` is matched in
 * any case, like every other field lookup. Documents without the field aren't
 * part of the series and aren't counted; ones that have it but can't be placed
 * are listed in `skipped`.
 */
export function series(docs: Entry[], field: string, by?: SeriesBy | null): Series {
  const all: SeriesPoint[] = [];
  const items: SeriesSkip[] = [];
  for (const e of docs) {
    const raw = fieldValue(e, field);
    if (raw == null || raw === "") continue;
    const reading = readingOf(raw);
    if (!reading) {
      items.push({ path: e.path, title: e.title, reason: "not a number" });
      continue;
    }
    if (!e.date || !dayOf(e.date)) {
      items.push({ path: e.path, title: e.title, reason: "no date" });
      continue;
    }
    all.push({ date: e.date, value: reading.value, currency: reading.currency, path: e.path, title: e.title });
  }
  all.sort((a, b) => a.date.slice(0, 10).localeCompare(b.date.slice(0, 10)) || a.date.localeCompare(b.date) || a.path.localeCompare(b.path));

  const units = new Map<string, SeriesPoint[]>();
  for (const p of all) {
    const key = p.currency ?? "";
    units.set(key, [...(units.get(key) ?? []), p]);
  }
  // Plain numbers first, then currencies in order.
  const summaries = [...units.keys()].sort().map((k) => summarize(units.get(k)!));

  let points = all;
  if (by) {
    const periods = new Map<string, SeriesPoint>();
    for (const p of all) {
      const period = periodOf(dayOf(p.date)!, by);
      const key = `${p.currency ?? ""}\u0000${period}`;
      const before = periods.get(key);
      // The map keeps the first insertion's place, so delete to move the period
      // to where its last reading is.
      periods.delete(key);
      periods.set(key, { ...p, period, readings: (before?.readings ?? 0) + 1 });
    }
    points = [...periods.values()];
  }
  items.sort((a, b) => a.path.localeCompare(b.path));
  return {
    field,
    by: by ?? null,
    points,
    summaries,
    skipped: { notNumeric: items.filter((i) => i.reason === "not a number").length, undated: items.filter((i) => i.reason === "no date").length, items },
  };
}

export interface NumericField {
  /** The name as first written. */
  name: string;
  /** How many dated documents have a number in it. */
  count: number;
}

/** Fields that hold a number in at least one dated document: what a series can be drawn of. Most used first. */
export function numericFields(docs: Entry[]): NumericField[] {
  const found = new Map<string, NumericField>();
  for (const e of docs) {
    if (!e.date || !dayOf(e.date)) continue;
    const keys = new Set<string>();
    const names = [...(e.amount ? ["amount"] : []), ...Object.keys(e.meta)];
    for (const name of names) {
      const k = name.toLowerCase();
      if (keys.has(k) || !FIELD_NAME.test(name) || k === "date") continue;
      keys.add(k);
      if (!readingOf(fieldValue(e, name))) continue;
      const f = found.get(k) ?? { name, count: 0 };
      f.count++;
      found.set(k, f);
    }
  }
  return [...found.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

const BLOCKS = "▁▂▃▄▅▆▇█";

/**
 * A line of block characters, one per value, for a terminal. More values than
 * `width` are bucketed, each bucket showing its last value (like `by`).
 */
export function sparkline(values: number[], width = 60): string {
  if (!values.length) return "";
  let shown = values;
  if (values.length > width) {
    shown = [];
    for (let i = 0; i < width; i++) shown.push(values[Math.min(values.length - 1, Math.floor(((i + 1) * values.length) / width) - 1)]);
  }
  const lo = Math.min(...shown);
  const hi = Math.max(...shown);
  if (hi === lo) return BLOCKS[3].repeat(shown.length);
  return shown.map((v) => BLOCKS[Math.round(((v - lo) / (hi - lo)) * (BLOCKS.length - 1))]).join("");
}

/** A reading as a person reads it: grouped digits, up to six decimals, and the currency when it's money. */
export function formatReading(value: number, currency: string | null = null, opts: { signed?: boolean; digits?: number } = {}): string {
  const digits = opts.digits ?? (Math.abs(value) >= 100 ? 2 : 6);
  const text = value.toLocaleString("en-US", { maximumFractionDigits: digits });
  const sign = opts.signed && value > 0 ? "+" : "";
  return `${sign}${text}${currency ? ` ${currency}` : ""}`;
}
