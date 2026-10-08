// Checks a Roll against the format. Everything here is advisory except the
// template version: a Roll of plain Markdown files can hardly be "invalid", so
// the checks look for the things that actually bite — a link to a file that
// isn't there, front matter that won't parse, a date nothing can read.

import { FormatError, parseEntry, resolveLink } from "./entry.ts";
import { EVENT_FILE, EVENTS_DIR, MARKER_PATH, NOTE_FILE, NOTES_DIR, TEMPLATE_FILE, parseConfig, templateStatus } from "./layout.ts";
import type { Problem } from "./layout.ts";
import { groupFiles, linkablePaths, parseSidecar } from "./files.ts";
import type { StoredFile } from "./files.ts";
import { MAX_PARTS, partOf, partProblems, partsRecord } from "./parts.ts";
import { frontMatterLinks } from "./relations.ts";

export interface ValidateSource {
  /** Every repository-relative path (posix separators), excluding .git. */
  paths: string[];
  read(path: string): string;
  /** Reads one of the Roll's own template files. Absent when the caller has no template reader. */
  template?(path: string, source: string): { id: string } | null;
  /** Symbolic links found in the Roll. They're never followed and always reported. */
  links?: string[];
  /** A file's size in bytes. Absent when the caller can't tell; sizes are then not checked. */
  size?(path: string): number;
  /** SHA-256, in hex, of these files read one after another. Absent when the caller can't hash. */
  sha256?(paths: string[]): string;
}

/** GitHub warns about a file over 50 MB and refuses one over 100 MB. */
const GITHUB_WARNS = 50 * 1024 * 1024;
const GITHUB_REFUSES = 100 * 1024 * 1024;

const IGNORED = /(^|\/)(\.gitkeep|\.DS_Store|\.gitattributes|\.gitignore)$/;

/** Returns an empty list when the Roll is in good shape. */
export function validateRepo(src: ValidateSource): Problem[] {
  const problems: Problem[] = [];
  const add = (path: string, error: string) => problems.push({ path, error, severity: "error" });
  // Worth saying, but the record is still a valid event: the format has always
  // allowed an undated file, and a link can point at a file that simply hasn't
  // been synced to this computer yet.
  const warn = (path: string, error: string) => problems.push({ path, error, severity: "warning" });
  const paths = [...new Set(src.paths)].sort();
  const present = new Set(paths);
  // A link to a file kept in parts names the whole file, which is the parts.
  const linkable = linkablePaths(paths);
  for (const link of src.links ?? []) add(link, "symbolic links aren't allowed in a Roll; replace it with the real file");

  if (!present.has(MARKER_PATH)) {
    add(MARKER_PATH, `missing gitroll.yaml, so the template version is unknown. Add one containing: template_version: 1`);
  } else {
    try {
      const status = templateStatus(parseConfig(src.read(MARKER_PATH), ""));
      if (status.code !== "ok") add(MARKER_PATH, status.message);
    } catch (e) {
      add(MARKER_PATH, `invalid YAML: ${(e as Error).message}`);
    }
  }

  // A Roll's own templates. They are optional, and a broken one costs nobody an
  // event — but it silently disappears from the list, so it is reported here,
  // which is where a person looks for what GitRoll couldn't read.
  const templateIds = new Map<string, string>();
  for (const p of paths.filter((x) => TEMPLATE_FILE.test(x))) {
    let parsed;
    try {
      parsed = src.template?.(p, src.read(p));
    } catch (e) {
      add(p, e instanceof FormatError ? e.message : `unreadable: ${(e as Error).message}`);
      continue;
    }
    if (!parsed) continue;
    const already = templateIds.get(parsed.id);
    if (already) add(p, `is the same template as ${already} (both are "${parsed.id}"); rename one, or only the first is offered`);
    else templateIds.set(parsed.id, p);
  }

  for (const p of paths) {
    if (IGNORED.test(p)) continue;
    const note = p.startsWith(`${NOTES_DIR}/`);
    if (!note && !p.startsWith(`${EVENTS_DIR}/`)) continue;
    if (!(note ? NOTE_FILE : EVENT_FILE).test(p)) {
      add(p, `${note ? "notes" : "events"} are Markdown files (.md); anything else belongs in files/`);
      continue;
    }
    try {
      const entry = parseEntry(p, src.read(p));
      // A note isn't about a moment, so having no date is the point of it.
      if (!entry.date && !note) warn(p, "no date: name the file 2026-09-15-something.md, or add date: to the front matter");
      for (const a of entry.attachments) {
        if (!linkable.has(a.path)) warn(p, `links to ${a.path}, which isn't in this Roll`);
      }
      // A link from one event to another that leads nowhere is a broken
      // reference — usually an event that was moved or renamed by hand.
      for (const target of entry.links) {
        if (!present.has(target)) add(p, `links to ${target}, which isn't in this Roll`);
      }
      // The same goes for a link in a front matter field: a `resolves:` that
      // leads nowhere leaves its issue open, a `location:` loses its place.
      for (const target of frontMatterLinks(entry)) {
        if (entry.links.includes(target) || entry.attachments.some((a) => a.path === target)) continue;
        if (target.toLowerCase().endsWith(".md")) {
          if (!present.has(target)) add(p, `links to ${target} in its front matter, which isn't in this Roll`);
        } else if (!linkable.has(target)) warn(p, `links to ${target} in its front matter, which isn't in this Roll`);
      }
      for (const target of unresolvableLinks(p, entry.body)) add(p, `link ${target} points outside the Roll`);
    } catch (e) {
      add(p, e instanceof FormatError ? e.message : `unreadable: ${(e as Error).message}`);
    }
  }
  for (const f of groupFiles(paths)) checkFile(src, f, add, warn);
  return problems;
}

