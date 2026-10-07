// Records and fields from the command line: `gitroll records`, `gitroll set`
// and `gitroll add`. Kept apart from cli.ts so that file only dispatches.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { FIELD_NAME, collections, columnsOf, parseAssignment, parseSort, recordRow, recordsIn, sortByFields } from "../core/fields.ts";
import type { Collection, FieldInput } from "../core/fields.ts";
import type { LoadedEntry } from "../core/layout.ts";
import { NOTES_DIR } from "../core/layout.ts";
import { SearchIndex } from "../core/search.ts";
import { SEALED_PLACEHOLDER } from "../core/sealed.ts";
import { ConflictError, NotFoundError } from "../core/util.ts";
import { CliError } from "./cli-contract.ts";
import type { GitRoll, SaveResult } from "./repo.ts";
import { maskEntry } from "./sealing.ts";

type Values = Record<string, string | boolean | string[] | undefined>;

/** Sorts by `--sort`, when there is one. */
export function sortedBy<T extends LoadedEntry>(entries: T[], spec: string | undefined): T[] {
  if (spec === undefined) return entries;
  try {
    return sortByFields(entries, parseSort(spec));
  } catch (e) {
    throw new CliError("INVALID_ARGUMENT", (e as Error).message);
  }
}

export interface RecordTable {
  collection: string;
  description: string | null;
  columns: string[];
  total: number;
  records: { path: string; title: string; fields: Record<string, unknown> }[];
}

/** `gitroll records`: every collection with how many records it holds. */
export function listCollections(roll: GitRoll): Collection[] {
  return collections(roll.notes());
}

/** `gitroll records <collection> [query]`: its records as rows, filtered, sorted and paged. */
export function recordTable(roll: GitRoll, name: string, query: string, values: Values): RecordTable {
  const notes = roll.notes();
  const all = collections(notes);
  const found = all.find((c) => c.name.toLowerCase() === name.replace(/^\/+|\/+$/g, "").toLowerCase());
  if (!found && !fs.existsSync(path.join(roll.root, NOTES_DIR, name))) {
    throw new NotFoundError(`There's no collection called "${name}".${all.length ? ` Collections: ${all.map((c) => c.name).join(", ")}` : ' Start one with: gitroll add books "The Dispossessed"'}`);
  }
  const records = recordsIn(notes, name);
  const matched = query.trim() ? new SearchIndex(records).search(query) : records;
  const sorted = sortedBy(matched, values.sort as string | undefined);
  const columns = values.fields === undefined ? columnsOf(records) : fieldList(String(values.fields));
  const offset = Number(values.offset ?? 0);
  const limit = values.limit === undefined ? undefined : Number(values.limit);
  const page = sorted.slice(offset, limit === undefined ? undefined : offset + limit);
  // A sealed field is `{sealed: true}` here, as in every list, never its ciphertext.
  return { collection: found?.name ?? name, description: found?.description ?? null, columns, total: matched.length, records: page.map((r) => recordRow(maskEntry(r), columns)) };
}

function fieldList(text: string): string[] {
  const names = text.split(",").map((s) => s.trim()).filter(Boolean);
  if (!names.length || names.some((n) => !FIELD_NAME.test(n))) throw new CliError("INVALID_ARGUMENT", "--fields takes comma-separated field names, e.g. --fields rating,status");
  return names;
}

const cell = (v: unknown): string => {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map(cell).join(", ");
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (o.sealed === true) return SEALED_PLACEHOLDER;
    return "value" in o && "currency" in o ? `${o.value} ${o.currency}` : JSON.stringify(v);
  }
  return String(v);
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A plain table: Title, then one column per field. Blank where a record has no such field. */
export function formatTable(table: RecordTable, bold: (s: string) => string = (s) => s): string {
  const head = ["Title", ...table.columns];
  const rows = table.records.map((r) => [r.title, ...table.columns.map((c) => cell(r.fields[c]))].map((s) => clip(s.replace(/\s+/g, " "), 40)));
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]))).join("  ").trimEnd();
  return [bold(line(head)), ...rows.map(line)].join("\n");
}

/** Which document `set` means: a path or a part of one, or else a search that finds exactly one. */
export function resolveTarget(roll: GitRoll, target: string): LoadedEntry {
  try {
    return roll.entry(target);
  } catch (e) {
    if (!(e instanceof NotFoundError)) throw e;
    const hits = new SearchIndex(roll.documents()).search(target);
    if (hits.length === 1) return hits[0];
    if (!hits.length) throw e;
    throw new CliError("INVALID_ARGUMENT", `"${target}" matches ${hits.length} documents; name one: ${hits.slice(0, 5).map((h) => h.path).join(", ")}${hits.length > 5 ? ", …" : ""}`);
  }
}

/** `key=value` arguments, in order; a key given twice keeps the last value. */
export function assignments(args: string[]): [string, FieldInput][] {
  const out = new Map<string, [string, FieldInput]>();
  for (const a of args) {
    try {
      const { key, input } = parseAssignment(a);
      out.set(key.toLowerCase(), [key, input]);
    } catch (e) {
      throw new CliError("INVALID_ARGUMENT", (e as Error).message);
    }
  }
  return [...out.values()];
}

/**
 * `gitroll add <collection> <title> --idempotency-key <key>`: the same key and
 * request return the record already written; a different request is refused.
 * The key is kept in the record's `source` mapping, the way `log` keeps it.
 */
export function addRecordIdempotent(roll: GitRoll, input: { collection: string; title: string; text?: string; fields: [string, FieldInput][]; raw: string[] }, key: string): SaveResult & { replayed: boolean } {
  const requestHash = createHash("sha256").update(JSON.stringify({ kind: "add", collection: input.collection, title: input.title, text: input.text ?? "", fields: input.raw })).digest("hex");
  const lockPath = path.resolve(roll.root, roll.git(["rev-parse", "--git-path", "gitroll-cli-add.lock"]).trim());
  let fd: number;
  try {
    fd = fs.openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ConflictError(`Another keyed add may be running. Retry when it finishes. If a process crashed, inspect and remove its lock: ${lockPath}`);
    throw error;
  }
  try {
    fs.writeFileSync(fd, `${process.pid}\n`);
    const existing = roll.documents().filter((e) => e.source?.adapter === "gitroll-cli" && e.source.id === key);
    if (existing.length > 1) throw new ConflictError("Multiple documents have this idempotency key. Resolve the duplicates before retrying.");
    if (existing.length) {
      const entry = existing[0];
      if ((entry.meta.source as Record<string, unknown>).request_hash !== requestHash) throw new ConflictError("This idempotency key was already used with different input. Use the original input or a new key.");
      try {
        roll.git(["cat-file", "-e", `HEAD:${entry.path}`]);
      } catch {
        throw new ConflictError("The keyed record exists but is not committed at this path. Inspect Git status and finish or undo the earlier write before retrying.");
      }
      return { entry, notices: [], replayed: true };
    }
    const source: [string, FieldInput] = ["source", { value: { adapter: "gitroll-cli", id: key, request_hash: requestHash } }];
    return { ...roll.saveRecord({ ...input, fields: [...input.fields.filter(([k]) => k.toLowerCase() !== "source"), source] }), replayed: false };
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lockPath);
  }
}
