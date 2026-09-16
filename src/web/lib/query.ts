/*
  The search query is a single string, and that string is the only state.

  The old interface kept two: a list of filter chips and whatever was typed in
  the box, then glued them together on every keystroke. So a chip and a typed
  `has:attachment` could disagree about the same filter. Here a chip is just a
  view of a token in the query, and toggling one edits the string.

  The grammar is already implemented in src/core/search.ts. This file only adds
  what the interface needs on top of it: suggesting keys and values as you type,
  and adding or removing one token without disturbing the rest.
*/

import { canonicalKey, serialize, tokenize } from "../../core/search.ts";
import type { Token } from "../../core/search.ts";
import { localDay } from "./format.ts";

export interface Suggestion {
  /** The full token inserted when this is chosen, e.g. `has:photo`. */
  insert: string;
  label: string;
  hint?: string;
  group: string;
}

export interface SuggestContext {
  tags: string[];
}

/** Keys someone can filter on, in the order they are most often wanted. */
export const FILTER_KEYS: { key: string; hint: string; example: string }[] = [
  { key: "topic", hint: "Events in a topic", example: "topic:house" },
  { key: "tag", hint: "Events with a tag", example: "tag:plumbing" },
  { key: "has", hint: "Events with a photo, file or amount", example: "has:photo" },
  { key: "after", hint: "On or after a date", example: "after:2026-01-01" },
  { key: "before", hint: "On or before a date", example: "before:2026-06-30" },
  { key: "on", hint: "A single day, month or year", example: "on:2026-09" },
  { key: "amount", hint: "More or less than an amount", example: "amount:>500" },
];

export const HAS_VALUES = [
  { value: "photo", hint: "A picture" },
  { value: "file", hint: "Any attachment" },
  { value: "receipt", hint: "A receipt or a paid expense" },
  { value: "pdf", hint: "A PDF" },
  { value: "amount", hint: "Money attached" },
];

/** The token being typed at the caret, so suggestions can follow it. */
export function tokenAtCaret(value: string, caret: number): { start: number; end: number; text: string } {
  let start = caret;
  while (start > 0 && !/\s/.test(value[start - 1])) start--;
  let end = caret;
  while (end < value.length && !/\s/.test(value[end])) end++;
  return { start, end, text: value.slice(start, end) };
}

/** Replaces the token under the caret, leaving a trailing space to type on. */
export function replaceTokenAtCaret(value: string, caret: number, insert: string): { value: string; caret: number } {
  const { start, end } = tokenAtCaret(value, caret);
  const before = value.slice(0, start);
  const after = value.slice(end);
  const needsSpace = after.length > 0 && !after.startsWith(" ");
  const next = `${before}${insert}${needsSpace ? " " : ""}${after}`;
  return { value: next, caret: before.length + insert.length + (needsSpace ? 1 : 0) };
}