type Report = (path: string, error: string) => void;
const volume = (n: number) => String(n).padStart(3, "0");

/** A file under files/: its sidecar reads, its parts are all there, and it is what its sidecar says it is. */
function checkFile(src: ValidateSource, f: StoredFile, add: Report, warn: Report): void {
  let meta: Record<string, unknown> = {};
  if (f.sidecar) {
    try {
      meta = parseSidecar(f.sidecar, src.read(f.sidecar), f.path).meta;
    } catch (e) {
      add(f.sidecar, e instanceof FormatError ? e.message : `unreadable: ${(e as Error).message}`);
    }
    if (!f.whole && !f.parts.length) warn(f.sidecar, `describes ${f.path}, which isn't in this Roll`);
  }
  const record = partsRecord(meta);
  // Parts beyond the count the sidecar records aren't part of the file it describes.
  const stored = f.whole ? [f.path] : f.parts.filter((p) => record.parts === null || partOf(p)!.n <= record.parts);
  if (f.parts.length) {
    if (!f.sidecar) warn(f.path, `is kept in ${f.parts.length} parts with no sidecar (${f.path}.md), so its size and sha256 can't be checked`);
    const { missing, extra } = partProblems(f.parts.map((p) => partOf(p)!.n), record.parts);
    if (missing.length) {
      const shown = missing.slice(0, 10).map(volume).join(", ");
      add(f.path, `is missing ${missing.length === 1 ? "part" : "parts"} ${shown}${missing.length > 10 ? ", …" : ""}, so it can't be put back together`);
      return;
    }
    if (extra.length) warn(f.path, `has ${extra.length === 1 ? "a part" : "parts"} beyond the ${record.parts} its sidecar lists (${extra.map(volume).join(", ")})`);
    if (f.parts.length > MAX_PARTS) add(f.path, `is in more than ${MAX_PARTS} parts, which can't be joined in order by name`);
  } else if (f.sidecar && record.parts !== null && record.parts > 1 && f.whole) {
    warn(f.sidecar, `says ${f.path} is in ${record.parts} parts, but it is here whole`);
  }
  if (!stored.length) return;
  if (src.size) {
    const sizes = stored.map((p) => src.size!(p));
    const total = sizes.reduce((a, b) => a + b, 0);
    if (record.size !== null && total !== record.size) add(f.path, `is ${total} bytes${f.parts.length ? " in its parts" : ""}, but its sidecar says ${record.size}`);
    const largest = Math.max(...sizes);
    const where = stored[sizes.indexOf(largest)];
    if (largest > GITHUB_REFUSES) add(where, "is over 100 MB, which GitHub refuses. Keep it in parts instead: gitroll attach splits a large file");
    else if (largest > GITHUB_WARNS) warn(where, "is over 50 MB, which GitHub warns about, and Git keeps every version of it");
  }
  if (record.sha256 && src.sha256) {
    const actual = src.sha256(stored);
    if (actual !== record.sha256) {
      add(f.path, `doesn't match the sha256 in its sidecar (${record.sha256.slice(0, 12)}…; the ${f.parts.length ? "joined parts give" : "file gives"} ${actual.slice(0, 12)}…)`);
    }
  }
}

const RELATIVE_LINK = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;

/** Links that look local but climb out of the repository or start at its root. */
function unresolvableLinks(path: string, body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(RELATIVE_LINK)) {
    const target = m[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) continue;
    if (resolveLink(path, target) === null) out.push(target);
  }
  return out;
}
