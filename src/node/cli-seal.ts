// `gitroll key`, `gitroll recipients`, `gitroll seal`, `gitroll unseal` and `gitroll reseal`.
// Kept out of cli.ts so the command lives beside nothing but itself.

import { CliError } from "./cli-contract.ts";
import type { GitRoll } from "./repo.ts";
import type { LoadedEntry } from "../core/layout.ts";
import { findSensitive } from "../core/privacy.ts";
import { withoutSealed } from "../core/sealed.ts";
import {
  addRecipient,
  listKeys,
  newKey,
  removeRecipient,
  maskEntry,
  reseal,
  rollRecipients,
  sealDocument,
  sealFile,
  sealSuggestion,
  sealTarget,
  unsealDocument,
  unsealFile,
} from "./sealing.ts";

type Values = Record<string, string | boolean | string[] | undefined>;
interface Out {
  json: boolean;
  warn(text: string): void;
  ok(text: string): void;
}

const print = (data: unknown) => console.log(JSON.stringify(data, null, 2));
const lastField = (v: Values): string | undefined => {
  const f = v.field;
  const value = Array.isArray(f) ? f[f.length - 1] : typeof f === "string" ? f : undefined;
  if (value !== undefined && !/^[A-Za-z_][\w-]*$/.test(value)) throw new CliError("INVALID_ARGUMENT", "--field takes the name of a front matter key, e.g. --field pin");
  return value;
};

export async function keyCommand(args: string[], v: Values, out: Out): Promise<void> {
  if (args.length && args[0] !== "new") throw new CliError("INVALID_ARGUMENT", "Usage: gitroll key [new] [--name <label>]");
  if (args[0] === "new") {
    const made = await newKey(typeof v.name === "string" ? v.name : undefined);
    if (out.json) return print({ ...made, created: true });
    out.ok("Made a new key.");
    console.log(`Public recipient (safe to share): ${made.recipient}`);
    console.log(`Secret key kept in ${made.path} (only you can read it). Back it up somewhere safe: without it, what you seal can't be opened.`);
    console.log(`Let it open a Roll's sealed content with: gitroll recipients add ${made.recipient}${made.name ? ` --name "${made.name}"` : ""}`);
    return;
  }
  if (v.name !== undefined) throw new CliError("INVALID_ARGUMENT", "--name applies to: gitroll key new --name <label>");
  const keys = await listKeys();
  if (out.json) return print(keys);
  if (!keys.keys.length) return console.log(`No key on this computer yet. Make one with: gitroll key new`);
  for (const k of keys.keys) console.log(`${k.recipient}${k.name ? `  ${k.name}` : ""}`);
  console.log(`Kept in ${keys.path}`);
}

export function recipientsCommand(roll: GitRoll, args: string[], v: Values, out: Out): void {
  const [action, value] = args;
  if (action === undefined) {
    if (v.name !== undefined) throw new CliError("INVALID_ARGUMENT", "--name applies to: gitroll recipients add <age1…> --name <label>");
    const recipients = rollRecipients(roll);
    if (out.json) return print({ recipients });
    if (!recipients.length) return console.log("This Roll has no recipients yet. Add one with: gitroll recipients add <age1…> (make a key with: gitroll key new)");
    for (const r of recipients) console.log(`${r.recipient}${r.label ? `  ${r.label}` : ""}`);
    return;
  }
  if (!["add", "remove"].includes(action) || !value?.trim()) throw new CliError("INVALID_ARGUMENT", "Usage: gitroll recipients [add <age1…> [--name <label>] | remove <age1…|label>]");
  if (action === "add") {
    const result = addRecipient(roll, value, typeof v.name === "string" ? v.name : undefined);
    if (out.json) return print(result);
    out.ok(result.added ? "Added. What you seal from now on can be opened with that key." : "That recipient is already listed.");
    if (result.added) console.log("Content sealed earlier stays sealed to the recipients it had. To include the new one, run: gitroll reseal");
    return;
  }
  if (v.name !== undefined) throw new CliError("INVALID_ARGUMENT", "--name applies to: gitroll recipients add");
  const result = removeRecipient(roll, value);
  if (out.json) return print(result);
  out.ok(`Removed ${result.removed.length === 1 ? "it" : `${result.removed.length} recipients`}.`);
  for (const n of result.notices) out.warn(n);
}

const describe = (p: { path: string; kind: string; lines?: string; field?: string }) =>
  `${p.path}${p.kind === "block" ? ` (lines ${p.lines})` : p.kind === "field" ? ` (field ${p.field})` : ""}`;

