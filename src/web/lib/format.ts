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

export function fmtSize(bytes?: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

export const isImage = (a: { type: string }) => a.type.startsWith("image/") && !a.type.includes("svg") && !a.type.includes("heic");

export const fileKind = (a: Attachment) => (isImage(a) ? "Photo" : a.type === "application/pdf" ? "PDF" : "File");

/** A datetime-local value for an ISO timestamp, in the viewer's own time zone. */
export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** A YYYY-MM-DD key for a date, in local time, for grouping and date filters. */
export function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export const safeUrl = (u: unknown): u is string => typeof u === "string" && /^https?:\/\//i.test(u);
