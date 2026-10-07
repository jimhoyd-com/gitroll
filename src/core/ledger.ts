// LEDGER. Totals of what things cost, read from files that already exist.
//
// This is a view, never accounting. An event's `amount` (with `currency`) and a
// record's `price` (with schema.org's `priceCurrency`) are added up per currency
// — amounts in different currencies are never added together or converted — and
// can be grouped by month, year, project, tag or any field. `toHledger` writes
// the same entries as a plain-text accounting journal (hledger and Ledger read
// it), so GitRoll stays a source of transactions and the accounting happens in
// a tool built for it.

import type { Amount, Entry } from "./entry.ts";
import { fieldValue } from "./fields.ts";
import { metaValue } from "./calendar.ts";
import { formatAmount, parseAmount } from "./util.ts";

export interface LedgerEntry {
  /** YYYY-MM-DD, or null when nothing dates it. */
  date: string | null;
  title: string;
  path: string;
  amount: Amount;
  /** Which field it came from. */
  field: "amount" | "price";
  projects: string[];
  tags: string[];
}

export interface CurrencyTotal {
  currency: string;
  total: number;
  count: number;
}

export interface LedgerGroup {
  key: string;
  totals: CurrencyTotal[];
  count: number;
}

const DAY = /^\d{4}-\d{2}-\d{2}/;

const day = (v: unknown): string | null => {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  return typeof v === "string" && DAY.test(v.trim()) ? v.trim().slice(0, 10) : null;
};

/** A record's `price`: a number with `priceCurrency` (or `currency`), money text like $12.50 or 12.50 EUR, or {value, currency}. */
export function priceOf(meta: Record<string, unknown>): Amount | null {
  const raw = metaValue(meta, "price");
  const code = metaValue(meta, "priceCurrency") ?? metaValue(meta, "currency");
  const currency = typeof code === "string" && /^[A-Za-z]{3}$/.test(code.trim()) ? code.trim().toUpperCase() : null;
  if (typeof raw === "number") return Number.isFinite(raw) ? { value: raw, currency: currency ?? "USD" } : null;
  if (typeof raw === "string") {
    const parsed = parseAmount(raw);
    if (!parsed) return null;
    // A bare number takes priceCurrency; one written with a sign or a code says its own.
    const explicit = /[$€£¥]|[A-Za-z]{3}\s*$/.test(raw.trim());
    return { value: parsed.value, currency: explicit ? parsed.currency : (currency ?? parsed.currency) };
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    const value = Number(o.value);
    if (!Number.isFinite(value)) return null;
    const c = typeof o.currency === "string" && o.currency.trim() ? o.currency.trim().toUpperCase().slice(0, 3) : (currency ?? "USD");
    return { value, currency: c };
  }
  return null;
}

