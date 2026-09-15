// The shape of a Roll on disk, and the rules for writing to it. Pure: no Node
// or browser APIs, so the CLI, the local server and GitRoll.com all behave the
// same way.
//
//   my-roll/
//   ├── README.md
//   ├── gitroll.yaml          template_version: 1
//   ├── events/               one Markdown file per event
//   │   └── 2026-09-15-ac-serviced.md
//   └── files/                receipts and photos, created when first needed
//       └── ac-receipt.pdf

import { parse } from "yaml";
import { baseName, entryFilename, newEntrySource, relativeLink, relinkBody, splitFrontMatter, updateEntrySource } from "./entry.ts";
import type { Amount, Entry, MetaChanges, Source } from "./entry.ts";
import { NotFoundError, UserError, isoDate, slugify, summarize } from "./util.ts";

/** The template revision this build of GitRoll knows how to write. */
export const TEMPLATE_VERSION = 1;
/** The root file that marks a folder as a Roll and records its template version. */
export const MARKER_PATH = "gitroll.yaml";
export const EVENTS_DIR = "events";
export const FILES_DIR = "files";

export const EVENT_FILE = /^events\/(?:[^/]+\/)*[^/]+\.md$/i;

export interface Config {
  /** From gitroll.yaml. null when the file has no template_version: the version is unknown, not current. */
  templateVersion: number | null;
  name: string;
  /** Per-file attachment limit in MB (attachments.max_mb). Optional. */
  maxAttachmentMb?: number;
  /** Remove GPS location from photos before saving (attachments.remove_location, default true). */
  removeLocation: boolean;
  /** Whether "Ask your Roll" may be used with this Roll (ai: false turns it off for everyone). */
  aiAllowed: boolean;
}

/** An event read from a Roll. Its path is its identity, so nothing extra is needed. */
export type LoadedEntry = Entry;

export interface Problem {
  path: string;
  error: string;
}

export interface HistoryItem {
  commit: string;
  author: string;
  date: string;
  subject: string;
  patch: string;
}

export interface EntryInput {
  /** The event's heading. Optional: the first line of the text is used instead. */
  title?: string;
  text: string;
  /** ISO date or date-time. Defaults to today; an empty string leaves the event undated. */
  date?: string;
  projects?: string[];
  tags?: string[];
  amount?: Amount;
  source?: Source;
  /** A subfolder of events/, for people who organize. Optional. */
  folder?: string;
}

export interface EntryChanges {
  text?: string;
  title?: string;
  /** Empty string or null removes the date from the front matter. */
  date?: string | null;
  projects?: string[];
  tags?: string[];
  /** null removes the amount. */
  amount?: Amount | null;
}

/** A file to link from an event. */
export interface EntryLink {
  path: string;
  name: string;
  image: boolean;
}

// ── gitroll.yaml ───────────────────────────────────────────────────────────

export function parseConfig(text: string, fallbackName: string): Config {
  const data = (parse(text) ?? {}) as Record<string, unknown>;
  const raw = data.template_version;
  const version = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw) : Number.NaN;
  return {
    templateVersion: Number.isInteger(version) && version > 0 ? version : null,
    name: typeof data.name === "string" && data.name ? data.name : fallbackName,
    maxAttachmentMb: maxMb(data.attachments),
    removeLocation: !(data.attachments && typeof data.attachments === "object" && (data.attachments as Record<string, unknown>).remove_location === false),
    aiAllowed: data.ai !== false,
  };
}

function maxMb(v: unknown): number | undefined {
  const mb = v && typeof v === "object" ? Number((v as Record<string, unknown>).max_mb) : Number.NaN;
  return Number.isFinite(mb) && mb > 0 ? mb : undefined;
}

/** The marker a new Roll starts with. Nothing else is required. */
export const serializeConfig = (name?: string): string =>
  `# Which GitRoll template this repository follows. GitRoll reads this file; it never changes it for you.\ntemplate_version: ${TEMPLATE_VERSION}\n${
    name ? `name: ${JSON.stringify(name)}\n` : ""
  }`;

export type TemplateCode = "ok" | "unknown" | "unsupported";

