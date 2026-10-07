// FILES ON THEIR OWN. Everything under .gitroll/files/ is a file in the Roll,
// whether or not an event links to it. A file nothing links to is *unfiled*:
// waiting to be described or linked, not an orphan to clean up.
//
// A file's fields live beside it, in a sidecar named after it:
//
//   files/passport.pdf          the file, never touched
//   files/passport.pdf.md       its record: front matter fields and a description
//
// The sidecar's front matter uses Dublin Core names where one fits (`title`,
// `creator`, `date`, `subject`, `description`) and any other key a person
// wants (`expires`). A sidecar is not an event or a note: it isn't on the
// timeline and it has no to-dos to speak of. It is searchable, as `is:file`.
//
// A file kept in parts (see parts.ts) is one file here, under its whole name.
//
// Platform-free: callers hand in the Roll's paths and the sidecar's text.

import { baseName, dateFromFilename, normalizeTag, parseEntry, typeForPath } from "./entry.ts";
import type { Attachment, Entry } from "./entry.ts";
import { FILES_DIR } from "./layout.ts";
import { partOf } from "./parts.ts";

/** A file in the Roll, under the one name links use. */
export interface StoredFile {
  /** Repository-relative path links resolve to, e.g. .gitroll/files/passport.pdf */
  path: string;
  /** The file itself is there, whole. */
  whole: boolean;
  /** Numbered parts present, in order, when the file is kept in parts (whole is then false). */
  parts: string[];
  /** The sidecar beside it, when there is one. */
  sidecar: string | null;
}

const IGNORED = /(^|\/)(\.gitkeep|\.DS_Store|Thumbs\.db|desktop\.ini)$/i;
const SIDECAR = /\.md$/i;

/** Whether a path is inside .gitroll/files/. */
export const inFiles = (path: string): boolean => path.startsWith(`${FILES_DIR}/`);

/** A name like `passport.pdf`: something before a dot and something after it. */
function hasExtension(name: string): boolean {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1;
}

/**
 * Every file under files/, grouped: one item per name a link would use, with
 * its parts and its sidecar. `paths` is every repository-relative path in the
 * Roll (others are ignored).
 *
 * `x.md` beside a file is that file's sidecar when there is a file or parts
 * called `x`, or when `x` itself has an extension (`passport.pdf.md` describes
 * `passport.pdf` even before that file has arrived). A Markdown file kept as a
 * file (`files/minutes.md`) is just a file; its sidecar is `minutes.md.md`.
 *
 * Numbered files `x.001`, `x.002`… are parts of `x` when `x` itself isn't
 * there and either `x.001` or the sidecar `x.md` is.
 */
export function groupFiles(paths: string[]): StoredFile[] {
  const present = new Set(paths.filter((p) => inFiles(p) && !IGNORED.test(p)));
  const sidecars = new Map<string, string>();
  for (const p of present) {
    if (!SIDECAR.test(p)) continue;
    const target = p.slice(0, -3);
    if (present.has(target) || present.has(`${target}.001`) || hasExtension(baseName(target))) sidecars.set(target, p);
  }
  const sidecarPaths = new Set(sidecars.values());
  const partsOf = new Map<string, { n: number; path: string }[]>();
  for (const p of present) {
    if (sidecarPaths.has(p)) continue;
    const part = partOf(p);
    if (!part || present.has(part.base) || !(present.has(`${part.base}.001`) || sidecars.has(part.base))) continue;
    const list = partsOf.get(part.base) ?? [];
    list.push({ n: part.n, path: p });
    partsOf.set(part.base, list);
  }
  const partPaths = new Set([...partsOf.values()].flat().map((x) => x.path));
  const out = new Map<string, StoredFile>();
  for (const p of present) {
    if (sidecarPaths.has(p) || partPaths.has(p)) continue;
    out.set(p, { path: p, whole: true, parts: [], sidecar: sidecars.get(p) ?? null });
  }
  for (const [base, list] of partsOf) {
    out.set(base, { path: base, whole: false, parts: list.sort((a, b) => a.n - b.n).map((x) => x.path), sidecar: sidecars.get(base) ?? null });
  }
  for (const [target, sidecar] of sidecars) if (!out.has(target)) out.set(target, { path: target, whole: false, parts: [], sidecar });
  return [...out.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** The paths a link may name and still find a file: whole files, and files kept in parts. */
export function linkablePaths(paths: string[]): Set<string> {
  const out = new Set(paths);
  for (const f of groupFiles(paths)) if (f.whole || f.parts.length) out.add(f.path);
  return out;
}

/** The sidecar's path for a file: its name with `.md` after it. */
export const sidecarPath = (filePath: string): string => `${filePath}.md`;

const scalar = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(scalar) : typeof v === "string" ? v.split(",") : []).map((s) => s.trim()).filter(Boolean);

const selfAttachment = (filePath: string): Attachment => {
  const type = typeForPath(filePath);
  return { path: filePath, name: baseName(filePath), type, image: type.startsWith("image/") };
};

/**
 * Reads a sidecar as a record of its file. Its title is `title` from the front
 * matter, else its first heading, else the file's own name — never a line of
 * the description. Dublin Core's `subject` counts as tags. The file it
 * describes is its first attachment, so `has:photo` and `has:pdf` find it.
 * Throws FormatError when the YAML or a date can't be read, as an event would.
 */
export function parseSidecar(sidecar: string, source: string, filePath: string = sidecar.replace(SIDECAR, "")): Entry {
  const e = parseEntry(sidecar, source);
  const heading = /^#{1,6}\s+\S/.test(e.body.split("\n").find((l) => l.trim())?.trim() ?? "") ? e.title : "";
  e.title = scalar(e.meta.title) || heading || baseName(filePath);
  const tags = new Set([...e.tags, ...list(e.meta.subject).map(normalizeTag).filter(Boolean)]);
  e.tags = [...tags];
  e.attachments = [selfAttachment(filePath), ...e.attachments.filter((a) => a.path !== filePath)];
  return e;
}

/** A file with no sidecar, read as a record with nothing in it but its name. */
export function bareFileEntry(filePath: string): Entry {
  const date = dateFromFilename(filePath);
  return {
    id: filePath,
    path: filePath,
    title: baseName(filePath),
    date,
    dateFrom: date ? "filename" : "none",
    projects: [],
    tags: [],
    attachments: [selfAttachment(filePath)],
    links: [],
    meta: {},
    body: "",
  };
}

/**
 * Which events and notes link to each file: an attachment link to it, or a
 * link to its sidecar. Sidecars don't count as linking to anything.
 */
export function linkedFrom(files: StoredFile[], documents: Entry[]): Map<string, string[]> {
  const byTarget = new Map<string, string>();
  for (const f of files) {
    byTarget.set(f.path, f.path);
    if (f.sidecar) byTarget.set(f.sidecar, f.path);
  }
  const out = new Map<string, string[]>(files.map((f) => [f.path, []]));
  for (const d of documents) {
    if (inFiles(d.path)) continue;
    const hit = new Set<string>();
    for (const target of [...d.attachments.map((a) => a.path), ...d.links]) {
      const file = byTarget.get(target);
      if (file) hit.add(file);
    }
    for (const file of hit) out.get(file)!.push(d.path);
  }
  return out;
}