const quoted = (v: string) => (/[\s"]/.test(v) ? `"${v.replace(/"/g, "")}"` : v);

/** Suggestions for what is being typed right now. */
export function suggest(fragment: string, ctx: SuggestContext): Suggestion[] {
  const text = fragment.trim();
  const colon = text.indexOf(":");

  // Still choosing a key: offer keys, plus the handful of ready-made filters.
  if (colon < 0) {
    const lower = text.toLowerCase();
    const keys = FILTER_KEYS.filter((k) => !lower || k.key.startsWith(lower)).map((k) => ({
      insert: `${k.key}:`,
      label: `${k.key}:`,
      hint: k.hint,
      group: "Filter by",
    }));
    const shortcuts = lower
      ? []
      : datePresets().map((p) => ({ insert: p.insert, label: p.label, hint: p.hint, group: "When" }));
    return [...keys, ...shortcuts];
  }

  const key = canonicalKey(text.slice(0, colon));
  const partial = text.slice(colon + 1).toLowerCase().replace(/^"|"$/g, "");
  const match = (s: string) => !partial || s.toLowerCase().includes(partial);
  const raw = text.slice(0, colon);

  switch (key) {
    case "tag":
      return ctx.tags.filter(match).map((t) => ({ insert: `${raw}:${quoted(t)}`, label: `#${t}`, group: "Tag" }));
    case "has":
      return HAS_VALUES.filter((h) => match(h.value)).map((h) => ({
        insert: `${raw}:${h.value}`,
        label: `has:${h.value}`,
        hint: h.hint,
        group: "Has",
      }));
    case "after":
    case "before":
    case "on":
      return dateValues(raw, key).filter((s) => match(s.label));
    case "amount":
      return [
        { insert: `${raw}:>100`, label: "more than 100", group: "Amount" },
        { insert: `${raw}:<100`, label: "less than 100", group: "Amount" },
        { insert: `${raw}:=100`, label: "exactly 100", group: "Amount" },
      ];
    default:
      return [];
  }
}

function datePresets(): { insert: string; label: string; hint: string }[] {
  const now = new Date();
  const y = now.getFullYear();
  const p = (n: number) => String(n).padStart(2, "0");
  const weekAgo = new Date(now);
  weekAgo.setDate(now.getDate() - 7);
  return [
    { insert: `on:${localDay(now)}`, label: "Today", hint: `on:${localDay(now)}` },
    { insert: `after:${localDay(weekAgo)}`, label: "Past 7 days", hint: `after:${localDay(weekAgo)}` },
    { insert: `on:${y}-${p(now.getMonth() + 1)}`, label: "This month", hint: `on:${y}-${p(now.getMonth() + 1)}` },
    { insert: `on:${y}`, label: "This year", hint: `on:${y}` },
  ];
}

function dateValues(raw: string, key: string): Suggestion[] {
  const now = new Date();
  const y = now.getFullYear();
  const p = (n: number) => String(n).padStart(2, "0");
  const out: Suggestion[] = [];
  const add = (value: string, label: string) => out.push({ insert: `${raw}:${value}`, label, hint: value, group: "When" });
  if (key === "on") {
    add(localDay(now), "Today");
    add(`${y}-${p(now.getMonth() + 1)}`, "This month");
    add(String(y), "This year");
    add(String(y - 1), "Last year");
  } else {
    const weekAgo = new Date(now);
    weekAgo.setDate(now.getDate() - 7);
    const monthStart = `${y}-${p(now.getMonth() + 1)}-01`;
    add(localDay(now), "Today");
    add(localDay(weekAgo), "A week ago");
    add(monthStart, "Start of this month");
    add(`${y}-01-01`, "Start of this year");
  }
  return out;
}

/** Tokens that are filters, in query order. Plain words are not filters. */
export const filterTokens = (query: string): Token[] => tokenize(query).filter((t) => !!t.key);

const sameToken = (a: Token, key: string, value: string) =>
  a.key === canonicalKey(key) && a.value.toLowerCase() === value.toLowerCase();

/** Adds a filter if missing, removes it if present. Leaves typed words alone. */
export function toggleFilter(query: string, key: string, value: string): string {
  const tokens = tokenize(query);
  const i = tokens.findIndex((t) => t.key && sameToken(t, key, value));
  if (i >= 0) tokens.splice(i, 1);
  else tokens.push({ key: canonicalKey(key), value });
  return serialize(tokens);
}

export function hasFilter(query: string, key: string, value: string): boolean {
  return tokenize(query).some((t) => t.key && sameToken(t, key, value));
}

/** Drops every token with these keys. Used when a date preset replaces another. */
export function withoutKeys(query: string, keys: string[]): string {
  const drop = new Set(keys.map(canonicalKey));
  return serialize(tokenize(query).filter((t) => !t.key || !drop.has(t.key)));
}

export function removeToken(query: string, token: Token): string {
  const tokens = tokenize(query);
  const i = tokens.findIndex((t) => t.key === token.key && t.value === token.value);
  if (i >= 0) tokens.splice(i, 1);
  return serialize(tokens);
}
