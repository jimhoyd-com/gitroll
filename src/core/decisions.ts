// DECISIONS. What was decided, and whether it still stands: the choice of a
// database, a rule for the house, which plan the family is on. An event or a
// note is a decision when its front matter says so, with the statuses MADR
// (Markdown Architectural Decision Records) uses:
//
//   decision: accepted    (or decision: true)  in force
//   decision: proposed                         not decided yet
//   decision: rejected                         considered, and turned down
//   decision: deprecated                       no longer in force, with nothing in its place
//   superseded: 2026-10-14                     replaced, on that day (or true)
//
// A later decision replaces an earlier one by linking to it, the way an issue
// is resolved by the event that `resolves:` it:
//
//   supersedes: "[Keep backups on the NAS](2025-03-01-backups-on-the-nas.md)"
//
// That link is read the other way round, like a backlink, so nothing is
// written on the decision that was replaced. Only an accepted decision
// replaces another: a proposal doesn't, until it is accepted.

import type { Entry } from "./entry.ts";
import { relativeLink } from "./entry.ts";
import { dateField, metaValue } from "./calendar.ts";
import type { Interaction } from "./contacts.ts";
import { fieldLink } from "./relations.ts";

export const DECISION_FIELD = "decision";
export const SUPERSEDED_FIELD = "superseded";
export const SUPERSEDES_FIELD = "supersedes";

export type DecisionStatus = "accepted" | "proposed" | "rejected" | "deprecated" | "superseded";
const WRITTEN = new Set(["accepted", "proposed", "rejected", "deprecated"]);

const isDocument = (e: Entry) => /^\.gitroll\/(events|notes)\//i.test(e.path);
const day = (s: string | null | undefined): string | null => (s ? s.slice(0, 10) : null);

/** The status a document's `decision:` field gives it, before anything that supersedes it is read; null when it isn't a decision. */
function writtenStatus(e: Entry): Exclude<DecisionStatus, "superseded"> | null {
  if (!isDocument(e)) return null;
  const v = metaValue(e.meta, DECISION_FIELD);
  if (v === true) return "accepted";
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  return WRITTEN.has(s) ? (s as Exclude<DecisionStatus, "superseded">) : null;
}

/** Whether a document is marked as a decision: `decision:` accepted, proposed, rejected, deprecated or true. */
export const isDecision = (e: Entry): boolean => writtenStatus(e) !== null;

/** The documents a decision's `supersedes:` links to: one link, or a list of them. */
export function supersedesLinks(e: Entry): string[] {
  const v = metaValue(e.meta, SUPERSEDES_FIELD);
  const out: string[] = [];
  for (const x of Array.isArray(v) ? v : [v]) {
    const to = fieldLink(e, x);
    if (to && to !== e.path && !out.includes(to)) out.push(to);
  }
  return out;
}

/** The `supersedes:` value a decision at `from` writes for an earlier one: a Markdown link, relative to it. */
export function supersedesValue(from: string, earlier: Entry): string {
  const text = earlier.title.replace(/[[\]]/g, "").trim() || "decision";
  return `[${text}](${relativeLink(from, earlier.path).replace(/^\.\//, "")})`;
}

/** `superseded:` on the decision itself: null when it says nothing; otherwise the day it gives, if it gives one. */
function supersededField(e: Entry): { date: string | null } | null {
  const v = metaValue(e.meta, SUPERSEDED_FIELD);
  if (v == null || v === "" || v === false || (Array.isArray(v) && !v.length)) return null;
  return { date: day(dateField(v)) };
}

export interface Decision {
  path: string;
  title: string;
  kind: "event" | "note";
  /** The day it was written down: the document's date. A note has none. */
  date: string | null;
  status: DecisionStatus;
  /** Earlier decisions this one's `supersedes:` links to. */
  supersedes: { path: string; title: string }[];
  /** Accepted decisions whose `supersedes:` links to this one, oldest first. */
  supersededBy: Interaction[];
  /** The day it stopped being in force, when that is known: its `superseded:` date, or the earliest decision that replaced it. */
  superseded: string | null;
}

export interface Decisions {
  /** How many of the decisions read are in force (accepted and not replaced), proposed, and anything else. */
  current: number;
  proposed: number;
  other: number;
  decisions: Decision[];
}

/** Every decision's replacements, worked out once: decision path → accepted decisions that supersede it. */
function replacementsOf(docs: Entry[]): Map<string, Entry[]> {
  const out = new Map<string, Entry[]>();
  for (const d of docs) {
    if (writtenStatus(d) !== "accepted") continue;
    for (const to of supersedesLinks(d)) {
      const list = out.get(to);
      if (list) list.push(d);
      else out.set(to, [d]);
    }
  }
  return out;
}

function readDecision(e: Entry, byPath: Map<string, Entry>, replacements: Map<string, Entry[]>): Decision {
  const written = writtenStatus(e)!;
  const supersededBy = (replacements.get(e.path) ?? [])
    .map((d) => ({ path: d.path, title: d.title, date: d.date }))
    .sort((a, b) => (a.date ?? "￿").localeCompare(b.date ?? "￿") || a.path.localeCompare(b.path));
  const field = supersededField(e);
  // A rejected decision stays rejected: replacing it is meaningless.
  const replaced = written !== "rejected" && (!!field || supersededBy.length > 0);
  const days = [field?.date ?? null, ...supersededBy.map((r) => day(r.date))].filter((d): d is string => !!d).sort();
  return {
    path: e.path,
    title: e.title,
    kind: /^\.gitroll\/notes\//i.test(e.path) ? "note" : "event",
    date: day(e.date),
    status: replaced ? "superseded" : written,
    supersedes: supersedesLinks(e).map((p) => ({ path: p, title: byPath.get(p)?.title ?? p })),
    supersededBy,
    superseded: replaced ? (days[0] ?? null) : null,
  };
}

/** One document read as a decision, or null when it isn't marked as one. `docs` is every document, to find what replaced it. */
export function decisionOf(e: Entry, docs: Entry[]): Decision | null {
  return isDecision(e) ? readDecision(e, new Map(docs.map((d) => [d.path, d])), replacementsOf(docs)) : null;
}

const IN_VIEW: DecisionStatus[] = ["accepted", "proposed"];

/**
 * The decisions among `candidates` (every document, or a search of them),
 * newest first; those in force and those proposed unless `all`. `docs` is every
 * document, so what replaced a decision is found wherever it is.
 */
export function decisions(candidates: Entry[], docs: Entry[], opts: { all?: boolean } = {}): Decisions {
  const byPath = new Map(docs.map((d) => [d.path, d]));
  const replacements = replacementsOf(docs);
  const read = candidates.filter(isDecision).map((e) => readDecision(e, byPath, replacements));
  const current = read.filter((d) => d.status === "accepted").length;
  const proposed = read.filter((d) => d.status === "proposed").length;
  const listed = opts.all ? read : read.filter((d) => IN_VIEW.includes(d.status));
  listed.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "") || a.title.localeCompare(b.title));
  return { current, proposed, other: read.length - current - proposed, decisions: listed };
}
