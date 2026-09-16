// Many entries in one Markdown file, still readable on GitHub.
//
// A segment is an ordinary Markdown document. Each entry begins with an HTML
// comment carrying its permanent id and runs until the next one:
//
//   <!-- gitroll:entry 01K5F8ZC7M4Q0X2R9T6V3B1DHE -->
//
//   # AC serviced
//
//   Replaced the capacitor.
//
// Nothing else is written down for an entry logged as it happens: when it
// happened is the commit that added it, and which file it is in says the rest.
// An entry that happened at some other time says so in its own marker:
//
//   <!-- gitroll:entry 01K5F8ZC7M4Q0X2R9T6V3B1DHE 2026-03-14 -->
//
// so a month of entries reads as prose with invisible anchors between them,
// rather than as a stack of YAML blocks. (Front matter is only special at the
// top of a file: GitHub renders a mid-file one as a rule and some stray text.)
// Front matter still works inside an entry, for tags, amounts and anything else.
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
// Everything above the first entry is the file's header: a heading naming the
// period and a line saying what the file is. It belongs to no entry and is
// preserved as written.
//
// **A marker is what GitRoll writes, not what a reader requires.** This is a
// logbook: somebody can open 09.md in an editor and type
//
//   # Bought a drill
//
//   From the hardware shop on the corner.
//
// and that is an entry. A level-1 heading at the start of a line (outside
// fenced code) begins one, unless it is the heading the marker above it already
// introduced. An entry written that way has no permanent id until GitRoll next
// writes to that file, at which point it is given one and nothing else about it
// is touched — so a hand-written entry is a first-class entry from the moment
// it is saved, and becomes linkable the moment GitRoll notices.
//
// The one thing that rule costs: an entry whose body contains a second level-1
// heading reads as two entries. Use `##` for headings inside an entry, which is
// what GitRoll writes and what reads better anyway.

import { splitFrontMatter } from "./entry.ts";
import { isEntryId } from "./ids.ts";

// <!-- gitroll:entry <id> --> or, when the entry says when it happened,
// <!-- gitroll:entry <id> 2026-03-14 --> / <!-- gitroll:entry <id> 2026-03-14T09:00:00-05:00 -->
export const ENTRY_MARKER =
  /^<!--\s*gitroll:entry\s+([0-9A-HJKMNP-TV-Z]{26})(?:\s+(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})?)?))?\s*-->[ \t]*$/;
const ESCAPED_MARKER = /^[ \t]<!--\s*gitroll:(entry|escaped)\b/;
const NEEDS_ESCAPE = /^<!--\s*gitroll:(entry|escaped)\b/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

/** One entry as it sits in a segment file. */
export interface EntrySection {
  /** Empty for an entry somebody wrote by hand that hasn't been given one yet. */
  id: string;
  /**
   * When it happened, when the entry says so. It is written into the marker
   * only when GitRoll couldn't work it out otherwise — a backdated entry, or
   * one whose time of day matters. An entry logged as it happens says nothing,
   * and its moment is the commit that added it.
   */
  date?: string;
  /** Everything after the marker line: front matter, if any, and the body. */
  content: string;
  /** The whole section, marker line included, exactly as it will be written. */
  source: string;
  /** True when this entry has no marker: written by hand, and not yet adopted. */
  unmarked?: boolean;
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

const H1 = /^#\s+\S/;

/** Splits a segment into its header and its entries. Never throws: a malformed file still reads. */
export function parseSegment(text: string): ParsedSegment {
  const lines = text.replace(/^﻿/, "").split("\n");
  const starts: { line: number; id: string; date?: string; unmarked?: boolean }[] = [];
  let fence: string | null = null;
  // The marker whose own heading we haven't passed yet, so that heading isn't
  // mistaken for the start of a second entry.
  let openMarker = -1;
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
    if (m) {
      starts.push({ line: i, id: m[1], ...(m[2] ? { date: m[2] } : {}) });
      openMarker = i;
      continue;
    }
    if (!line.trim()) continue;
    // A heading somebody typed starts an entry of their own — unless it is the
    // heading the marker just above it introduces.
    if (H1.test(line)) {
      if (openMarker >= 0) openMarker = -1; // this is that marker's own heading
      else starts.push({ line: i, id: "", unmarked: true });
    }
  }
  const header = starts.length ? lines.slice(0, starts[0].line).join("\n") : lines.join("\n");
  const sections: EntrySection[] = [];
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (let n = 0; n < starts.length; n++) {
    const from = starts[n].line;
    const to = n + 1 < starts.length ? starts[n + 1].line : lines.length;
    const unmarked = !!starts[n].unmarked;
    const source = lines.slice(from, to).join("\n").replace(/\s*$/, "\n");
    // An unmarked entry has no marker line to skip: its first line is content.
    const body = lines.slice(unmarked ? from : from + 1, to).join("\n");
    const content = unescapeMarkers(body).replace(/^\s*\n/, "").replace(/\s*$/, "\n");
    if (starts[n].id) {
      if (seen.has(starts[n].id)) duplicates.push(starts[n].id);
      seen.add(starts[n].id);
    }
    sections.push({ id: starts[n].id, ...(starts[n].date ? { date: starts[n].date } : {}), content, source, ...(unmarked ? { unmarked: true } : {}) });
  }
  return { header, sections, duplicates };
}

/** The text of one entry section, ready to write. */
export function renderSection(id: string, content: string, date?: string): string {
  const marker = `<!-- gitroll:entry ${id}${date ? ` ${date}` : ""} -->`;
  const text = escapeMarkers(content).replace(/^\s*\n/, "").trimEnd();
  return text ? `${marker}\n\n${text}\n` : `${marker}\n`;
}

/** A whole segment file: header, then entries in the order given, separated by a blank line. */
export function renderSegment(header: string, sections: { id: string; content: string; date?: string }[]): string {
  const head = header.trim() ? `${header.trimEnd()}\n\n` : "";
  return head + sections.map((s) => renderSection(s.id, s.content, s.date)).join("\n");
}

/**
 * The header a new segment starts with: what the file holds, in one line.
 *
 * Deliberately not a heading. In a file where anyone may type `# Something` to
 * log something, a level-1 heading means "an entry starts here" and nothing
 * else — including at the top of the file.
 */
export function segmentHeader(period: string, seq: number): string {
  const label = period.length > 7 ? readableDay(period) : readableMonth(period);
  const part = seq > 1 ? `, part ${seq}` : "";
  return `<!-- gitroll:log ${period}${seq > 1 ? ` ${seq}` : ""} -->\n\n*${label}${part} — a [GitRoll](https://github.com/jimhoyd-com/gitroll) log. Write an entry by starting a line with \`#\`.*\n`;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const readableMonth = (period: string) => `${MONTHS[Number(period.slice(5, 7)) - 1]} ${period.slice(0, 4)}`;
const readableDay = (period: string) => `${Number(period.slice(8, 10))} ${MONTHS[Number(period.slice(5, 7)) - 1]} ${period.slice(0, 4)}`;

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
