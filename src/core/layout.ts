// Repository layout and event operations. Pure: no Node or browser APIs,
// so the same rules apply in the CLI, the local server and the web interface.

import { parse, stringify } from "yaml";
import { DEFAULT_TYPE, FORMAT_VERSION, TYPE_ID, extractHashtags, normalizeTag } from "./entry.ts";
import type { Amount, Attachment, Entry, Source } from "./entry.ts";
import { uuidv7 } from "./id.ts";
import { NotFoundError, UserError, basename, isoLocal, normalizeTimestamp, slugify, summarize, uniq } from "./util.ts";

export const CONFIG_PATH = ".gitroll/config.yaml";

export interface Config {
  version: number;
  name: string;
  author?: string;
  /** Per-file attachment limit in MB (attachments.max_mb). */
  maxAttachmentMb?: number;
  /** Remove GPS location from photos before saving (attachments.remove_location, default true). */
  removeLocation: boolean;
  /** Whether "Ask your Roll" may be used with this Roll (ai: false turns it off for everyone). */
  aiAllowed: boolean;
}

export interface Project {
  slug: string;
  name: string;
  description?: string;
  created?: string;
}

export interface LoadedEntry extends Entry {
  /** Repository-relative path, e.g. entries/2026/09/<id>.md */
  path: string;
}

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
  text: string;
  type?: string;
  occurred?: string;
  projects?: string[];
  tags?: string[];
  amount?: Amount;
  data?: Record<string, unknown>;
  source?: Source;
}

export interface EntryChanges {
  text?: string;
  type?: string;
  /** Empty string resets to the created time. */
  occurred?: string;
  projects?: string[];
  tags?: string[];
  /** null removes the amount. */
  amount?: Amount | null;
  /** Replaces the structured fields. */
  data?: Record<string, unknown>;
  removeAttachments?: string[];
}

export const entryPath = (created: string, id: string) => `entries/${created.slice(0, 4)}/${created.slice(5, 7)}/${id}.md`;
export const projectPath = (slug: string) => `projects/${slug}.yaml`;
export const attachmentPath = (hex: string, ext: string) => `attachments/${hex}${ext}`;
export const ENTRY_FILE = /^entries\/(?:.+\/)?([^/]+)\.md$/;
export const ATTACHMENT_FILE = /^attachments\/([a-f0-9]{64})(\.[a-z0-9]{1,10})?$/;
export const PROJECT_FILE = /^projects\/([^/]+)\.ya?ml$/;

export function parseConfig(text: string, fallbackName: string): Config {
  const data = (parse(text) ?? {}) as Record<string, unknown>;
  return {
    version: Number(data.version ?? FORMAT_VERSION),
    name: typeof data.name === "string" && data.name ? data.name : fallbackName,
    author: typeof data.author === "string" && data.author ? data.author : undefined,
    maxAttachmentMb: maxMb(data.attachments),
    removeLocation: !(data.attachments && typeof data.attachments === "object" && (data.attachments as Record<string, unknown>).remove_location === false),
    aiAllowed: data.ai !== false,
  };
}

function maxMb(v: unknown): number | undefined {
  const mb = v && typeof v === "object" ? Number((v as Record<string, unknown>).max_mb) : NaN;
  return Number.isFinite(mb) && mb > 0 ? mb : undefined;
}

export const serializeConfig = (name: string) => stringify({ version: FORMAT_VERSION, name });

export function parseProject(slug: string, text: string): Project {
  let data: Record<string, unknown> = {};
  try {
    data = (parse(text) ?? {}) as Record<string, unknown>;
  } catch {
    // An unreadable project file still names a project.
  }
  return {
    slug,
    name: typeof data.name === "string" && data.name ? data.name : slug,
    description: typeof data.description === "string" ? data.description : undefined,
    created: data.created ? String(data.created) : undefined,
  };
}

export function serializeProject(name: string, description?: string): string {
  const data: Record<string, unknown> = { name };
  if (description) data.description = description;
  data.created = isoLocal();
  return stringify(data);
}

export const sortEntries = <T extends Entry>(entries: T[]): T[] =>
  entries.sort((a, b) => Date.parse(b.occurred) - Date.parse(a.occurred) || b.id.localeCompare(a.id));

const mergeTags = (tags: string[], text: string) =>
  uniq([...tags, ...extractHashtags(text)].map(normalizeTag).filter(Boolean));

function checkType(type: string | undefined): string {
  const t = (type ?? "").trim().toLowerCase() || DEFAULT_TYPE;
  if (!TYPE_ID.test(t)) throw new UserError(`Invalid event type: ${type}`);
  return t;
}

export function attachmentName(name: string, hex: string, ext: string): string {
  return basename(name).replace(/[\u0000-\u001f]/g, "").trim().slice(0, 200) || `${hex.slice(0, 12)}${ext}`;
}