export interface TemplateStatus {
  code: TemplateCode;
  version: number | null;
  /** Whether this build of GitRoll may write to the Roll. */
  writable: boolean;
  message: string;
}

/**
 * What this build of GitRoll can do with a repository's template version.
 * A newer version is refused outright. An unrecorded one is reported as unknown
 * and never filled in silently: writing a version GitRoll only guessed would
 * change someone's repository behind their back.
 */
export function templateStatus(cfg: Config | null): TemplateStatus {
  const version = cfg?.templateVersion ?? null;
  if (version === null) {
    return {
      code: "unknown",
      version: null,
      writable: true,
      message:
        `This Roll doesn't record a template version, so its version is unknown. GitRoll is reading it as template ${TEMPLATE_VERSION} ` +
        `and will not change gitroll.yaml on its own. To record it: gitroll template --set ${TEMPLATE_VERSION}`,
    };
  }
  if (version > TEMPLATE_VERSION) {
    return {
      code: "unsupported",
      version,
      writable: false,
      message:
        `This Roll uses template version ${version}; this GitRoll understands up to ${TEMPLATE_VERSION}. ` +
        "Nothing was changed. Update GitRoll (gitroll upgrade) and try again.",
    };
  }
  return { code: "ok", version, writable: true, message: `Template version ${version}.` };
}

/** Checked before anything is written, so an unsupported Roll is never half-changed. */
export function requireWritable(cfg: Config | null): TemplateStatus {
  const status = templateStatus(cfg);
  if (!status.writable) throw new UserError(status.message);
  return status;
}

// ── Paths and names ────────────────────────────────────────────────────────

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** A readable, safe file name for something GitRoll stores in files/. */
export function attachmentName(name: string): string {
  const raw = baseName((name ?? "").replace(/\\/g, "/")).trim();
  const dot = raw.lastIndexOf(".");
  const stem = dot > 0 ? raw.slice(0, dot) : raw;
  const ext = dot > 0 ? raw.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 10) : "";
  const clean = slugify(stem).slice(0, 60).replace(/-+$/, "");
  const safe = !clean || RESERVED.test(clean) ? "file" : clean;
  return ext ? `${safe}.${ext}` : safe;
}

/**
 * The same name with a number added until it is free, so a second ac-receipt.pdf
 * becomes ac-receipt-2.pdf. Nothing is ever overwritten.
 */
export function freePath(dir: string, name: string, taken: (path: string) => boolean): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  const at = (n: number) => `${dir ? `${dir}/` : ""}${stem}${n > 1 ? `-${n}` : ""}${ext}`;
  for (let n = 1; n < 10_000; n++) if (!taken(at(n))) return at(n);
  throw new UserError(`Too many files called ${name}.`);
}

export const filePath = (name: string, taken: (path: string) => boolean): string => freePath(FILES_DIR, attachmentName(name), taken);

/** Where a new event goes: events/[folder/]YYYY-MM-DD-title.md, with a name that is free. */
export function entryPath(date: string | null, title: string, taken: (path: string) => boolean, folder = ""): string {
  const dir = [EVENTS_DIR, ...folder.split("/").map((s) => slugify(s)).filter(Boolean)].join("/");
  return freePath(dir, entryFilename(date, title), taken);
}

/** Newest first. Undated events sort last, in path order. */
export const sortEntries = <T extends Entry>(entries: T[]): T[] =>
  entries.sort((a, b) => {
    if (!a.date || !b.date) return a.date ? -1 : b.date ? 1 : a.path.localeCompare(b.path);
    return b.date.localeCompare(a.date) || b.path.localeCompare(a.path);
  });

/** Finds an event by path, file name, or a distinctive part of either. */
export function findEntry<T extends Entry>(all: T[], idOrPart: string): T {
  const q = idOrPart.trim().replace(/^\.?\//, "");
  const exact = all.find((e) => e.path === q);
  if (exact) return exact;
  const lower = q.toLowerCase();
  const withMd = lower.endsWith(".md") ? lower : `${lower}.md`;
  const byName = all.filter((e) => baseName(e.path).toLowerCase() === withMd);
  if (byName.length === 1) return byName[0];
  const matches = all.filter((e) => e.path.toLowerCase().includes(lower) || e.title.toLowerCase() === lower);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new UserError(`More than one event matches "${idOrPart}":\n  ${matches.slice(0, 8).map((e) => e.path).join("\n  ")}`);
  }
  throw new NotFoundError(`No event matches "${idOrPart}". Try: gitroll recent`);
}

