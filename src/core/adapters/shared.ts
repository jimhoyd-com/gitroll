// What every import needs: reading somebody else's JSON without trusting its
// shape, and deciding which of it is worth logging.
//
// Filtering belongs here rather than in the CLI because only an adapter knows
// where a date or a branch lives in its own payload, and every adapter should
// answer `--since` and `--branch` the same way once it has found them.

import type { AdapterContext, EventDraft } from "../adapter.ts";
import { AdapterError } from "../adapter.ts";
import { normalizeTag } from "../entry.ts";

export const isMapping = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export const str = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");

export const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export const strs = (v: unknown): string[] =>
  (Array.isArray(v) ? v.map(str) : str(v) ? str(v).split(",") : []).map((s) => s.trim()).filter(Boolean);

/** One thing, a list of things, or nothing. */
export const asList = (input: unknown): unknown[] => (Array.isArray(input) ? input : input == null ? [] : [input]);

export function truncate(text: string, max: number): string {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const end = Math.max(cut.lastIndexOf("\n\n"), cut.lastIndexOf(". "));
  return `${cut.slice(0, end > max / 2 ? end : max).trimEnd()}\n\n…(shortened; the rest is at the link)`;
}

/**
 * Somebody else's prose, quoted, so it can't be mistaken for the event's own
 * words and its headings can't outrank the event's.
 */
export const quote = (text: string): string =>
  text.trim()
    ? text
        .trim()
        .split("\n")
        .map((line) => (line.trim() ? `> ${line}` : ">"))
        .join("\n")
    : "";

/** Facts an import knows that the event itself doesn't record. Used to filter, then dropped. */
export interface DraftFacts {
  author?: string;
  labels?: string[];
  branch?: string;
  /** For anything that succeeds or fails: "success", "failure", "cancelled"… */
  status?: string;
}

export interface FactualDraft extends EventDraft {
  facts?: DraftFacts;
}

export interface Filters {
  since?: string;
  until?: string;
  branch?: string[];
  author?: string[];
  label?: string[];
  status?: string[];
  limit?: number;
}

const day = (value: string, what: string): string => {
  const v = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(v)) throw new AdapterError(`--${what} takes a date like 2026-09-01. Not: ${value}`);
  return v.slice(0, 10);
};

/** The filters a person asked for, from the command line or a caller. */
export function readFilters(ctx: AdapterContext): Filters {
  const limit = ctx.options.limit ? Number(ctx.options.limit) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new AdapterError(`--limit takes a whole number. Not: ${ctx.options.limit}`);
  return {
    since: ctx.options.since ? day(ctx.options.since, "since") : undefined,
    until: ctx.options.until ? day(ctx.options.until, "until") : undefined,
    branch: strs(ctx.options.branch).map((b) => b.toLowerCase()),
    author: strs(ctx.options.author).map((a) => a.replace(/^@/, "").toLowerCase()),
    label: strs(ctx.options.label).map((l) => normalizeTag(l)),
    status: strs(ctx.options.status).map((s) => s.toLowerCase()),
    limit,
  };
}

const has = (list: string[] | undefined): list is string[] => !!list && list.length > 0;

/** Whether a draft is one of the things asked for. Dates are compared as calendar days. */
export function matchesFilters(draft: FactualDraft, filters: Filters): boolean {
  const facts = draft.facts ?? {};
  const date = (draft.date ?? "").slice(0, 10);
  if (filters.since && (!date || date < filters.since)) return false;
  if (filters.until && (!date || date > filters.until)) return false;
  if (has(filters.branch) && !filters.branch.includes((facts.branch ?? "").toLowerCase())) return false;
  if (has(filters.author) && !filters.author.includes((facts.author ?? "").replace(/^@/, "").toLowerCase())) return false;
  if (has(filters.label)) {
    const labels = (facts.labels ?? []).map((l) => normalizeTag(l));
    if (!filters.label.some((wanted) => labels.includes(wanted))) return false;
  }
  if (has(filters.status) && !filters.status.includes(String(facts.status ?? "").toLowerCase())) return false;
  return true;
}

/** Newest first, by the date the event will carry. */
export const newestFirst = <T extends EventDraft>(drafts: T[]): T[] =>
  [...drafts].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
