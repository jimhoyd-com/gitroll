// The calendar, the ledger and the inventory from the command line, plus CSV
// in and out and QR labels. Each is a view over files that already exist; the
// format work is in src/core so the web service can do the same. Kept apart
// from cli.ts so that file only dispatches.

import fs from "node:fs";
import { parseCsv, planCsvImport, recordsToCsv } from "../core/csv.ts";
import type { CsvPlan } from "../core/csv.ts";
import { addDays, calendarItems, upcoming } from "../core/calendar.ts";
import type { CalendarItem } from "../core/calendar.ts";
import { toICalendar } from "../core/ical.ts";
import { PEOPLE_COLLECTION, contacts, planVcfImport, toVCard } from "../core/contacts.ts";
import type { Contacts, VcfPlan } from "../core/contacts.ts";
import { INVENTORY_COLLECTION, inventory, restockTodos } from "../core/inventory.ts";
import type { DerivedTodo, Inventory } from "../core/inventory.ts";
import { formatTotals, ledger, toHledger } from "../core/ledger.ts";
import type { Ledger } from "../core/ledger.ts";
import { encodeQr, qrToSvg, qrToText } from "../core/qr.ts";
import type { LoadedEntry } from "../core/layout.ts";
import { collections, columnsOf, recordsIn } from "../core/fields.ts";
import { SearchIndex } from "../core/search.ts";
import { NotFoundError, UserError, formatAmount, isoDate } from "../core/util.ts";
import { CliError } from "./cli-contract.ts";
import { resolveTarget, sortedBy } from "./cli-records.ts";
import type { GitRoll } from "./repo.ts";

type Values = Record<string, string | boolean | string[] | undefined>;
type Paint = (s: string) => string;
const plain: Paint = (s) => s;

const filtered = (docs: LoadedEntry[], query: string): LoadedEntry[] => (query.trim() ? new SearchIndex(docs).search(query) : docs);

// ── Calendar ───────────────────────────────────────────────────────────────

/** `--days`: a whole number of days, 30 when not given. */
export function daysOption(v: Values): number {
  if (v.days === undefined) return 30;
  const s = String(v.days);
  if (!/^\d{1,5}$/.test(s)) throw new CliError("INVALID_ARGUMENT", "--days must be a whole number of days, e.g. --days 60");
  return Number(s);
}

/** `gitroll upcoming`: what's due from today to --days ahead, by date; open dated to-dos already overdue first. */
export function upcomingItems(roll: GitRoll, days: number, today = isoDate()): CalendarItem[] {
  return upcoming(roll.documents(), roll.todos(), today, days);
}

/**
 * `gitroll calendar`: every dated item, past and future, each start listed once
 * (repeats are left to the rrule), and events dated today or later.
 */
export function calendarAll(roll: GitRoll, today = isoDate()): CalendarItem[] {
  const docs = roll.documents();
  const starts = calendarItems(docs.filter((d) => !d.path.startsWith(".gitroll/events/") || hasStart(d)), roll.todos(), {});
  const ahead = calendarItems(docs.filter((d) => d.path.startsWith(".gitroll/events/") && !hasStart(d)), [], { from: today });
  // A birthday with no year (vCard's --MMDD) has no first time to list, so the next one is.
  const yearless = calendarItems(docs.filter((d) => !d.path.startsWith(".gitroll/events/")), [], { from: today, to: addDays(today, 364) }).filter((i) => i.recurrence === "every year" && i.years === undefined);
  return [...starts, ...ahead, ...yearless].filter((i) => i.kind !== "occurrence").sort((a, b) => a.date.slice(0, 10).localeCompare(b.date.slice(0, 10)) || a.title.localeCompare(b.title));
}

const hasStart = (d: LoadedEntry) => Object.keys(d.meta).some((k) => k.toLowerCase() === "start");

/** `gitroll calendar --ics`: the Roll's calendar as an RFC 5545 file. */
export function calendarIcs(roll: GitRoll, today = isoDate()): string {
  return toICalendar(roll.documents(), roll.todos(), { name: roll.config().name, today });
}

const KIND: Record<CalendarItem["kind"], string> = { event: "", occurrence: "repeats", todo: "to-do", field: "" };