/**
 * `gitroll reseal [<file>]`: everything sealed (or what one file holds) sealed
 * again to the Roll's current recipients, as one commit. Exits 1 when something
 * couldn't be opened, after re-sealing the rest.
 */
export async function resealCommand(roll: GitRoll, arg: string | undefined, v: Values, out: Out, confirm: (question: string) => Promise<boolean>): Promise<void> {
  const dryRun = !!v["dry-run"];
  if (!dryRun && !(await confirm(`Seal ${arg === undefined ? "everything sealed in this Roll" : arg} again to the recipients in .gitroll/config.yaml?`))) return;
  const result = await reseal(roll, arg, { dryRun });
  if (result.unopened.length) process.exitCode = 1;
  if (out.json) return print(result);
  const n = result.resealed.length;
  const to = `${result.recipients.length} ${result.recipients.length === 1 ? "recipient" : "recipients"}`;
  if (dryRun) {
    console.log(n ? `Would seal ${n} ${n === 1 ? "part" : "parts"} again, to ${to}:` : "Nothing would change.");
    for (const p of result.resealed) console.log(`  ${describe(p)}`);
  } else if (n) out.ok(`Sealed ${n} ${n === 1 ? "part" : "parts"} again, to ${to}.`);
  else console.log("Nothing to re-seal.");
  if (result.unchanged.length) console.log(`${result.unchanged.length} already sealed to exactly these recipients, left as ${result.unchanged.length === 1 ? "it is" : "they are"}.`);
  for (const p of result.unopened) out.warn(`Not opened: ${describe(p)}: ${p.reason}`);
  for (const note of result.notices) out.warn(note);
  if (dryRun) console.log("Nothing was changed (--dry-run).");
}

export async function sealCommand(roll: GitRoll, arg: string, v: Values, out: Out): Promise<void> {
  const target = sealTarget(roll, arg);
  const field = lastField(v);
  const lines = typeof v.lines === "string" ? v.lines : undefined;
  if (lines && field) throw new CliError("INVALID_ARGUMENT", "Choose either --lines or --field, not both.");
  if (target.kind === "file" && (lines || field)) throw new CliError("INVALID_ARGUMENT", "--lines and --field apply to events and notes; a file is sealed whole.");
  const result = target.kind === "file" ? await sealFile(roll, target.path) : await sealDocument(roll, target.entry, { lines, field });
  if (out.json) return print(result);
  out.ok(target.kind === "file" ? `Sealed. ${result.path} can only be opened by this Roll's recipients.` : "Sealed. Only this Roll's recipients can read that part now.");
  for (const n of result.notices) out.warn(n);
}

export async function unsealCommand(roll: GitRoll, arg: string, v: Values, out: Out, confirm: (question: string) => Promise<boolean>): Promise<void> {
  const target = sealTarget(roll, arg);
  const field = lastField(v);
  const lines = typeof v.lines === "string" ? v.lines : undefined;
  if (target.kind === "file" && (lines || field)) throw new CliError("INVALID_ARGUMENT", "--lines and --field apply to events and notes; a file is unsealed whole.");
  if (!(await confirm("Write it back in plain text? Once committed, the plain text stays in history."))) return;
  const result = target.kind === "file" ? await unsealFile(roll, target.path) : await unsealDocument(roll, target.entry, { lines, field });
  if (out.json) return print(result);
  out.ok(`Unsealed ${result.path}.`);
  for (const n of result.notices) out.warn(n);
}

/**
 * A write's JSON with its entry as a read shows it: a sealed field is
 * `{sealed: true}`, never its ciphertext, and `sealed` lists the sealed parts.
 * The file itself is as it was written.
 */
export function masked<T extends { entry?: LoadedEntry | null }>(result: T): T {
  return result?.entry ? { ...result, entry: maskEntry(result.entry) } : result;
}

/**
 * A save's JSON with a `seal` suggestion added when it turned up something
 * that looks like a secret: the exact command that would seal those lines.
 * Its entry is masked, as every write's is.
 */
export function withSealHint<T extends { entry: LoadedEntry }>(roll: GitRoll, result: T): T & { seal?: { path: string; lines: string; command: string } } {
  if (!result?.entry || !findSensitive(withoutSealed(result.entry.body)).length) return masked(result);
  const seal = sealSuggestion(roll, result.entry.path);
  return seal ? { ...masked(result), seal } : masked(result);
}
