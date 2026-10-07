// Files from the command line: `gitroll files`, `gitroll attach`, `gitroll
// reassemble <file> --out`, and `gitroll set` on a file's sidecar. Kept apart from cli.ts
// so that file only dispatches.

import { NotFoundError } from "../core/util.ts";
import { assignments, resolveTarget } from "./cli-records.ts";
import { attachFile, findFile, formatBytes, joinFile, listFiles, openInApp, openableFile, setFileFields, sizeReport } from "./roll-files.ts";
import type { FileInfo } from "./roll-files.ts";
import type { GitRoll } from "./repo.ts";

type Values = Record<string, string | boolean | string[] | undefined>;
export interface Paint {
  bold: (s: string) => string;
  dim: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
}

const shortPath = (p: string) => p.replace(/^\.gitroll\//, "");

/** `gitroll files [query] [--unfiled]`, or `gitroll files --open <file>`. */
export function filesCommand(roll: GitRoll, args: string[], v: Values, paint: Paint): void {
  if (typeof v.open === "string") {
    const { file, temporary } = openableFile(roll, v.open);
    openInApp(file);
    console.log(`Opened ${paint.bold(file)}${temporary ? paint.dim(" (joined from its parts and checked against its sha256; a temporary copy)") : ""}`);
    return;
  }
  const all = listFiles(roll, { query: args.join(" "), unfiled: !!v.unfiled });
  const offset = Number(v.offset ?? 0);
  const page = all.slice(offset, v.limit === undefined ? undefined : offset + Number(v.limit));
  if (v.json) return console.log(JSON.stringify(page, null, 2));
  if (!page.length) {
    if (args.length || v.unfiled) return console.log(v.unfiled && !args.length ? "Every file is linked from an event or a note." : "No file matches that.");
    return console.log(`No files yet. Add one with: ${paint.bold("gitroll attach scan.pdf")} (or attach it to an event: gitroll log "..." scan.pdf)`);
  }
  for (const f of page) printFile(f, paint);
  if (page.length < all.length) console.log(paint.dim(`${page.length} of ${all.length}`));
}

function printFile(f: FileInfo, paint: Paint): void {
  const name = shortPath(f.path);
  const size = f.size === null ? paint.yellow("missing") : `${formatBytes(f.size)}${f.parts ? ` in ${f.parts} parts` : ""}`;
  const title = f.title !== name.split("/").pop() ? `  ${f.title}` : "";
  console.log(`${paint.bold(name)}${title}  ${paint.dim(size)}`);
  if (f.unfiled) console.log(`  ${paint.yellow("unfiled")}${paint.dim(": nothing links to it")}`);
  for (const from of f.linkedFrom) console.log(`  ${paint.dim("linked from:")} ${shortPath(from)}`);
  for (const [key, value] of Object.entries(f.fields)) {
    if (["title", "parts", "size", "sha256"].includes(key)) continue;
    console.log(`  ${paint.dim(key)}: ${typeof value === "object" && !(value instanceof Date) ? JSON.stringify(value) : value instanceof Date ? value.toISOString().slice(0, 10) : value}`);
  }
}

/** `gitroll attach <path> [--to <event|note>] [--field key=value ...]`. */
export function attachCommand(roll: GitRoll, args: string[], v: Values, paint: Paint): void {
  const result = attachFile(roll, args[0], { to: v.to as string | undefined, fields: assignments((v.field as string[] | undefined) ?? []) });
  if (v.json) return console.log(JSON.stringify(result, null, 2));
  console.log(`${paint.green("Attached")} ${paint.bold(shortPath(result.path))}  ${paint.dim(formatBytes(result.size))}`);
  if (result.parts) {
    console.log(paint.dim(`  Kept in ${result.parts} parts (${shortPath(result.path)}.001 …), so no file is too large for GitHub. Links still name ${shortPath(result.path)}.`));
    console.log(paint.dim(`  Put back together with: gitroll reassemble ${shortPath(result.path)} --out <path>, or without GitRoll: cat ${result.path.split("/").pop()}.0* > ${result.path.split("/").pop()}`));
  }
  if (result.sidecar) console.log(paint.dim(`  Its fields are in ${shortPath(result.sidecar)}`));
  for (const from of result.linkedFrom) console.log(paint.dim(`  Linked from ${shortPath(from)}`));
  if (!result.linkedFrom.length) console.log(paint.dim(`  Unfiled: nothing links to it yet. Link it from an event with --to, or describe it: gitroll set ${shortPath(result.path)} title="..."`));
  for (const n of result.notices) console.log(paint.yellow(n));
}

/** `gitroll reassemble <file> --out <path>`: a file kept in parts, as one file again. */
export function reassembleCommand(roll: GitRoll, target: string, out: string, json: boolean, paint: Paint): void {
  const result = joinFile(roll, target, out);
  if (json) return console.log(JSON.stringify(result, null, 2));
  console.log(`${paint.green("Wrote")} ${paint.bold(result.out)}  ${paint.dim(formatBytes(result.size))}`);
  console.log(paint.dim(result.verified ? `  It matches the sha256 its sidecar records (${result.sha256.slice(0, 12)}…).` : `  sha256 ${result.sha256} (its sidecar records none to check against).`));
}

/**
 * Which file `set` means, if it means one: a path under files/ (or its
 * sidecar's), and otherwise a file name that matches no event or note.
 */
export function fileForSet(roll: GitRoll, target: string): ReturnType<typeof findFile> {
  const q = target.trim().replace(/^\.?\//, "");
  if (/^(\.gitroll\/)?files\//.test(q)) return findFile(roll, q);
  try {
    resolveTarget(roll, target);
    return null;
  } catch (e) {
    if (!(e instanceof NotFoundError)) throw e;
    const f = findFile(roll, target);
    if (!f) throw e;
    return f;
  }
}

/** `gitroll set <file> key=value` for a file under files/: its sidecar. */
export function setFileCommand(roll: GitRoll, file: NonNullable<ReturnType<typeof findFile>>, args: string[], v: Values, paint: Paint): void {
  const result = setFileFields(roll, file, assignments(args), (v.unset as string[] | undefined) ?? [], { expect: v.expect as string | undefined });
  if (v.json) return console.log(JSON.stringify(result, null, 2));
  console.log(result.changed ? paint.green("Saved.") : "Nothing to change: the fields already say that.");
  console.log(`${paint.bold(result.entry.title)}  ${paint.dim(shortPath(result.entry.path))}`);
  for (const [key, value] of Object.entries(result.entry.meta)) console.log(`  ${paint.dim(key)}: ${typeof value === "object" ? JSON.stringify(value) : value}`);
}

/** Lines for `gitroll doctor`: how big the Roll is, and its largest files. */
export function sizeChecks(roll: GitRoll): { level: "ok" | "warning" | "info"; message: string }[] {
  const { gitBytes, largest } = sizeReport(roll);
  const out: { level: "ok" | "warning" | "info"; message: string }[] = [];
  const GB = 1024 ** 3;
  if (gitBytes !== null) {
    out.push(
      gitBytes > GB
        ? { level: "warning", message: `The repository is ${formatBytes(gitBytes)}, over the 1 GB GitHub recommends. Git keeps every version of every file, so deleting a file now doesn't make it smaller.` }
        : { level: "ok", message: `The repository is ${formatBytes(gitBytes)} (GitHub recommends staying under 1 GB; Git keeps every version of every file)` },
    );
  }
  if (largest.length) {
    out.push({ level: "info", message: `Largest files: ${largest.map((f) => `${shortPath(f.path)} ${formatBytes(f.size)}${f.parts ? ` in ${f.parts} parts` : ""}`).join(", ")}` });
  }
  return out;
}