export function buildEntry(input: EntryInput, author: string, attachments: Attachment[], now = new Date()): LoadedEntry {
  const text = (input.text ?? "").trim();
  if (!text && attachments.length === 0) throw new UserError("Nothing to log: add some text or a file");
  const created = isoLocal(now);
  const id = uuidv7(now.getTime());
  const entry: LoadedEntry = {
    version: FORMAT_VERSION,
    id,
    type: checkType(input.type),
    created,
    occurred: input.occurred ? normalizeTimestamp(input.occurred) : created,
    author,
    projects: uniq((input.projects ?? []).map(slugify).filter(Boolean)),
    tags: mergeTags(input.tags ?? [], text),
    attachments,
    data: { ...(input.data ?? {}) },
    extra: {},
    body: text,
    path: entryPath(created, id),
  };
  if (input.amount) entry.amount = input.amount;
  if (input.source) {
    if (!input.source.adapter || !input.source.id) throw new UserError("source needs an adapter and an id");
    entry.source = { ...input.source };
  }
  return entry;
}

export function applyChanges(cur: LoadedEntry, changes: EntryChanges, added: Attachment[]): LoadedEntry {
  const next: LoadedEntry = { ...cur, attachments: [...cur.attachments], data: { ...cur.data }, extra: { ...cur.extra } };
  if (changes.text !== undefined) next.body = changes.text.trim();
  if (changes.type !== undefined) next.type = checkType(changes.type);
  if (changes.occurred !== undefined) next.occurred = changes.occurred ? normalizeTimestamp(changes.occurred) : cur.created;
  if (changes.projects) next.projects = uniq(changes.projects.map(slugify).filter(Boolean));
  next.tags = mergeTags(changes.tags ?? cur.tags, changes.text !== undefined ? next.body : "");
  if (changes.amount === null) delete next.amount;
  else if (changes.amount) next.amount = changes.amount;
  if (changes.data) next.data = { ...changes.data };
  if (changes.removeAttachments?.length) {
    const rm = new Set(changes.removeAttachments);
    next.attachments = next.attachments.filter((a) => !rm.has(a.hash));
  }
  for (const a of added) if (!next.attachments.some((x) => x.hash === a.hash)) next.attachments.push(a);
  if (!next.body && next.attachments.length === 0) throw new UserError("An entry needs text or at least one attachment");
  return next;
}

export function findEntry<T extends Entry>(all: T[], idOrPart: string): T {
  const q = idOrPart.trim().toLowerCase();
  const exact = all.find((e) => e.id.toLowerCase() === q);
  if (exact) return exact;
  const matches = q.length >= 6 ? all.filter((e) => e.id.toLowerCase().startsWith(q) || e.id.toLowerCase().endsWith(q)) : [];
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new UserError(`Ambiguous id: ${idOrPart}`);
  throw new NotFoundError(`No entry with id ${idOrPart}`);
}

export const sourceKey = (s: Source) => `${s.adapter}\u0000${s.id}`;

export const commitMessage = (kind: "log" | "edit" | "delete" | "restore", e: Entry) =>
  `${kind}${e.type !== DEFAULT_TYPE ? `(${e.type})` : ""}: ${summarize(e.body || e.attachments[0]?.name || e.id)}`;

export function repoReadme(name: string): string {
  return `# ${name}

A [GitRoll](https://github.com/jimhoyd-com/gitroll) log: a private, chronological record of what happened.

- \`entries/YYYY/MM/<id>.md\`: one Markdown file per event, with YAML front matter
- \`projects/<slug>.yaml\`: projects that events reference
- \`attachments/<sha256>.<ext>\`: photos, receipts and documents, named by content hash
- \`.gitroll/types/<id>.yaml\`: optional custom event types

Every file uses an ordinary format. Edit files directly, commit, and push; GitRoll picks up the changes.
Run \`gitroll check\` to validate the Roll locally. No GitHub Actions are needed.

**Keep this repository private.**
`;
}

// ── Shared request parsing (local server and GitRoll.com) ───────────────────

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
    text: text(body.text).slice(0, 100_000),
    type: text(body.type) || undefined,
    data: isRecord(body.data) ? body.data : undefined,
    occurred: text(body.occurred) || undefined,
    projects: textList(body.projects),
    tags: textList(body.tags),
    amount: amountFrom(body.amount),
  };
}

/** Validates untrusted JSON into EntryChanges. Absent keys mean "leave unchanged". */
export function entryChangesFrom(body: Record<string, unknown>): EntryChanges {
  const changes: EntryChanges = { removeAttachments: textList(body.removeAttachments) };
  if (body.text !== undefined) changes.text = text(body.text).slice(0, 100_000);
  if (body.type !== undefined) changes.type = text(body.type);
  if (isRecord(body.data)) changes.data = body.data;
  if (body.occurred !== undefined) changes.occurred = text(body.occurred);
  if (body.projects !== undefined) changes.projects = textList(body.projects);
  if (body.tags !== undefined) changes.tags = textList(body.tags);
  if (body.amount !== undefined) changes.amount = amountFrom(body.amount) ?? null;
  return changes;
}

/** The files every new Roll starts with. Data only: no code, tooling or workflows. */
export function starterFiles(name: string): Record<string, string> {
  return {
    [CONFIG_PATH]: serializeConfig(name),
    "README.md": repoReadme(name),
    ".gitattributes": "*.md text eol=lf\n*.yaml text eol=lf\nattachments/** binary\n",
    "entries/.gitkeep": "",
    "projects/.gitkeep": "",
    "attachments/.gitkeep": "",
    ".gitroll/types/.gitkeep": "",
  };
}
