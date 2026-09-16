// Checks a Roll against the format. Everything here is advisory except the
// template version: a Roll of plain Markdown files can hardly be "invalid", so
// the checks look for the things that actually bite — a link to a file that
// isn't there, front matter that won't parse, a date nothing can read.

import { FormatError, parseEntry, resolveLink } from "./entry.ts";
import { parseSegment } from "./grouped.ts";
import { EVENT_FILE, EVENTS_DIR, MARKER_PATH, parseConfig, templateStatus } from "./layout.ts";
import type { Problem } from "./layout.ts";
import { SEGMENT_FILE } from "./segments.ts";

export interface ValidateSource {
  /** Every repository-relative path (posix separators), excluding .git. */
  paths: string[];
  read(path: string): string;
  /** Symbolic links found in the Roll. They're never followed and always reported. */
  links?: string[];
}

const IGNORED = /(^|\/)(\.gitkeep|\.DS_Store|\.gitattributes|\.gitignore)$/;

/** Returns an empty list when the Roll is in good shape. */
export function validateRepo(src: ValidateSource): Problem[] {
  const problems: Problem[] = [];
  const add = (path: string, error: string) => problems.push({ path, error });
  const paths = [...new Set(src.paths)].sort();
  const present = new Set(paths);
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

  for (const p of paths.filter((x) => SEGMENT_FILE.test(x))) {
    // Entries sharing a file get the same checks as entries with one each: a
    // link to a receipt that isn't there is the thing that actually bites.
    try {
      const parsed = parseSegment(src.read(p));
      for (const id of parsed.duplicates) add(p, `two entries in this file both claim the id ${id}`);
      for (const section of parsed.sections) {
        const entry = parseEntry(p, section.content);
        const what = section.id ? section.id.slice(-6).toLowerCase() : entry.title;
        for (const a of entry.attachments) if (!present.has(a.path)) add(p, `${what} links to ${a.path}, which isn't in this Roll`);
        for (const target of unresolvableLinks(p, entry.body)) add(p, `${what}: link ${target} points outside the Roll`);
      }
    } catch (e) {
      add(p, e instanceof FormatError ? e.message : `unreadable: ${(e as Error).message}`);
    }
  }

  for (const p of paths) {
    if (IGNORED.test(p)) continue;
    if (!p.startsWith(`${EVENTS_DIR}/`)) continue;
    if (!EVENT_FILE.test(p)) {
      add(p, "events are Markdown files (.md); anything else belongs in files/");
      continue;
    }
    try {
      const entry = parseEntry(p, src.read(p));
      if (!entry.date) add(p, "no date: name the file 2026-09-15-something.md, or add date: to the front matter");
      for (const a of entry.attachments) {
        if (!present.has(a.path)) add(p, `links to ${a.path}, which isn't in this Roll`);
      }
      for (const target of unresolvableLinks(p, entry.body)) add(p, `link ${target} points outside the Roll`);
    } catch (e) {
      add(p, e instanceof FormatError ? e.message : `unreadable: ${(e as Error).message}`);
    }
  }
  return problems;
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
