// Pure helpers shared by Node and the browser. No platform imports.

import type { Amount } from "./entry.ts";

/** An error caused by bad input rather than a bug or an infrastructure failure. */
export class UserError extends Error {}
export class NotFoundError extends UserError {}
export class ConflictError extends UserError {}
/** The GitHub credential is missing, expired or revoked. */
export class AuthError extends UserError {}

const pad = (n: number) => String(Math.abs(n)).padStart(2, "0");

/** ISO 8601 timestamp in the local time zone, with offset: 2026-09-15T09:43:18-05:00 */
export function isoLocal(d: Date = new Date()): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
  );
}

/** Local calendar date: 2026-09-15 */
export function isoDate(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * True when an ISO 8601 date or date-time names a real calendar moment: no February 30,
 * no hour 24, and an offset within ±14:00. (JavaScript would silently roll those over.)
 */
export function isRealTimestamp(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|([+-])(\d{2}):(\d{2}))?)?$/.exec(s);
  if (!m) return false;
  const [y, mo, d, h = "0", mi = "0", sec = "0", , oh = "0", om = "0"] = m.slice(1);
  const day = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (day.getUTCFullYear() !== Number(y) || day.getUTCMonth() !== Number(mo) - 1 || day.getUTCDate() !== Number(d)) return false;
  return Number(h) <= 23 && Number(mi) <= 59 && Number(sec) <= 59 && Number(oh) * 60 + Number(om) <= 14 * 60 && Number(om) <= 59;
}

/**
 * Accepts "2026-09-14", "2026-09-14T15:30", or a full ISO timestamp.
 * An explicit offset is kept as given so the author's time zone is preserved.
 */
export function normalizeTimestamp(input: string): string {
  const s = input.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s) && !isRealTimestamp(s.replace(" ", "T"))) throw new UserError(`Invalid date/time: ${input}`);
  const withOffset = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(:\d{2})?(?:\.\d+)?([+-]\d{2}:\d{2})$/.exec(s);
  if (withOffset) return `${withOffset[1]}${withOffset[2] ?? ":00"}${withOffset[3]}`;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T12:00:00` : s);
  if (Number.isNaN(d.getTime())) throw new UserError(`Invalid date/time: ${input}`);
  return isoLocal(d);
}

export function slugify(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
}

export function titleCase(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

export function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

export function summarize(text: string, max = 60): string {
  const line = text.trim().split("\n")[0].trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function extname(name: string): string {
  const m = /\.[^./\\]+$/.exec(name ?? "");
  return m ? m[0].toLowerCase() : "";
}

export function basename(name: string): string {
  return (name ?? "").split(/[\\/]/).pop() ?? "";
}

const MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".zip": "application/zip",
};

export function mimeFor(ext: string): string {
  return MIME[ext.toLowerCase()] ?? "application/octet-stream";
}

export function extensionFor(name: string, type?: string): string {
  const ext = extname(name);
  if (/^\.[a-z0-9]{1,10}$/.test(ext)) return ext === ".jpeg" ? ".jpg" : ext;
  if (type) {
    const hit = Object.entries(MIME).find(([, t]) => t === type);
    if (hit) return hit[0];
  }
  return "";
}

/** Types that can execute script when opened; never render these inline. */
export function isActiveContent(type: string): boolean {
  return /html|svg|xml|javascript/i.test(type);
}

const CURRENCY_SYMBOLS: Record<string, string> = { $: "USD", "€": "EUR", "£": "GBP", "¥": "JPY" };

/** Parses "325", "$1,850", "99.50 EUR". Returns null when the input isn't an amount. */
export function parseAmount(input: string): Amount | null {
  const m = /^\s*([$€£¥])?\s*(-?[\d,]*\.?\d+)\s*([a-z]{3})?\s*$/i.exec(input);
  if (!m) return null;
  const value = Number(m[2].replace(/,/g, ""));
  if (!Number.isFinite(value)) return null;
  return { value, currency: (m[3] ?? (m[1] ? CURRENCY_SYMBOLS[m[1]] : "USD")).toUpperCase() };
}