// ── Writing events ─────────────────────────────────────────────────────────

const metaFor = (input: EntryChanges & { source?: Source }): MetaChanges => ({
  ...(input.title !== undefined ? { title: input.title || null } : {}),
  ...(input.date !== undefined ? { date: input.date || null } : {}),
  ...(input.projects !== undefined ? { projects: input.projects?.length ? input.projects : null } : {}),
  ...(input.tags !== undefined ? { tags: input.tags?.length ? input.tags : null } : {}),
  ...(input.amount !== undefined ? { amount: input.amount ?? null } : {}),
  ...(input.source ? { source: input.source } : {}),
});

const linkLines = (links: EntryLink[], at: string): string =>
  links.map((l) => `${l.image ? "!" : ""}[${l.name}](${relativeLink(at, l.path)})`).join("\n\n");

/** Markdown for an event written through GitRoll: a heading, the text, then links to any files. */
export function entryBody(title: string, text: string, links: EntryLink[], at: string): string {
  const parts: string[] = [];
  if (title.trim()) parts.push(`# ${title.trim()}`);
  if (text.trim()) parts.push(text.trim());
  if (links.length) parts.push(linkLines(links, at));
  return parts.join("\n\n");
}

export interface DraftEntry {
  path: string;
  source: string;
  title: string;
  date: string | null;
}

/**
 * Turns an input into a file: where it goes, and its Markdown. The title becomes
 * the heading rather than a metadata key, so a file GitRoll wrote and one
 * somebody typed look the same.
 */
export function buildEntry(input: EntryInput, links: EntryLink[], taken: (path: string) => boolean, now = new Date()): DraftEntry {
  const text = (input.text ?? "").trim();
  const explicitTitle = (input.title ?? "").trim();
  const title = explicitTitle || summarize(text, 60) || (links[0]?.name ?? "");
  if (!title) throw new UserError("Nothing to log: add some text or a file");
  const date = input.date === "" ? null : input.date ? normalizeOrThrow(input.date) : isoDate(now);
  const path = entryPath(date, title, taken, input.folder ?? "");
  // The first line of the text became the heading, so don't repeat it in the body.
  const rest = explicitTitle || text !== title ? text : "";
  const body = entryBody(title, rest, links, path);
  const meta = metaFor({ projects: input.projects, tags: input.tags, amount: input.amount, source: input.source });
  return { path, source: newEntrySource(body, meta), title, date };
}

function normalizeOrThrow(date: string): string {
  const d = date.trim();
  if (/^\d{4}-\d{2}-\d{2}(T|$)/.test(d)) return d;
  const parsed = new Date(d);
  if (Number.isNaN(parsed.getTime())) throw new UserError(`Invalid date: ${date} (use 2026-09-15)`);
  return isoDate(parsed);
}

const bodyOf = (source: string) => splitFrontMatter(source).body.replace(/^\s*\n/, "").trimEnd();

/**
 * Applies changes to an event file's text. Untouched metadata, comments,
 * handwritten formatting and links all survive: only the keys that changed are
 * rewritten, and the body is left alone unless new text was supplied.
 */
export function applyChanges(source: string, changes: EntryChanges, added: EntryLink[], at: string): string {
  const meta = metaFor(changes);
  let body: string | undefined;
  if (changes.text !== undefined || added.length) {
    body = changes.text !== undefined ? changes.text.trim() : bodyOf(source);
    if (added.length) body = `${body.trimEnd()}\n\n${linkLines(added, at)}`;
  }
  return updateEntrySource(source, meta, body);
}

export const commitMessage = (kind: "log" | "edit" | "delete" | "restore" | "move", e: { title: string; path: string }) =>
  `${kind}: ${summarize(e.title || baseName(e.path))}`;

/** Moving an event rewrites its relative links, so its receipts and photos still resolve. */
export function moveEntry(source: string, fromPath: string, toPath: string): string {
  return updateEntrySource(source, {}, relinkBody(bodyOf(source), fromPath, toPath));
}

