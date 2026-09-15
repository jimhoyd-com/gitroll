// Merges two versions of the same event when it was edited in two places.
// Nothing is ever dropped: if both sides changed the same thing differently,
// this device's version wins and the other version is kept in a note at the
// bottom of the event, tagged #conflict so it's easy to find and tidy up.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEntry, serializeEntry } from "../core/entry.ts";
import type { Attachment, Entry } from "../core/entry.ts";
import { isoLocal, uniq } from "../core/util.ts";

export const CONFLICT_TAG = "conflict";

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const show = (v: unknown) => (v === undefined || v === null ? "(empty)" : typeof v === "object" ? JSON.stringify(v) : String(v));

function pick<T>(base: T | undefined, mine: T, theirs: T, label: string, notes: string[]): T {
  if (same(mine, theirs) || same(base, theirs)) return mine;
  if (same(base, mine)) return theirs;
  notes.push(`${label}: ${show(theirs)}`);
  return mine;
}

/** Keeps additions from both sides and honours removals from either side. */
function mergeList(base: string[] = [], mine: string[], theirs: string[]): string[] {
  const removed = new Set(base.filter((x) => !mine.includes(x) || !theirs.includes(x)));
  return uniq([...mine, ...theirs]).filter((x) => !removed.has(x));
}

function mergeAttachments(base: Attachment[] = [], mine: Attachment[], theirs: Attachment[]): Attachment[] {
  const all = new Map([...theirs, ...mine].map((a) => [a.hash, a]));
  const kept = mergeList(base.map((a) => a.hash), mine.map((a) => a.hash), theirs.map((a) => a.hash));
  return kept.map((hash) => all.get(hash)!);
}

function mergeRecord(base: Record<string, unknown>, mine: Record<string, unknown>, theirs: Record<string, unknown>, prefix: string, notes: string[]) {
  const out: Record<string, unknown> = {};
  for (const key of uniq([...Object.keys(mine), ...Object.keys(theirs)])) {
    const value = pick(base[key], mine[key], theirs[key], `${prefix}${key}`, notes);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function mergeText(base: string, mine: string, theirs: string, notes: string[]): string {
  if (mine === theirs || theirs === base) return mine;
  if (mine === base) return theirs;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gitroll-merge-"));
  try {
    const files = { mine: path.join(dir, "mine"), base: path.join(dir, "base"), theirs: path.join(dir, "theirs") };
    fs.writeFileSync(files.mine, `${mine}\n`);
    fs.writeFileSync(files.base, `${base}\n`);
    fs.writeFileSync(files.theirs, `${theirs}\n`);
    try {
      return execFileSync("git", ["merge-file", "-p", files.mine, files.base, files.theirs], { encoding: "utf8" }).trimEnd();
    } catch (e) {
      const status = (e as { status?: number }).status ?? 0;
      if (status <= 0 || status >= 128) throw e;
      notes.push(`text:\n\n${theirs}`); // overlapping edits: keep both
      return mine;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Three-way merge of an event file. `base` is null when both sides created it. */
export function mergeEntry(baseSource: string | null, mineSource: string, theirsSource: string): { text: string; conflicted: boolean } {
  const mine = parseEntry(mineSource);
  const theirs = parseEntry(theirsSource);
  let base: Entry | null = null;
  try {
    base = baseSource ? parseEntry(baseSource) : null;
  } catch {
    base = null;
  }
  const notes: string[] = [];
  const merged: Entry = {
    ...mine,
    type: pick(base?.type, mine.type, theirs.type, "type", notes),
    occurred: pick(base?.occurred, mine.occurred, theirs.occurred, "when", notes),
    projects: mergeList(base?.projects, mine.projects, theirs.projects),
    tags: mergeList(base?.tags, mine.tags, theirs.tags),
    attachments: mergeAttachments(base?.attachments, mine.attachments, theirs.attachments),
    data: mergeRecord(base?.data ?? {}, mine.data, theirs.data, "", notes),
    extra: mergeRecord(base?.extra ?? {}, mine.extra, theirs.extra, "", notes),
    body: mergeText(base?.body ?? "", mine.body, theirs.body, notes),
  };
  const amount = pick(base?.amount, mine.amount, theirs.amount, "amount", notes);
  if (amount) merged.amount = amount;
  else delete merged.amount;

  if (notes.length) {
    merged.tags = uniq([...merged.tags, CONFLICT_TAG]);
    merged.body = [
      merged.body,
      "---",
      `**Sync note (${isoLocal().slice(0, 10)}):** this event was also changed on another device. The other version had:`,
      notes.map((n) => `- ${n.replace(/\n/g, "\n  ")}`).join("\n"),
    ].join("\n\n");
  }
  return { text: serializeEntry(merged), conflicted: notes.length > 0 };
}
