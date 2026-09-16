// Many entries in one Markdown file, still readable on GitHub.
//
// A segment is an ordinary Markdown document. Each entry begins with an HTML
// comment carrying its permanent id and runs until the next one:
//
//   <!-- gitroll:entry 01K5F8ZC7M4Q0X2R9T6V3B1DHE -->
//   ---
//   date: 2026-09-16T14:30:00-05:00
//   filed: 2026-09-16
//   created: 2026-09-16T14:31:02-05:00
//   ---
//
//   # AC serviced
//
//   Replaced the capacitor.
//
// The comment renders as nothing, so the file reads as a plain log; the id is
// right there in the source when you need it. Boundaries are unambiguous
// because the marker is matched only at the start of a line and only outside
// fenced code — so an entry body may contain headings, checklists, thematic
// breaks, and code fences showing GitRoll markers, all without escaping. A
// marker written at column 0 *outside* a fence is the one case that would be
// ambiguous, and a writer indents it by one space (which Markdown renders
// identically); reading undoes that.
//
// Everything above the first marker is the file's header: a heading naming the
// period and a line saying what the file is. It belongs to no entry and is
// preserved as written.

import { splitFrontMatter } from "./entry.ts";
import { isEntryId } from "./ids.ts";

export const ENTRY_MARKER = /^<!--\s*gitroll:entry\s+([0-9A-HJKMNP-TV-Z]{26})\s*-->[ \t]*$/;
const ESCAPED_MARKER = /^[ \t]<!--\s*gitroll:(entry|escaped)\b/;
const NEEDS_ESCAPE = /^<!--\s*gitroll:(entry|escaped)\b/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

/** One entry as it sits in a segment file. */
export interface EntrySection {
  id: string;
  /** Everything after the marker line: front matter, if any, and the body. */
  content: string;
  /** The whole section, marker line included, exactly as it will be written. */
  source: string;
}

export interface ParsedSegment {
  /** Whatever came before the first entry, verbatim. */
  header: string;
  sections: EntrySection[];
  /** Ids seen more than once in this file, which a reader must not silently collapse. */
  duplicates: string[];
}

/** The anchor an internal link uses to point at an entry: ...09.md#gr-<id> */
export const entryAnchor = (id: string): string => `gr-${id.toLowerCase()}`;

/** The id an anchor names, or null. */
export function idFromAnchor(fragment: string): string | null {
  const m = /^#?gr-([0-9a-hjkmnp-tv-z]{26})$/i.exec(fragment.trim());
  return m && isEntryId(m[1].toUpperCase()) ? m[1].toUpperCase() : null;
}

/** Splits a segment into its header and its entries. Never throws: a malformed file still reads. */
export function parseSegment(text: string): ParsedSegment {
  const lines = text.replace(/^﻿/, "").split("\n");
  const starts: { line: number; id: string }[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = FENCE.exec(line);
    if (f) {
      if (!fence) fence = f[1][0].repeat(3);
      else if (line.trimStart().startsWith(fence)) fence = null;
      continue;
    }
    if (fence) continue;
    const m = ENTRY_MARKER.exec(line);
    if (m) starts.push({ line: i, id: m[1] });
  }
  const header = starts.length ? lines.slice(0, starts[0].line).join("\n") : lines.join("\n");
  const sections: EntrySection[] = [];
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (let n = 0; n < starts.length; n++) {
    const from = starts[n].line;
    const to = n + 1 < starts.length ? starts[n + 1].line : lines.length;
    const source = lines.slice(from, to).join("\n").replace(/\s*$/, "\n");
    const content = unescapeMarkers(lines.slice(from + 1, to).join("\n")).replace(/^\s*\n/, "").replace(/\s*$/, "\n");
    if (seen.has(starts[n].id)) duplicates.push(starts[n].id);
    seen.add(starts[n].id);
    sections.push({ id: starts[n].id, content, source });
  }
  return { header, sections, duplicates };
}

/** The text of one entry section, ready to write. */
export function renderSection(id: string, content: string): string {
  return `<!-- gitroll:entry ${id} -->\n${escapeMarkers(content).replace(/^\s*\n/, "").trimEnd()}\n`;
}

/** A whole segment file: header, then entries in the order given, separated by a blank line. */
export function renderSegment(header: string, sections: { id: string; content: string }[]): string {
  const head = header.trim() ? `${header.trimEnd()}\n\n` : "";
  return head + sections.map((s) => renderSection(s.id, s.content)).join("\n") ;
}

/** The header a new segment starts with: what the file holds, in one line. */
export function segmentHeader(period: string, seq: number): string {
  const label = period.length > 7 ? period : `${period} (month)`;
  const part = seq > 1 ? `, part ${seq}` : "";
  return `# ${label}${part}\n\nA [GitRoll](https://github.com/jimhoyd-com/gitroll) log. Each entry below starts with a comment holding its permanent id.\n`;
}

/** Entry bodies may talk about GitRoll's own markers; indent those so they stay text. */
function escapeMarkers(content: string): string {
  return withoutFences(content, (line) => (NEEDS_ESCAPE.test(line) ? ` ${line}` : line));
}

function unescapeMarkers(content: string): string {
  return withoutFences(content, (line) => (ESCAPED_MARKER.test(line) ? line.slice(1) : line));
}

function withoutFences(content: string, map: (line: string) => string): string {
  let fence: string | null = null;
  return content
    .split("\n")
    .map((line) => {
      const f = FENCE.exec(line);
      if (f) {
        if (!fence) fence = f[1][0].repeat(3);
        else if (line.trimStart().startsWith(fence)) fence = null;
        return line;
      }
      return fence ? line : map(line);
    })
    .join("\n");
}

/**
 * The entry's front matter and body, split the same way a per-event file is.
 * A grouped entry and a standalone one are the same document; only the
 * surrounding file differs.
 */
export const sectionParts = (section: EntrySection): { frontMatter: string | null; body: string } => splitFrontMatter(section.content);