// ── Untrusted input ────────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const textList = (v: unknown): string[] =>
  (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" ? v.split(",") : [])
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 50);

export function amountFrom(v: unknown): Amount | undefined {
  if (!isRecord(v)) return undefined;
  const value = Number(v.value);
  if (v.value === "" || v.value == null || !Number.isFinite(value)) return undefined;
  return { value, currency: (text(v.currency) || "USD").toUpperCase().slice(0, 3) };
}

/** Validates untrusted JSON into an EntryInput. */
export function entryInputFrom(body: Record<string, unknown>): EntryInput {
  return {
    title: text(body.title).slice(0, 200) || undefined,
    text: text(body.text).slice(0, 100_000),
    date: body.date === undefined ? undefined : text(body.date),
    projects: textList(body.projects),
    tags: textList(body.tags),
    amount: amountFrom(body.amount),
  };
}

/** Validates untrusted JSON into EntryChanges. Absent keys mean "leave unchanged". */
export function entryChangesFrom(body: Record<string, unknown>): EntryChanges {
  const changes: EntryChanges = {};
  if (body.text !== undefined) changes.text = text(body.text).slice(0, 100_000);
  if (body.title !== undefined) changes.title = text(body.title).slice(0, 200);
  if (body.date !== undefined) changes.date = text(body.date) || null;
  if (body.projects !== undefined) changes.projects = textList(body.projects);
  if (body.tags !== undefined) changes.tags = textList(body.tags);
  if (body.amount !== undefined) changes.amount = amountFrom(body.amount) ?? null;
  return changes;
}

// ── A new Roll ─────────────────────────────────────────────────────────────

export function repoReadme(name: string): string {
  return `# ${name}

A [GitRoll](https://github.com/jimhoyd-com/gitroll) log: a chronological record of what happened,
kept as ordinary Markdown files in Git. Git and a text editor are all you need.

## Log something

1. Create a Markdown file in \`events/\`, named with the date and what happened:

   \`\`\`
   events/2026-09-15-ac-serviced.md
   \`\`\`

2. Write what happened, and link any file you want to keep with it:

   \`\`\`markdown
   # AC serviced

   Replaced the capacitor. Paid $325.
   One-year warranty on the repair.

   [Receipt](../files/ac-receipt.pdf)
   \`\`\`

   Put the receipt itself in \`files/\` (create that folder the first time you need it).

3. Commit and push:

   \`\`\`sh
   git add .
   git commit -m "AC serviced"
   git push
   \`\`\`

That is the whole format. No front matter, no ids, no timestamps.

## Optional metadata

Add YAML front matter when you want totals, filters, or a date that differs from the file name:

\`\`\`markdown
---
date: 2026-09-15
projects: [house]
tags: [maintenance, warranty]
amount: 325
currency: USD
---

# AC serviced

Replaced the capacitor.

[Receipt](../files/ac-receipt.pdf)
\`\`\`

Projects and tags are just words; nothing has to be defined anywhere first. \`amount\` and
\`currency\` are what totals add up, so an amount you want counted goes there. An amount written
only in prose stays prose.

The date comes from the file name unless the front matter says otherwise. If neither gives a
date, the event shows as undated. Subfolders under \`events/\` are fine: organize whenever you
feel like it.

## Using GitRoll (optional)

GitRoll is a reader and writer for this folder. It writes exactly the format above.

\`\`\`sh
gitroll                                  # open the app
gitroll log "AC serviced" ac-receipt.pdf # log an event, attaching a file
gitroll find "capacitor"                 # search
\`\`\`

\`gitroll.yaml\` records which template revision this repository follows:

\`\`\`yaml
template_version: 1
\`\`\`

GitRoll reads it to know how to treat the repository, and never changes it while logging or
editing. Template upgrades are a separate, reviewable step.

**Keep this repository private if what you log is private.**
`;
}

/** The files a new Roll starts with. Data only: no code, tooling or workflows. */
export function starterFiles(name: string): Record<string, string> {
  return {
    [MARKER_PATH]: serializeConfig(name),
    "README.md": repoReadme(name),
    ".gitattributes": "*.md text eol=lf\n*.yaml text eol=lf\nfiles/** -text\n",
  };
}