export function formatUpcoming(items: CalendarItem[], paint: { bold: Paint; dim: Paint; red: Paint } = { bold: plain, dim: plain, red: plain }): string {
  const lines: string[] = [];
  for (const i of items) {
    const when = i.date.length > 10 ? `${i.date.slice(0, 10)} ${i.date.slice(11, 16)}` : i.date;
    const what = i.kind === "field" ? `${i.title}: ${i.field}` : i.title;
    const notes = [KIND[i.kind], i.years !== undefined ? `${i.years} ${i.years === 1 ? "year" : "years"}` : "", i.location ? `at ${i.location}` : "", i.recurrence ? `🔁 ${i.recurrence}` : "", i.problem ? `rrule not read: ${i.problem}` : ""].filter(Boolean).join(", ");
    const where = i.line ? `${shortPath(i.path)}:${i.line}` : shortPath(i.path);
    lines.push(`${i.overdue ? paint.red(when.padEnd(16)) : paint.bold(when.padEnd(16))}  ${what}${notes ? paint.dim(`  (${notes})`) : ""}  ${paint.dim(where)}`);
  }
  return lines.join("\n");
}

const shortPath = (p: string) => p.replace(/^\.gitroll\/events\//, "").replace(/^\.gitroll\//, "").replace(/\.md$/, "");

// ── Ledger ─────────────────────────────────────────────────────────────────

export function ledgerView(roll: GitRoll, query: string, by: string | undefined): Ledger {
  if (by !== undefined && !/^[A-Za-z_][\w-]*$/.test(by)) throw new CliError("INVALID_ARGUMENT", "--by takes month, year, project, tag or a field name, e.g. --by month");
  return ledger(filtered(roll.documents(), query), by);
}

export function hledgerJournal(view: Ledger): string {
  return toHledger(view.entries);
}

export function formatLedger(view: Ledger, paint: { bold: Paint; dim: Paint } = { bold: plain, dim: plain }): string {
  if (!view.entries.length) return "Nothing with an amount or a price matches.";
  const lines: string[] = [];
  if (view.by) {
    const width = Math.max(view.by.length, ...view.groups.map((g) => g.key.length));
    lines.push(paint.bold(`${view.by.padEnd(width)}  total`));
    for (const g of view.groups) lines.push(`${g.key.padEnd(width)}  ${formatTotals(g.totals)}  ${paint.dim(`${g.count} ${g.count === 1 ? "entry" : "entries"}`)}`);
    lines.push("");
  } else {
    for (const e of view.entries) lines.push(`${(e.date ?? "undated").padEnd(10)}  ${formatAmount(e.amount).padStart(14)}  ${e.title}  ${paint.dim(shortPath(e.path))}`);
    lines.push("");
  }
  lines.push(`${paint.bold("Total")}  ${formatTotals(view.totals)}`);
  if (view.totals.length > 1) lines.push(paint.dim("Each currency is totalled on its own; nothing is converted."));
  return lines.join("\n");
}

// ── Inventory ──────────────────────────────────────────────────────────────

export function inventoryView(roll: GitRoll, query: string, values: Values, today = isoDate()): Inventory {
  const name = typeof values.collection === "string" ? values.collection : INVENTORY_COLLECTION;
  const by = typeof values.by === "string" ? values.by : undefined;
  if (by !== undefined && !/^[A-Za-z_][\w-]*$/.test(by)) throw new CliError("INVALID_ARGUMENT", "--by takes location or a field name, e.g. --by location");
  const docs = roll.documents();
  const records = recordsIn(roll.notes(), name);
  return inventory(filtered(records, query), docs, { collection: name, by, today });
}

export function formatInventory(view: Inventory, paint: { bold: Paint; dim: Paint; yellow: Paint } = { bold: plain, dim: plain, yellow: plain }): string {
  if (!view.items.length) return `No items in ${view.collection} yet. Add one with: gitroll add ${view.collection} "Garage heat pump" --field brand=Daikin --field price=1899`;
  const lines: string[] = [];
  const row = (i: Inventory["items"][number]) => {
    const what = [i.brand, i.model].filter(Boolean).join(" ");
    const qty = i.quantity !== null ? `×${i.quantity}` : "";
    return `  ${i.title}${what ? paint.dim(`  ${what}`) : ""}${qty ? `  ${qty}` : ""}${i.value ? `  ${formatAmount(i.value)}` : ""}${i.restock ? paint.yellow("  restock") : ""}`;
  };
  if (view.groups) {
    for (const g of view.groups) {
      lines.push(`${paint.bold(g.key)}  ${paint.dim(`${g.count} · ${formatTotals(g.totals)}`)}`);
      for (const i of view.items) {
        const key = i.location?.trail.join(" › ") ?? "(nowhere)";
        if (key === g.key) lines.push(row(i));
      }
    }
  } else {
    for (const i of view.items) lines.push(`${row(i).trimStart()}${i.location ? paint.dim(`  ${i.location.trail.join(" › ")}`) : ""}`);
  }
  lines.push("", `${paint.bold("Value")}  ${formatTotals(view.totals)}`);
  if (view.warranties.length) {
    lines.push("", paint.bold("Warranties ending in the next 90 days"));
    for (const w of view.warranties) lines.push(`  ${w.warranty.slice(0, 10)}  ${w.title}`);
  }
  if (view.restock.length) {
    lines.push("", paint.bold("Running low"));
    for (const r of view.restock) lines.push(`  ${r.title}: ${r.quantity} left (reorder at ${r.reorderAt})`);
  }
  return lines.join("\n");
}

/** Restock to-dos for `gitroll todos`: worked out from quantity and reorderAt, never written to a file. */
export function derivedTodos(roll: GitRoll, docs?: Set<string> | null): DerivedTodo[] {
  return restockTodos(roll.notes()).filter((t) => !docs || docs.has(t.path));
}

// ── Contacts ───────────────────────────────────────────────────────────────

const collectionOption = (values: Values, fallback: string): string => {
  const name = typeof values.collection === "string" ? values.collection : fallback;
  const folder = name.split("/").map((s) => s.trim()).filter(Boolean).join("/");
  if (!folder || folder.split("/").some((p) => p === "." || p === "..")) throw new CliError("INVALID_ARGUMENT", "--collection takes a folder under notes/, e.g. --collection people");
  return folder;
};

/** `gitroll contacts [query]`: the people in notes/people/ (or --collection), with when each was last in an event. */
export function contactsView(roll: GitRoll, query: string, values: Values): Contacts & { vcf?: string } {
  const name = collectionOption(values, PEOPLE_COLLECTION);
  const records = filtered(recordsIn(roll.notes(), name), query);
  const view = contacts(records, roll.documents(), name);
  if (!values.vcf) return view;
  const byPath = new Map(records.map((r) => [r.path, r]));
  return { ...view, vcf: toVCard(view.contacts.map((c) => byPath.get(c.path)!)) };
}

export function formatContacts(view: Contacts, paint: { bold: Paint; dim: Paint } = { bold: plain, dim: plain }): string {
  if (!view.contacts.length) return `No one in ${view.collection} yet. Add someone with: gitroll add ${view.collection} "Ada Lovelace" --field email=ada@example.com --field bday=1815-12-10`;
  return view.contacts
    .map((c) => {
      const reach = [...c.emails.slice(0, 1), ...c.tels.slice(0, 1), c.org ?? ""].filter(Boolean).join("  ");
      const last = c.lastContacted ? `last contacted ${c.lastContacted}` : "";
      return `${paint.bold(c.name)}${reach ? `  ${reach}` : ""}${last ? paint.dim(`  ${last}`) : ""}`;
    })
    .join("\n");
}

/** `gitroll import vcf <file.vcf>`: a record per card in notes/people/ (or --collection), once. --dry-run says what it would do. */
export function importVcf(roll: GitRoll, file: string, values: Values, dryRun: boolean): CsvImportResult & { plan?: VcfPlan } {
  const folder = collectionOption(values, PEOPLE_COLLECTION);
  let text: string;
  try {
    text = file === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(file, "utf8");
  } catch {
    throw new UserError(`Can't read ${file}.`);
  }
  const plan = planVcfImport(text, recordsIn(roll.notes(), folder));
  const problems = plan.problems.map((p) => ({ row: p.card, message: p.message }));
  if (!plan.create.length && !plan.skip.length && !problems.length) throw new UserError(`${file} has no vCards in it (BEGIN:VCARD … END:VCARD).`);
  const skipped = plan.skip.map((r) => ({ row: r.card, title: r.title }));
  if (dryRun) return { collection: folder, created: plan.create.map((r) => r.title), skipped, problems, plan };
  const entries = plan.create.length
    ? roll.saveRecords(
        plan.create.map((r) => ({ collection: folder, title: r.title, fields: [...r.fields.map(([k, v]): [string, { value: unknown }] => [k, { value: v }]), ["source", { value: { adapter: "vcf", id: r.id } }]] })),
        `import: ${plan.create.length} ${plan.create.length === 1 ? "contact" : "contacts"} into ${folder}`,
      )
    : [];
  return { collection: folder, created: entries.map((e) => e.path), skipped, problems };
}

// ── CSV ────────────────────────────────────────────────────────────────────

/** `gitroll records <collection> --csv`: RFC 4180, a title column then one per field. */
export function recordsCsv(roll: GitRoll, name: string, query: string, values: Values): string {
  const notes = roll.notes();
  const want = name.split("/").filter(Boolean).join("/").toLowerCase();
  if (!collections(notes).some((c) => c.name.toLowerCase() === want)) throw new NotFoundError(`There's no collection called "${name}".`);
  const records = recordsIn(notes, name);
  const rows = sortedBy(filtered(records, query), values.sort as string | undefined);
  const columns = values.fields === undefined ? columnsOf(records) : String(values.fields).split(",").map((s) => s.trim()).filter(Boolean);
  return recordsToCsv(rows, columns);
}

export interface CsvImportResult {
  collection: string;
  created: string[];
  skipped: { row: number; title: string }[];
  problems: { row: number; message: string }[];
}

/** `gitroll import csv <collection> <file.csv>`: a record per row, once. --dry-run says what it would do. */
export function importCsv(roll: GitRoll, collection: string, file: string, dryRun: boolean): CsvImportResult & { plan?: CsvPlan } {
  const folder = collection.split("/").map((s) => s.trim()).filter(Boolean).join("/");
  if (!folder || folder.split("/").some((p) => p === "." || p === "..")) throw new CliError("INVALID_ARGUMENT", "Usage: gitroll import csv <collection> <file.csv>");
  let text: string;
  try {
    text = file === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(file, "utf8");
  } catch {
    throw new UserError(`Can't read ${file}.`);
  }
  let plan: CsvPlan;
  try {
    parseCsv(text);
    plan = planCsvImport(text, recordsIn(roll.notes(), folder));
  } catch (e) {
    throw new UserError(`${file} isn't CSV GitRoll can read: ${(e as Error).message}.`);
  }
  const skipped = plan.skip.map((r) => ({ row: r.row, title: r.title }));
  if (dryRun) return { collection: folder, created: plan.create.map((r) => r.title), skipped, problems: plan.problems, plan };
  const entries = plan.create.length
    ? roll.saveRecords(
        plan.create.map((r) => ({ collection: folder, title: r.title, fields: [...r.fields.map(([k, v]): [string, { value: unknown }] => [k, { value: v }]), ["source", { value: { adapter: "csv", id: r.id } }]] })),
        `import: ${plan.create.length} ${plan.create.length === 1 ? "record" : "records"} into ${folder}`,
      )
    : [];
  return { collection: folder, created: entries.map((e) => e.path), skipped, problems: plan.problems };
}

// ── Labels ─────────────────────────────────────────────────────────────────

export interface Label {
  path: string;
  title: string;
  /** What the code says: the record's path in the repository. */
  data: string;
  version: number;
  size: number;
  svg?: string;
  text?: string;
}

/** `gitroll label <record>`: a QR code for the record's repository path. */
export function label(roll: GitRoll, target: string, svg: boolean): Label {
  const entry = resolveTarget(roll, target);
  let qr;
  try {
    qr = encodeQr(entry.path);
  } catch (e) {
    throw new UserError(`${entry.path} is too long for a label: ${(e as Error).message}`);
  }
  return { path: entry.path, title: entry.title, data: entry.path, version: qr.version, size: qr.size, ...(svg ? { svg: qrToSvg(qr, { title: entry.title }) } : { text: qrToText(qr) }) };
}
