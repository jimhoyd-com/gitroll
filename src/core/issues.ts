// ISSUES. Something that went wrong and stays open until it is dealt with —
// the car making a noise, a leak under the sink, a bug — is an event or a
// note marked in its front matter:
//
//   issue: open        (or issue: true)  it is an issue, open until resolved
//   resolved: 2026-10-07                 resolved, on that day (or true)
//
// It is also resolved by a later event that says so, with a front matter link
// to it, the way a pull request says "Resolves #12":
//
//   resolves: "[Clunk from the front wheel](2026-09-30-clunk.md)"
//
// That second way is read the other way round, like a backlink: nothing is
// written on the issue, so the history of what fixed it stays in the event
// that fixed it. Every event that links to an issue, in its text or its front
// matter, is the issue's activity.

import type { Entry } from "./entry.ts";
import { relativeLink } from "./entry.ts";
import { dateField, metaValue } from "./calendar.ts";
import type { Interaction } from "./contacts.ts";
import { eventsLinking, incomingLinks } from "./organizations.ts";
import { fieldLink } from "./relations.ts";

export const ISSUE_FIELD = "issue";
export const RESOLVED_FIELD = "resolved";
export const RESOLVES_FIELD = "resolves";

const isEvent = (e: Entry) => e.path.toLowerCase().startsWith(".gitroll/events/");
const isNote = (e: Entry) => e.path.toLowerCase().startsWith(".gitroll/notes/");
const day = (s: string | null | undefined): string | null => (s ? s.slice(0, 10) : null);

/** Whether a document is marked as an issue: `issue: open` or `issue: true`. */
export function isIssue(e: Entry): boolean {
  if (!isEvent(e) && !isNote(e)) return false;
  const v = metaValue(e.meta, ISSUE_FIELD);
  return v === true || (typeof v === "string" && v.trim().toLowerCase() === "open");
}

/** `resolved:` on the issue itself: null when it says nothing; otherwise the day it gives, if it gives one. */
function resolvedField(e: Entry): { date: string | null } | null {
  const v = metaValue(e.meta, RESOLVED_FIELD);
  if (v == null || v === "" || v === false || (Array.isArray(v) && !v.length)) return null;
  return { date: day(dateField(v)) };
}

/** The documents a document's `resolves:` links to: one link, or a list of them. */
export function resolvesLinks(e: Entry): string[] {
  const v = metaValue(e.meta, RESOLVES_FIELD);
  const out: string[] = [];
  for (const x of Array.isArray(v) ? v : [v]) {
    const to = fieldLink(e, x);
    if (to && to !== e.path && !out.includes(to)) out.push(to);
  }
  return out;
}

/** The `resolves:` value an event at `from` writes for an issue: a Markdown link, relative to the event. */
export function resolvesValue(from: string, issue: Entry): string {
  const text = issue.title.replace(/[[\]]/g, "").trim() || "issue";
  return `[${text}](${relativeLink(from, issue.path).replace(/^\.\//, "")})`;
}

/** Whole days from one day to another. */
function daysBetween(from: string, to: string): number {
  const at = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
  return Math.round((at(to) - at(from)) / 86_400_000);
}

export type IssueStatus = "open" | "resolved";

export interface Issue {
  path: string;
  title: string;
  kind: "event" | "note";
  /** The day it was written down: the document's date. A note has none. */
  opened: string | null;
  status: IssueStatus;
  /** The day it was resolved, when that is known: the earliest of its `resolved:` date and the events that resolve it. */
  resolved: string | null;
  /** Events whose `resolves:` links to it, oldest first. */
  resolvedBy: Interaction[];
  /** Whole days it has been open: to today, or to the day it was resolved. Null when either day isn't known. */
  age: number | null;
  /** Events that link to it, in their text or their front matter, newest first. */
  activity: Interaction[];
  /** The newest of the day it was opened and its activity. */
  lastActivity: string | null;
}

export interface Issues {
  /** How many of the issues read are open, and how many resolved, whichever were listed. */
  open: number;
  resolved: number;
  issues: Issue[];
}

/** Every document's resolvers, worked out once: issue path → events that resolve it. */
function resolversOf(docs: Entry[]): Map<string, Entry[]> {
  const out = new Map<string, Entry[]>();
  for (const d of docs) {
    if (!isEvent(d)) continue;
    for (const to of resolvesLinks(d)) {
      const list = out.get(to);
      if (list) list.push(d);
      else out.set(to, [d]);
    }
  }
  return out;
}

function readIssue(e: Entry, into: Map<string, Entry[]>, resolvers: Map<string, Entry[]>, today: string): Issue {
  const resolvedBy = (resolvers.get(e.path) ?? [])
    .map((d) => ({ path: d.path, title: d.title, date: d.date }))
    .sort((a, b) => (a.date ?? "￿").localeCompare(b.date ?? "￿") || a.path.localeCompare(b.path));
  const field = resolvedField(e);
  const status: IssueStatus = field || resolvedBy.length ? "resolved" : "open";
  const days = [field?.date ?? null, ...resolvedBy.map((r) => day(r.date))].filter((d): d is string => !!d).sort();
  const resolved = days[0] ?? null;
  const opened = day(e.date);
  const until = status === "open" ? today : resolved;
  const activity = eventsLinking(e.path, into);
  const latest = [e.date, ...activity.map((a) => a.date)].filter((d): d is string => !!d).sort().pop() ?? null;
  return {
    path: e.path,
    title: e.title,
    kind: isNote(e) ? "note" : "event",
    opened,
    status,
    resolved,
    resolvedBy,
    age: opened && until ? Math.max(0, daysBetween(opened, until)) : null,
    activity,
    lastActivity: day(latest),
  };
}

/** One document read as an issue, or null when it isn't marked as one. `docs` is every document, to find what resolves it. */
export function issueOf(e: Entry, docs: Entry[], today: string): Issue | null {
  return isIssue(e) ? readIssue(e, incomingLinks(docs), resolversOf(docs), today) : null;
}

/**
 * The issues among `candidates` (every document, or a search of them), newest
 * activity first; open ones only unless `all`. `docs` is every document, so
 * what resolves an issue and what links to it are found wherever they are.
 */
export function issues(candidates: Entry[], docs: Entry[], today: string, opts: { all?: boolean } = {}): Issues {
  const into = incomingLinks(docs);
  const resolvers = resolversOf(docs);
  const read = candidates.filter(isIssue).map((e) => readIssue(e, into, resolvers, today));
  const open = read.filter((i) => i.status === "open").length;
  const listed = opts.all ? read : read.filter((i) => i.status === "open");
  listed.sort((a, b) => {
    if (!a.lastActivity || !b.lastActivity) return a.lastActivity ? -1 : b.lastActivity ? 1 : a.path.localeCompare(b.path);
    return b.lastActivity.localeCompare(a.lastActivity) || a.title.localeCompare(b.title);
  });
  return { open, resolved: read.length - open, issues: listed };
}
