// Checks a Roll against the format. Everything here is advisory except the
// template version: a Roll of plain Markdown files can hardly be "invalid", so
// the checks look for the things that actually bite — a link to a file that
// isn't there, front matter that won't parse, a date nothing can read.

import { FormatError, parseEntry, resolveLink } from "./entry.ts";
import { EVENT_FILE, EVENTS_DIR, MARKER_PATH, TEMPLATE_FILE, parseConfig, templateStatus } from "./layout.ts";
import type { Problem } from "./layout.ts";

export interface ValidateSource {
  /** Every repository-relative path (posix separators), excluding .git. */
  paths: string[];
  read(path: string): string;
  /** Reads one of the Roll's own template files. Absent when the caller has no template reader. */
  template?(path: string, source: string): { id: string } | null;
  /** Symbolic links found in the Roll. They're never followed and always reported. */
  links?: string[];
}

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
    if (!p.startsWith(`${EVENTS_DIR}/`)) continue;
    if (!EVENT_FILE.test(p)) {
      add(p, "events are Markdown files (.md); anything else belongs in files/");
      continue;
    }
    try {
      const entry = parseEntry(p, src.read(p));
      if (!entry.date) warn(p, "no date: name the file 2026-09-15-something.md, or add date: to the front matter");
      for (const a of entry.attachments) {
        if (!present.has(a.path)) warn(p, `links to ${a.path}, which isn't in this Roll`);
      }
      // A link from one event to another that leads nowhere is a broken
      // reference — usually an event that was moved or renamed by hand.
      for (const target of entry.links) {
        if (!present.has(target)) add(p, `links to ${target}, which isn't in this Roll`);
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
