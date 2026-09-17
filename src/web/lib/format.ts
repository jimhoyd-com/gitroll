import { parseSegmentPath } from "../../core/segments.ts";
import { formatBytes } from "../../core/util.ts";
import type { Attachment } from "../../core/entry.ts";

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export function dayLabel(d: Date): string {
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: d.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
}

/**
 * A filing period as a person says it: "September 2026", or "16 September 2026"
 * for a Roll filed by day. The period itself — 2026-09 — is what the commands
 * take, so it is kept alongside rather than replaced.
 */
export function periodLabel(period: string): string {
  const daily = period.length === 10;
  // Midday, so the label can't slip a month in a zone behind UTC.
  const d = new Date(`${daily ? period : `${period}-01`}T12:00:00`);
  if (Number.isNaN(d.getTime())) return period;
  return d.toLocaleDateString([], daily ? { day: "numeric", month: "long", year: "numeric" } : { month: "long", year: "numeric" });
}

/**
 * The month an entry was filed under, from the file it was in.
 *
 * An entry that had a file to itself was never in a month: its path is its own
 * name, and printing that would be a file path where a person expects a date.
 */
export function filedUnder(path: string): string | null {
  const ref = parseSegmentPath(path);
  return ref ? periodLabel(ref.period) : null;
}

/** "2 hours ago", for things that happened recently enough to matter. */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 45) return "just now";
  const rtf = new Intl.RelativeTimeFormat([], { numeric: "auto" });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31536000],
    ["month", 2592000],
    ["week", 604800],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [unit, size] of units) {
    if (seconds >= size) return rtf.format(-Math.round(seconds / size), unit);
  }
  return rtf.format(-Math.round(seconds / 60), "minute");
}

export function fmtAmount(a: { value: number; currency: string }): string {
  try {
    return new Intl.NumberFormat([], { style: "currency", currency: a.currency }).format(a.value);
  } catch {
    return `${a.value} ${a.currency}`;
  }
}

/** A file's size, or nothing when there isn't one to show. */
export const fmtSize = (bytes?: number): string => formatBytes(bytes, { zero: "" });

export const isImage = (a: { type: string }) => a.type.startsWith("image/") && !a.type.includes("svg") && !a.type.includes("heic");

export const fileKind = (a: Attachment) => (isImage(a) ? "Photo" : a.type === "application/pdf" ? "PDF" : "File");

/** The date input value for an event's date. Events carry a date, not a timestamp. */
export const toDateInput = (date: string | null): string => (date ? date.slice(0, 10) : "");

/** An event's date as a Date, for grouping and labels. A bare date means midday, so it keeps its day. */
export function dateOf(date: string | null): Date | null {
  if (!date) return null;
  const d = new Date(date.length === 10 ? `${date}T12:00:00` : date);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** A YYYY-MM-DD key for a date, in local time, for grouping and date filters. */
export function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export const safeUrl = (u: unknown): u is string => typeof u === "string" && /^https?:\/\//i.test(u);
