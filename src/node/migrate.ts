// Moving an existing Roll from one file per event to grouped monthly or daily
// files — explicitly, with a preview first, and safely if it is interrupted.
//
// Nothing is reinterpreted on the way. An event dated only by its file name
// (2026-09-15-ac-serviced.md) keeps that day exactly as it is: it is a day
// someone wrote, not midnight UTC, and reading it as an instant would move a
// third of a Roll across a date line. An event with a timestamp keeps the
// timestamp and is filed by the Roll's zone. Ids are derived from the event's
// path and content, so two clones migrating the same repository produce the
// same ids without talking to each other, and a link written before the
// migration still resolves afterwards through .gitroll/moved.yaml.

import { createHash } from "node:crypto";
import { parseEntry } from "../core/entry.ts";
import { derivedEntryId } from "../core/ids.ts";
import { EVENTS_DIR, EVENT_FILE } from "../core/layout.ts";
import { periodFor } from "../core/segments.ts";
import type { StorageMode } from "../core/segments.ts";
import { filingDateFor } from "../core/tz.ts";
import { UserError } from "../core/util.ts";
import { safeRead, safeRemove, walkFiles } from "./fs-safe.ts";
import { MOVED_PATH, readMoved, writeMoved } from "./store.ts";
import type { EntryStore } from "./store.ts";


export interface MigrationItem {
  from: string;
  id: string;
  /** The occurrence, exactly as the event already recorded it. */
  date: string | null;
  filed: string | null;
  period: string | null;
  /** The entry's text, front matter and all, as it will be stored. */
  content: string;
}

export interface MigrationPlan {
  mode: StorageMode;
  timezone: string;
  items: MigrationItem[];
  /** Events that can't be placed, e.g. undated ones. They stay where they are. */
  skipped: { path: string; reason: string }[];
  /** Events already migrated in an earlier, interrupted run. */
  alreadyDone: string[];
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** The id an existing event takes. Deterministic: same repository, same ids, on every clone. */
export const migrationId = (path: string, source: string): string => derivedEntryId(sha(`gitroll-migration-v1\n${path}\n${source}`));

/** Works out what a migration would do. Nothing is written. */
export function planMigration(store: EntryStore, mode: Exclude<StorageMode, "event">): MigrationPlan {
  const settings = store.settings();
  const tz = settings.timezone;
  const items: MigrationItem[] = [];
  const skipped: { path: string; reason: string }[] = [];
  const alreadyDone: string[] = [];
  store.scan();

  for (const rel of walkFiles(store.root, EVENTS_DIR).files.filter((f) => EVENT_FILE.test(f)).sort()) {
    const source = safeRead(store.root, rel).toString("utf8");
    const id = migrationId(rel, source);
    if (store.index.byId(id)) {
      alreadyDone.push(rel);
      continue;
    }
    let entry;
    try {
      entry = parseEntry(rel, source);
    } catch (e) {
      skipped.push({ path: rel, reason: (e as Error).message });
      continue;
    }
    // A day from the file name stays that day; only a real timestamp is read
    // through the Roll's zone.
    const filed = entry.date ? filingDateFor(entry.date, tz) : null;
    if (!filed) {
      skipped.push({ path: rel, reason: "undated: nothing says which period it belongs to" });
      continue;
    }
    items.push({ from: rel, id, date: entry.date, filed, period: periodFor(filed, mode), content: source });
  }
  return { mode, timezone: tz, items, skipped, alreadyDone };
}

export interface MigrationResult {
  moved: number;
  skipped: number;
  paths: string[];
}

/**
 * Carries out a plan, one filing period at a time: the entries of a period are
 * written, then their event files are removed, then the next period starts. An
 * interrupted run leaves whole periods done and the rest untouched, and running
 * it again picks up where it stopped — the ids it would assign are the ids it
 * already assigned.
 */
export function applyMigration(store: EntryStore, plan: MigrationPlan): MigrationResult {
  if (!plan.items.length) return { moved: 0, skipped: plan.skipped.length, paths: [] };
  const paths = new Set<string>();
  const byPeriod = new Map<string, MigrationItem[]>();
  for (const item of plan.items) {
    const list = byPeriod.get(item.period!) ?? [];
    list.push(item);
    byPeriod.set(item.period!, list);
  }
  const moved: Record<string, string> = readMoved(store);
  for (const [, items] of [...byPeriod].sort(([a], [b]) => a.localeCompare(b))) {
    const result = store.put(
      items.map((i) => ({ content: i.content, date: i.date, filed: i.filed ?? undefined, id: i.id })),
    );
    for (const p of result.paths) paths.add(p);
    for (const item of items) {
      safeRemove(store.root, item.from);
      paths.add(item.from);
      moved[item.from] = item.id;
    }
    writeMoved(store, moved);
    paths.add(MOVED_PATH);
  }
  return { moved: plan.items.length, skipped: plan.skipped.length, paths: [...paths] };
}

export function requireGroupedTarget(mode: string): Exclude<StorageMode, "event"> {
  if (mode !== "monthly" && mode !== "daily") throw new UserError(`Unknown storage mode: ${mode} (use monthly or daily)`);
  return mode;
}