/** What each document cost: its `amount`, or else its `price`. A document with neither isn't in the ledger. */
export function ledgerEntries(docs: Entry[]): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  for (const e of docs) {
    const price = e.amount ? null : priceOf(e.meta);
    const amount = e.amount ?? price;
    if (!amount) continue;
    const date = e.amount ? day(e.date) : (day(metaValue(e.meta, "purchaseDate")) ?? day(e.date));
    out.push({ date, title: e.title, path: e.path, amount, field: e.amount ? "amount" : "price", projects: e.projects, tags: e.tags });
  }
  return out.sort((a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999") || a.path.localeCompare(b.path));
}

/** Adds amounts up per currency, never across currencies. */
export function totalsByCurrency(amounts: Amount[]): CurrencyTotal[] {
  const by = new Map<string, CurrencyTotal>();
  for (const a of amounts) {
    const t = by.get(a.currency) ?? { currency: a.currency, total: 0, count: 0 };
    // Summed in hundredths and back, so 0.1 + 0.2 is 0.3 in a total of money.
    t.total = Math.round((t.total + a.value) * 1e6) / 1e6;
    t.count++;
    by.set(a.currency, t);
  }
  return [...by.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

const textOf = (v: unknown): string => (v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === "object" && v ? JSON.stringify(v) : String(v));

/** The groups one entry belongs to: one for a month, year or field; one per project or tag (so those groups can overlap). */
function keysOf(e: LedgerEntry, by: string, doc: Entry | undefined): string[] {
  switch (by.toLowerCase()) {
    case "month":
      return [e.date ? e.date.slice(0, 7) : "undated"];
    case "year":
      return [e.date ? e.date.slice(0, 4) : "undated"];
    case "project":
    case "projects":
      return e.projects.length ? e.projects : ["(none)"];
    case "tag":
    case "tags":
      return e.tags.length ? e.tags : ["(none)"];
  }
  const v = doc ? fieldValue(doc, by) : undefined;
  if (v == null || v === "") return ["(none)"];
  return Array.isArray(v) ? (v.length ? v.map(textOf) : ["(none)"]) : [textOf(v)];
}

export interface Ledger {
  by: string | null;
  totals: CurrencyTotal[];
  groups: LedgerGroup[];
  entries: LedgerEntry[];
}

/** Totals per currency, overall and (with `by`) per group. Groups by project or tag can overlap, since an entry can have several. */
export function ledger(docs: Entry[], by?: string): Ledger {
  const entries = ledgerEntries(docs);
  const docOf = new Map(docs.map((d) => [d.path, d]));
  const groups = new Map<string, LedgerEntry[]>();
  if (by) {
    for (const e of entries) {
      for (const key of keysOf(e, by, docOf.get(e.path))) groups.set(key, [...(groups.get(key) ?? []), e]);
    }
  }
  const timeLike = by && ["month", "year"].includes(by.toLowerCase());
  const keys = [...groups.keys()].sort((a, b) => {
    const special = (k: string) => (k === "undated" || k === "(none)" ? 1 : 0);
    return special(a) - special(b) || (timeLike ? a.localeCompare(b) : a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));
  });
  return {
    by: by ?? null,
    totals: totalsByCurrency(entries.map((e) => e.amount)),
    groups: keys.map((key) => ({ key, totals: totalsByCurrency(groups.get(key)!.map((e) => e.amount)), count: groups.get(key)!.length })),
    entries,
  };
}

export const formatTotals = (totals: CurrencyTotal[]): string => totals.map((t) => formatAmount({ value: t.total, currency: t.currency })).join(" · ") || "nothing";

/** An account name hledger and Ledger both accept: no double spaces, tabs, semicolons or colons inside a part. */
function accountPart(s: string): string {
  const joined = s.replace(/[\s:;]+/g, "-");
  let start = 0;
  let end = joined.length;
  while (start < end && joined[start] === "-") start++;
  while (end > start && joined[end - 1] === "-") end--;
  return joined.slice(start, end) || "unknown";
}

/** A description on one line, with nothing a journal would read as a comment. */
function description(s: string): string {
  return s.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/;/g, ",").replace(/ {2,}/g, " ").trim() || "(untitled)";
}

const number = (n: number): string => {
  const s = String(Math.round(n * 1e6) / 1e6);
  return s.includes("e") ? n.toFixed(2) : s;
};

/**
 * The entries as an hledger / Ledger journal: one transaction each, its
 * expense posted to `expenses:<project or tag>` and balanced by `assets:unknown`
 * (GitRoll doesn't know what paid for it). Undated entries can't be journal
 * transactions; they're listed in a comment at the end.
 */
export function toHledger(entries: LedgerEntry[]): string {
  const out = ["; Transactions from a GitRoll log. GitRoll is the source of these, not an accounting system:", "; check the accounts before you rely on the balances.", ""];
  const undated: LedgerEntry[] = [];
  for (const e of entries) {
    if (!e.date) {
      undated.push(e);
      continue;
    }
    const account = `expenses:${accountPart(e.projects[0] ?? e.tags[0] ?? "unknown")}`;
    out.push(`${e.date} ${description(e.title)}`, `    ; source: ${description(e.path)}`, `    ${account}  ${number(e.amount.value)} ${e.amount.currency}`, "    assets:unknown", "");
  }
  if (undated.length) {
    out.push("; Undated, so not in this journal:");
    for (const e of undated) out.push(`;   ${description(e.title)}  ${number(e.amount.value)} ${e.amount.currency}  (${description(e.path)})`);
    out.push("");
  }
  return out.join("\n");
}
