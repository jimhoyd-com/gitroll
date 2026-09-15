import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { planIngest } from "../core/adapter.ts";
import type { EventDraft } from "../core/adapter.ts";
import { isMapping, parseEntry, serializeEntry } from "../core/entry.ts";
import type { Attachment } from "../core/entry.ts";
import {
  ATTACHMENT_FILE,
  CONFIG_PATH,
  ENTRY_FILE,
  PROJECT_FILE,
  applyChanges,
  attachmentName,
  attachmentPath,
  buildEntry,
  commitMessage,
  findEntry,
  parseConfig,
  parseProject,
  projectPath,
  repoReadme,
  serializeProject,
  sortEntries,
} from "../core/layout.ts";
import type { Config, EntryChanges, EntryInput, HistoryItem, LoadedEntry, Problem, Project } from "../core/layout.ts";
import { findSensitive, removeJpegLocation } from "../core/privacy.ts";
import { TYPE_FILE, parseTypeDef, typeRegistry } from "../core/types.ts";
import type { EventType, FieldDef } from "../core/types.ts";
import { TYPE_ID } from "../core/entry.ts";
import { NotFoundError, UserError, extensionFor, isoLocal, mimeFor, slugify, titleCase, uniq } from "../core/util.ts";
import { validateRepo } from "../core/validate.ts";
import { fsSource } from "./fs-source.ts";
import { insideRoll, safeRead, safeRemove, safeWrite, walkFiles } from "./fs-safe.ts";
import { githubVisibility, parseGitHubRemote } from "./github.ts";
import { mergeEntry } from "./merge.ts";
import { loadUserConfig } from "./user-config.ts";

/** Finds a bundled asset directory whether running from source (src/node) or the build (dist). */
export function assetDir(marker: string, ...candidates: string[]): string {
  for (const c of candidates) {
    const dir = fileURLToPath(new URL(c, import.meta.url));
    if (fs.existsSync(path.join(dir, marker))) return dir;
  }
  return fileURLToPath(new URL(candidates[0], import.meta.url));
}

export const TEMPLATE_DIR = assetDir(CONFIG_PATH, "../template/", "../../template/");
export const DEFAULT_MAX_ATTACHMENT_MB = 25;
/** GitHub rejects files over 100 MB. */
export const HARD_MAX_ATTACHMENT_MB = 95;
const NETWORK_TIMEOUT_MS = 90_000;

export interface FileInput {
  name: string;
  type?: string;
  data: Buffer;
}

export interface SyncStatus {
  /** Remote name, e.g. origin. */
  remote: string | null;
  /** Credential-free location, e.g. github.com/you/my-roll */
  remoteUrl: string | null;
  branch: string;
  /** Local commits not yet uploaded. */
  ahead: number;
  /** Remote commits not yet downloaded (as of the last fetch). */
  behind: number;
  /** Uncommitted changes in the folder (for example, hand edits). */
  dirty: boolean;
}

export type SyncCode = "ok" | "no-remote" | "offline" | "auth" | "conflict" | "public" | "unverified" | "error";

/**
 * Where a sync has got to. Syncing talks to a network twice and can rewrite the
 * working tree in between, so on a large Roll it takes long enough that a single
 * spinner tells the person nothing. Each stage is reported as it begins.
 */
export type SyncStage = "checking" | "downloading" | "combining" | "uploading";

export interface SyncOptions {
  fetch?: typeof fetch;
  useGhCli?: boolean;
  /** Called as each stage begins, for interfaces that show progress. */
  onStage?: (stage: SyncStage) => void;
}

export interface SyncResult {
  ok: boolean;
  code: SyncCode;
  message: string;
  /** Events edited in two places and merged automatically. */
  merged?: string[];
  /** Files GitRoll couldn't merge (only non-event files). */
  conflicts?: string[];
}

export interface SaveResult {
  entry: LoadedEntry;
  /** Privacy notices, e.g. "Removed location from photo.jpg". */
  notices: string[];
}

export class GitError extends Error {}

export function isRepo(dir: string): boolean {
  try {
    return fs.lstatSync(path.join(dir, CONFIG_PATH)).isFile();
  } catch {
    return false;
  }
}

export function findRepoRoot(start: string = process.cwd()): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (isRepo(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

interface RunOptions {
  env?: Record<string, string>;
  timeout?: number;
}

function run(cwd: string, args: string[], opts: RunOptions = {}): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      // Never wait for a password prompt or an editor that nobody can see.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_EDITOR: "true", ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 256 * 1024 * 1024,
      timeout: opts.timeout,
    });
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message: string; code?: string; signal?: string };
    if (err.code === "ENOENT") throw new GitError("Git isn't installed. Install it from https://git-scm.com and try again.");
    if (err.signal === "SIGTERM" || err.code === "ETIMEDOUT") throw new GitError(`git ${args[0]}: timed out`);
    throw new GitError(`git ${args[0]}: ${(err.stderr || err.stdout || err.message).trim()}`);
  }
}

function tryRun(cwd: string, args: string[]): string | null {
  try {
    return run(cwd, args);
  } catch {
    return null;
  }
}

/** A push destination that's a folder on this computer rather than a network address. */
export function isLocalDestination(url: string): boolean {
  return /^(file:\/\/|\/|\.{1,2}[\\/]|[A-Za-z]:[\\/]|\\\\)/.test(url) || (!url.includes(":") && !url.includes("@"));
}

/** Strips credentials and protocol noise: git@github.com:you/roll.git → github.com/you/roll */
export function displayRemote(url: string): string {
  const s = url.trim();
  const scp = /^[^@/]+@([^:/]+):(.+?)(?:\.git)?\/?$/.exec(s);
  if (scp) return `${scp[1]}/${scp[2]}`;
  try {
    const u = new URL(s);
    if (u.protocol === "file:") return u.pathname;
    return `${u.host}${u.pathname.replace(/\.git\/?$/, "").replace(/\/$/, "")}`;
  } catch {
    return s.replace(/\/\/[^@/]*@/, "//");
  }
}

/** Copies only Roll data from a template: type definitions, projects, README and theme. Never code or workflows. */
const TEMPLATE_ALLOWED = [/^\.gitroll\/config\.yaml$/, /^\.gitroll\/theme\.css$/, TYPE_FILE, PROJECT_FILE, /^README\.md$/];

function resolveTemplate(source: string): { dir: string; cleanup?: string } {
  if (fs.existsSync(source) && fs.statSync(source).isDirectory()) return { dir: path.resolve(source) };
  const shorthand = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(source);
  if (!shorthand && !/^(https:\/\/|git@)/.test(source)) throw new UserError(`Template not found: ${source}`);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "gitroll-template-"));
  const url = shorthand ? `https://github.com/${source}.git` : source;
  run(temp, ["clone", "-q", "--depth", "1", "--no-recurse-submodules", url, "template"], { timeout: NETWORK_TIMEOUT_MS });
  return { dir: path.join(temp, "template"), cleanup: temp };
}

/**
 * Where attachment bytes live. Events reference attachments only by SHA-256,
 * so a different store (Git LFS, object storage) can be added later without
 * rewriting any event. V1 keeps them in the repository.
 */
export interface AttachmentStore {
  put(file: FileInput): { attachment: Attachment; paths: string[]; notices: string[] };
  locate(hash: string): string | null;
}

class RepoAttachmentStore implements AttachmentStore {
  #roll: GitRoll;

  constructor(roll: GitRoll) {
    this.#roll = roll;
  }

  put(file: FileInput): { attachment: Attachment; paths: string[]; notices: string[] } {
    const max = this.#roll.maxAttachmentBytes();
    const label = file.name || "That file";
    if (file.data.length > max) {
      throw new UserError(`${label} is ${(file.data.length / 1048576).toFixed(1)} MB. The limit is ${max / 1048576} MB per file.`);
    }
    const notices: string[] = [];
    let data: Uint8Array = file.data;
    const ext = extensionFor(file.name, file.type);
    if (this.#roll.config().removeLocation && (ext === ".jpg" || file.type === "image/jpeg")) {
      const cleaned = removeJpegLocation(data);
      if (cleaned.removed) notices.push(`Removed location data from ${label}.`);
      data = cleaned.bytes;
    }
    const hex = createHash("sha256").update(data).digest("hex");
    const rel = attachmentPath(hex, ext);
    if (!fs.existsSync(insideRoll(this.#roll.root, rel))) safeWrite(this.#roll.root, rel, data);
    return {
      attachment: { hash: `sha256:${hex}`, name: attachmentName(file.name, hex, ext), type: file.type || mimeFor(ext), size: data.length },
      paths: [rel],
      notices,
    };
  }

  locate(hash: string): string | null {
    const hex = hash.replace(/^sha256:/, "").toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(hex)) return null;
    const name = walkFiles(this.#roll.root, "attachments").files.find((f) => {
      const m = ATTACHMENT_FILE.exec(f);
      return m?.[1] === hex;
    });
    if (!name) return null;
    try {
      const abs = insideRoll(this.#roll.root, name);
      return fs.lstatSync(abs).isFile() ? abs : null;
    } catch {
      return null;
    }
  }
}

/**
 * A Roll on this computer, driven by the git CLI.
 * Nothing here keeps state that can't be rebuilt from the folder.
 */
export class GitRoll {
  readonly root: string;
  readonly attachments: AttachmentStore;
  #cache = new Map<string, { key: string; entry?: LoadedEntry; error?: string }>();
  #identityEnv: Record<string, string> | null = null;

  constructor(root: string) {
    if (!isRepo(root)) throw new UserError(`This folder isn't a Roll: ${path.resolve(root)}`);
    this.root = fs.realpathSync(path.resolve(root));
    this.attachments = new RepoAttachmentStore(this);
  }

  /** Creates a Roll in a new folder or an existing (for example, freshly cloned) Git repository. */
  static init(dir: string, opts: { name?: string; template?: string } = {}): GitRoll {
    const target = path.resolve(dir);
    if (isRepo(target)) throw new UserError(`There's already a Roll in ${target}`);
    if (!fs.existsSync(path.join(TEMPLATE_DIR, CONFIG_PATH))) throw new Error(`GitRoll's starter files are missing (${TEMPLATE_DIR}). Reinstall GitRoll.`);
    fs.mkdirSync(target, { recursive: true });
    const root = fs.realpathSync(target);
    const hadReadme = fs.existsSync(path.join(root, "README.md"));
    const written = new Set<string>();

    const copy = (src: string, filter: ((rel: string) => boolean) | null, overwrite: boolean) => {
      for (const rel of walkFiles(src).files) {
        if (filter && !filter(rel)) continue;
        const dest = insideRoll(root, rel);
        if (!overwrite && fs.existsSync(dest)) continue;
        safeWrite(root, rel, fs.readFileSync(path.join(src, rel)));
        written.add(rel.split("/")[0]);
      }
    };
    copy(TEMPLATE_DIR, null, false);
    if (opts.template) {
      const t = resolveTemplate(opts.template);
      try {
        copy(t.dir, (rel) => TEMPLATE_ALLOWED.some((re) => re.test(rel)), true);
      } finally {
        if (t.cleanup) fs.rmSync(t.cleanup, { recursive: true, force: true });
      }
    }

    const name = opts.name?.trim() || path.basename(root);
    const config = (parse(fs.readFileSync(path.join(root, CONFIG_PATH), "utf8")) ?? {}) as Record<string, unknown>;
    safeWrite(root, CONFIG_PATH, stringify({ ...config, version: 1, name }));
    if (!hadReadme && !opts.template) safeWrite(root, "README.md", repoReadme(name));
    if (!fs.existsSync(path.join(root, ".git"))) run(root, ["init", "-q", "-b", "main"]);
    const roll = new GitRoll(root);
    roll.#commit([...written, ".gitroll", "README.md"].filter((p) => fs.existsSync(path.join(root, p))), `init: ${name}`);
    return roll;
  }

  git(args: string[], opts: { network?: boolean } = {}): string {
    return run(this.root, args, {
      env: { ...this.#identity(), ...(opts.network ? this.#networkEnv() : {}) },
      timeout: opts.network ? NETWORK_TIMEOUT_MS : undefined,
    });
  }

  /** Falls back to a GitRoll identity so commits work on machines with no git config. */
  #identity(): Record<string, string> {
    if (!this.#identityEnv) {
      const env: Record<string, string> = {};
      if (!tryRun(this.root, ["config", "user.name"])?.trim()) env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = "GitRoll";
      if (!tryRun(this.root, ["config", "user.email"])?.trim()) env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = "gitroll@localhost";
      this.#identityEnv = env;
    }
    return this.#identityEnv;
  }

  /** SSH must not prompt either; ssh-agent and credential helpers still work. */
  #networkEnv(): Record<string, string> {
    if (process.env.GIT_SSH_COMMAND || tryRun(this.root, ["config", "core.sshCommand"])?.trim()) return {};
    return { GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=20" };
  }

  /** Commits exactly these paths, leaving anything else the user has staged alone. */
  #commit(paths: string[], message: string): string | null {
    const unique = uniq(paths);
    if (!unique.length) return null;
    this.git(["add", "-A", "--", ...unique]);
    if (tryRun(this.root, ["diff", "--cached", "--quiet", "--", ...unique]) !== null) return null;
    this.git(["commit", "-q", "-m", message, "--", ...unique]);
    return this.git(["rev-parse", "HEAD"]).trim();
  }

  config(): Config {
    return parseConfig(safeRead(this.root, CONFIG_PATH).toString("utf8"), path.basename(this.root));
  }

  /** Renames the Roll (the name shown in GitRoll; the folder stays put). */
  rename(name: string): void {
    const clean = name.trim();
    if (!clean) throw new UserError("Please give the Roll a name.");
    const data = (parse(safeRead(this.root, CONFIG_PATH).toString("utf8")) ?? {}) as Record<string, unknown>;
    safeWrite(this.root, CONFIG_PATH, stringify({ ...data, name: clean }));
    this.#commit([CONFIG_PATH], `rename: ${clean}`);
  }

  maxAttachmentBytes(): number {
    const mb = Math.min(this.config().maxAttachmentMb ?? DEFAULT_MAX_ATTACHMENT_MB, HARD_MAX_ATTACHMENT_MB);
    return Math.round(mb * 1024 * 1024);
  }

  /** Your name on this computer. Never taken from the shared Roll, so collaborators can't sign as each other. */
  get author(): string {
    return loadUserConfig().author || tryRun(this.root, ["config", "user.name"])?.trim() || os.userInfo().username;
  }

  // ── Projects and types ──────────────────────────────────────────────────

  projects(): Project[] {
    return walkFiles(this.root, "projects")
      .files.filter((f) => PROJECT_FILE.test(f))
      .map((f) => parseProject(PROJECT_FILE.exec(f)![1], safeRead(this.root, f).toString("utf8")))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  createProject(name: string, opts: { description?: string } = {}): Project {
    const slug = slugify(name);
    if (!slug) throw new UserError("Please give the project a name.");
    if (this.projects().some((p) => p.slug === slug)) throw new UserError(`There's already a project called ${name}.`);
    const rel = projectPath(slug);
    safeWrite(this.root, rel, serializeProject(name.trim(), opts.description));
    this.#commit([rel], `project: ${name.trim()}`);
    return this.projects().find((p) => p.slug === slug)!;
  }

  deleteProject(slugOrName: string): void {
    const slug = slugify(slugOrName);
    const rel = projectPath(slug);
    if (!fs.existsSync(insideRoll(this.root, rel))) throw new NotFoundError(`There's no project called ${slugOrName}.`);
    const used = this.entries().filter((e) => e.projects.includes(slug)).length;
    if (used) throw new UserError(`${used} ${used === 1 ? "event uses" : "events use"} this project. Move or delete them first.`);
    safeRemove(this.root, rel);
    this.#commit([rel], `project removed: ${slug}`);
  }

  #ensureProjects(slugs: string[]): string[] {
    const known = new Set(this.projects().map((p) => p.slug));
    return slugs
      .filter((s) => !known.has(s))
      .map((s) => {
        safeWrite(this.root, projectPath(s), serializeProject(titleCase(s)));
        return projectPath(s);
      });
  }

  /** Custom event types from .gitroll/types/. Invalid definitions are reported by check(). */
  types(): EventType[] {
    return walkFiles(this.root, ".gitroll/types").files.flatMap((f) => {
      const m = TYPE_FILE.exec(f);
      if (!m) return [];
      try {
        return [parseTypeDef(m[1], safeRead(this.root, f).toString("utf8"))];
      } catch {
        return [];
      }
    });
  }

  createType(label: string, fields: FieldDef[] = [], opts: { amount?: EventType["amount"] } = {}): EventType {
    const id = slugify(label);
    if (!TYPE_ID.test(id)) throw new UserError("Please give the type a name.");
    const rel = `.gitroll/types/${id}.yaml`;
    if (fs.existsSync(insideRoll(this.root, rel))) throw new UserError(`There's already a type called ${label}.`);
    const def: Record<string, unknown> = { label: label.trim(), amount: opts.amount ?? "optional" };
    if (fields.length) def.fields = fields.map((f) => ({ key: f.key, label: f.label, kind: f.kind, ...(f.options ? { options: f.options } : {}) }));
    const text = stringify(def);
    parseTypeDef(id, text); // validate before writing
    safeWrite(this.root, rel, text);
    this.#commit([rel], `type: ${label.trim()}`);
    return typeRegistry(this.types()).get(id)!;
  }

  deleteType(idOrLabel: string): void {
    const id = slugify(idOrLabel);
    const rel = `.gitroll/types/${id}.yaml`;
    if (!fs.existsSync(insideRoll(this.root, rel))) throw new NotFoundError(`There's no custom type called ${idOrLabel}.`);
    safeRemove(this.root, rel);
    this.#commit([rel], `type removed: ${id}`);
  }

  /** Writes this Roll's reusable setup (types, projects, theme) as a template folder. No events or files. */
  exportTemplate(dir: string): string[] {
    const out = path.resolve(dir);
    if (fs.existsSync(out) && fs.readdirSync(out).length) throw new UserError(`${out} isn't empty.`);
    const files = walkFiles(this.root).files.filter((f) => TEMPLATE_ALLOWED.some((re) => re.test(f)));
    for (const f of files) {
      const dest = path.join(out, f);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, safeRead(this.root, f));
    }
    return files;
  }

  // ── Events ──────────────────────────────────────────────────────────────

  /** Reads every event from disk (cached by mtime and size), so edits made outside GitRoll show up immediately. */
  load(): { entries: LoadedEntry[]; problems: Problem[] } {
    const entries: LoadedEntry[] = [];
    const problems: Problem[] = [];
    const seen = new Set<string>();
    const { files, links } = walkFiles(this.root, "entries");
    for (const link of links) problems.push({ path: link, error: "symbolic links aren't allowed in a Roll" });
    for (const rel of files.filter((f) => ENTRY_FILE.test(f))) {
      seen.add(rel);
      const abs = insideRoll(this.root, rel);
      const st = fs.lstatSync(abs);
      const key = `${st.mtimeMs}:${st.size}`;
      let hit = this.#cache.get(rel);
      if (!hit || hit.key !== key) {
        try {
          hit = { key, entry: { ...parseEntry(fs.readFileSync(abs, "utf8")), path: rel } };
        } catch (e) {
          hit = { key, error: (e as Error).message };
        }
        this.#cache.set(rel, hit);
      }
      if (hit.entry) entries.push(hit.entry);
      else problems.push({ path: rel, error: hit.error ?? "unreadable" });
    }
    for (const k of this.#cache.keys()) if (!seen.has(k)) this.#cache.delete(k);
    return { entries: sortEntries(entries), problems };
  }

  entries(): LoadedEntry[] {
    return this.load().entries;
  }

  entry(idOrPart: string): LoadedEntry {
    return findEntry(this.entries(), idOrPart);
  }

  addEntry(input: EntryInput, files: FileInput[] = []): LoadedEntry {
    return this.save(input, files).entry;
  }

  /** Logs an event and reports privacy notices (location removed, sensitive text spotted). */
  save(input: EntryInput, files: FileInput[] = []): SaveResult {
    const stored = files.map((f) => this.attachments.put(f));
    const entry = buildEntry(input, this.author, stored.map((s) => s.attachment));
    safeWrite(this.root, entry.path, serializeEntry(entry));
    this.#cache.delete(entry.path);
    const projectFiles = this.#ensureProjects(entry.projects);
    this.#commit([entry.path, ...stored.flatMap((s) => s.paths), ...projectFiles], commitMessage("log", entry));
    return { entry, notices: [...stored.flatMap((s) => s.notices), ...sensitiveNotices(entry)] };
  }

  updateEntry(idOrPart: string, changes: EntryChanges, files: FileInput[] = []): LoadedEntry {
    return this.saveChanges(idOrPart, changes, files).entry;
  }

  saveChanges(idOrPart: string, changes: EntryChanges, files: FileInput[] = []): SaveResult {
    const cur = this.entry(idOrPart);
    const stored = files.map((f) => this.attachments.put(f));
    const next = applyChanges(cur, changes, stored.map((s) => s.attachment));
    safeWrite(this.root, cur.path, serializeEntry(next));
    this.#cache.delete(cur.path);
    const projectFiles = this.#ensureProjects(next.projects);
    this.#commit([cur.path, ...stored.flatMap((s) => s.paths), ...projectFiles], commitMessage("edit", next));
    return { entry: next, notices: [...stored.flatMap((s) => s.notices), ...sensitiveNotices(next)] };
  }

  /** Removes the event from the timeline. Git history keeps every earlier version. */
  deleteEntry(idOrPart: string): void {
    const cur = this.entry(idOrPart);
    safeRemove(this.root, cur.path);
    this.#cache.delete(cur.path);
    this.#commit([cur.path], commitMessage("delete", cur));
  }

  /** Puts a deleted event back, exactly as it was. Used by undo. */
  restoreEntry(entry: LoadedEntry): LoadedEntry {
    if (this.entries().some((e) => e.id === entry.id)) throw new UserError("That entry is already in the Roll.");
    safeWrite(this.root, entry.path, serializeEntry(entry));
    this.#cache.delete(entry.path);
    const projectFiles = this.#ensureProjects(entry.projects);
    this.#commit([entry.path, ...projectFiles], commitMessage("restore", entry));
    return entry;
  }

  /** Logs adapter drafts, skipping any whose source is already in the Roll. */
  ingest(drafts: EventDraft[]): { created: LoadedEntry[]; skipped: EventDraft[] } {
    const { create, skip } = planIngest(this.entries(), drafts);
    const created = create.map((d) =>
      this.addEntry(d, (d.files ?? []).map((f) => ({ name: f.name, type: f.type, data: Buffer.from(f.data) }))),
    );
    return { created, skipped: skip };
  }

  history(idOrPart: string): HistoryItem[] {
    const cur = this.entry(idOrPart);
    const out = tryRun(this.root, ["log", "--follow", "-p", "--format=%x1e%H%x1f%an%x1f%aI%x1f%s", "--", cur.path]) ?? "";
    return out
      .split("\x1e")
      .filter((c) => c.trim())
      .map((chunk) => {
        const nl = chunk.indexOf("\n");
        const [commit, author, date, subject] = (nl < 0 ? chunk : chunk.slice(0, nl)).split("\x1f");
        return { commit, author, date, subject, patch: nl < 0 ? "" : chunk.slice(nl + 1).trim() };
      });
  }

  /** Validates the Roll against the GitRoll Format, on this computer. */
  check(): Problem[] {
    return validateRepo(fsSource(this.root));
  }

  /** Events that look like they contain passwords, keys or card numbers. */
  sensitive(): Problem[] {
    return this.entries().flatMap((e) =>
      findSensitive(`${e.body}\n${JSON.stringify(e.data)}`).map((kind) => ({ path: e.path, error: `may contain a ${kind}` })),
    );
  }

  attachmentFile(hash: string): string | null {
    return this.attachments.locate(hash);
  }

  /** A portable copy of the Roll's events as JSON or a readable Markdown timeline. */
  export(format: "json" | "markdown"): string {
    const entries = this.entries();
    const names = new Map(this.projects().map((p) => [p.slug, p.name]));
    if (format === "json") {
      return JSON.stringify({ roll: this.config().name, exported: isoLocal(), projects: this.projects(), types: this.types(), events: entries }, null, 2);
    }
    const lines = [`# ${this.config().name}`, "", `Exported ${isoLocal().slice(0, 10)} · ${entries.length} events`, ""];
    for (const e of entries) {
      lines.push(`## ${e.occurred.slice(0, 16).replace("T", " ")}${e.projects.length ? ` · ${e.projects.map((p) => names.get(p) ?? p).join(", ")}` : ""}`);
      lines.push("", e.body || "(no text)", "");
      const meta = [e.type !== "log" ? `Type: ${e.type}` : "", e.amount ? `Amount: ${e.amount.value} ${e.amount.currency}` : "", e.tags.length ? `Tags: ${e.tags.join(", ")}` : ""].filter(Boolean);
      if (meta.length) lines.push(meta.join(" · "), "");
      for (const a of e.attachments) lines.push(`- Attachment: ${a.name}`);
      if (e.attachments.length) lines.push("");
    }
    return lines.join("\n");
  }

  // ── Sync ────────────────────────────────────────────────────────────────

  status(): SyncStatus {
    const remote = tryRun(this.root, ["remote"])?.split("\n").map((s) => s.trim()).find(Boolean) ?? null;
    const branch = tryRun(this.root, ["symbolic-ref", "--short", "HEAD"])?.trim() || "main";
    const dirty = (tryRun(this.root, ["status", "--porcelain"]) ?? "").trim().length > 0;
    let ahead = 0;
    let behind = 0;
    if (remote) {
      const counts = tryRun(this.root, ["rev-list", "--left-right", "--count", `refs/remotes/${remote}/${branch}...HEAD`]);
      if (counts) [behind, ahead] = counts.trim().split(/\s+/).map(Number);
      else ahead = Number(tryRun(this.root, ["rev-list", "--count", "HEAD"]) ?? 0); // never uploaded
    }
    const url = remote ? tryRun(this.root, ["remote", "get-url", remote])?.trim() : null;
    return { remote, remoteUrl: url ? displayRemote(url) : null, branch, ahead, behind, dirty };
  }

  /** Every address `git push` would really send to (after pushurl and insteadOf rewrites). */
  pushDestinations(): string[] {
    const { remote } = this.status();
    if (!remote) return [];
    return (tryRun(this.root, ["remote", "get-url", "--push", "--all", remote]) ?? "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /**
   * Download, combine and upload, after confirming every push destination is private.
   * Fails closed: a public destination, an unknown answer, or a non-GitHub host that the
   * user hasn't explicitly trusted all stop the sync before anything is uploaded.
   */
  async sync(options: SyncOptions = {}): Promise<SyncResult> {
    const stage = options.onStage ?? (() => {});
    const { remote } = this.status();
    if (!remote) {
      return { ok: false, code: "no-remote", message: "This Roll isn't backed up yet. Your events are saved on this computer. Run: gitroll backup" };
    }
    stage("checking");
    const destinations = this.pushDestinations();
    if (!destinations.length) return { ok: false, code: "error", message: `Couldn't read where "${remote}" uploads to. Nothing was uploaded.` };
    const trusted = new Set((loadUserConfig().trustedRemotes ?? []).map((t) => t.toLowerCase()));
    for (const url of destinations) {
      if (isLocalDestination(url)) continue; // a folder on this computer
      const shown = displayRemote(url);
      const gh = parseGitHubRemote(url);
      if (!gh) {
        if (trusted.has(shown.toLowerCase())) continue;
        return {
          ok: false,
          code: "unverified",
          message: `GitRoll can only check privacy for GitHub repositories, so nothing was uploaded to ${shown}. If you're sure it's private, run: gitroll trust ${shown}`,
        };
      }
      const visibility = await githubVisibility(gh.owner, gh.repo, options.fetch ?? fetch, options.useGhCli ?? true);
      if (visibility === "public") {
        return {
          ok: false,
          code: "public",
          message: `${shown} is a public repository, so anyone could read this Roll. Nothing was uploaded. Make it private on GitHub (Settings → Danger Zone → Change visibility), then sync again.`,
        };
      }
      if (visibility === "unknown") {
        return {
          ok: false,
          code: "unverified",
          message: `Couldn't confirm that ${shown} is private (you may be offline, or GitHub is limiting requests). Nothing was uploaded. Try again in a few minutes.`,
        };
      }
    }
    return this.#transfer(stage);
  }

  /**
   * Download, combine and upload, using the user's own Git credentials. Never
   * prompts and never force-pushes. Events edited in two places are merged
   * automatically without losing either version. On any other failure local
   * commits stay exactly as they were.
   */
  #transfer(stage: (s: SyncStage) => void = () => {}): SyncResult {
    const { remote, branch } = this.status();
    if (!remote) return { ok: false, code: "no-remote", message: "This Roll isn't backed up yet." };
    const merged = new Set<string>();
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        stage("downloading");
        this.git(["fetch", "-q", remote], { network: true });
      } catch (e) {
        return this.#syncFailure(e as Error, remote);
      }
      const upstream = `refs/remotes/${remote}/${branch}`;
      if (tryRun(this.root, ["rev-parse", "--verify", "-q", upstream]) !== null) {
        stage("combining");
        const failed = this.#combine(upstream, merged);
        if (failed) return failed;
      }
      try {
        stage("uploading");
        this.git(["push", "-q", "-u", remote, `HEAD:refs/heads/${branch}`], { network: true });
      } catch (e) {
        if (/\[rejected\]|non-fast-forward|fetch first/i.test((e as Error).message) && attempt < 2) continue; // someone synced at the same moment
        return this.#syncFailure(e as Error, remote);
      }
      const n = merged.size;
      return {
        ok: true,
        code: "ok",
        merged: [...merged],
        message: n
          ? `Synced. ${n} ${n === 1 ? "event was" : "events were"} changed in two places and combined. Search #conflict to review.`
          : "Synced.",
      };
    }
    return { ok: false, code: "conflict", message: "Others kept syncing at the same moment. Try again." };
  }

  #rebaseInProgress(): boolean {
    return ["rebase-merge", "rebase-apply"].some((name) => {
      const gitPath = tryRun(this.root, ["rev-parse", "--git-path", name])?.trim();
      return !!gitPath && fs.existsSync(path.resolve(this.root, gitPath));
    });
  }

  /** Replays local commits on top of the remote, merging conflicting events. Returns a result only on failure. */
  #combine(upstream: string, merged: Set<string>): SyncResult | null {
    try {
      this.git(["rebase", "-q", "--autostash", upstream]);
      return null;
    } catch (e) {
      if (!this.#rebaseInProgress()) return { ok: false, code: "error", message: `Couldn't combine changes. Nothing was lost. ${(e as Error).message}` };
    }
    for (let step = 0; step < 10_000 && this.#rebaseInProgress(); step++) {
      const conflicts = (tryRun(this.root, ["diff", "--name-only", "--diff-filter=U"]) ?? "").split("\n").filter(Boolean);
      const unresolved = conflicts.filter((p) => !this.#resolve(p));
      if (unresolved.length) {
        tryRun(this.root, ["rebase", "--abort"]);
        return {
          ok: false,
          code: "conflict",
          conflicts: unresolved,
          message: `Some files were changed here and elsewhere and couldn't be combined automatically (${unresolved.join(", ")}). Nothing was lost; your changes are still saved on this computer.`,
        };
      }
      for (const p of conflicts) if (ENTRY_FILE.test(p)) merged.add(p);
      try {
        this.git(["rebase", "--continue"]);
      } catch {
        if (!conflicts.length) tryRun(this.root, ["rebase", "--skip"]); // nothing left to apply
      }
    }
    if (this.#rebaseInProgress()) {
      tryRun(this.root, ["rebase", "--abort"]);
      return { ok: false, code: "error", message: "Couldn't combine changes. Nothing was lost." };
    }
    return null;
  }

  /** Resolves one conflicted file during a rebase. In a rebase, stage 2 is the remote and stage 3 is this device. */
  #resolve(rel: string): boolean {
    const stage = (n: number) => tryRun(this.root, ["show", `:${n}:${rel}`]);
    try {
      if (ENTRY_FILE.test(rel)) {
        const base = stage(1);
        const theirs = stage(2);
        const mine = stage(3);
        if (mine === null && theirs === null) {
          this.git(["rm", "-q", "--cached", "--ignore-unmatch", "--", rel]);
          safeRemove(this.root, rel);
        } else if (mine === null || theirs === null) {
          safeWrite(this.root, rel, (mine ?? theirs)!); // an edit wins over a delete: nothing is lost
          this.git(["add", "--", rel]);
        } else {
          safeWrite(this.root, rel, mergeEntry(base, mine, theirs).text);
          this.git(["add", "--", rel]);
        }
        this.#cache.delete(rel);
        return true;
      }
      if (PROJECT_FILE.test(rel) || ATTACHMENT_FILE.test(rel) || TYPE_FILE.test(rel)) {
        insideRoll(this.root, rel);
        if (tryRun(this.root, ["checkout", "--theirs", "--", rel]) === null) this.git(["checkout", "--ours", "--", rel]);
        this.git(["add", "--", rel]);
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  #syncFailure(err: Error, remote: string): SyncResult {
    const text = err.message;
    if (/Authentication failed|Permission denied|could not read Username|terminal prompts disabled|Repository not found|returned error: 40[134]|does not appear to be a git repository|Could not read from remote/i.test(text)) {
      return {
        ok: false,
        code: "auth",
        message: `Couldn't reach your backup (${remote}). Check that the repository exists and that you're signed in to GitHub on this computer. Your events are saved here.`,
      };
    }
    if (/timed out|Could not resolve host|unable to access|Connection (refused|reset|closed)|Network is unreachable|Operation timed out/i.test(text)) {
      return { ok: false, code: "offline", message: "You seem to be offline. Your events are saved on this computer; sync again later." };
    }
    return { ok: false, code: "error", message: text };
  }
}

function sensitiveNotices(entry: LoadedEntry): string[] {
  const kinds = findSensitive(`${entry.body}\n${JSON.stringify(entry.data)}`);
  return kinds.length ? [`This event may contain a ${kinds.join(" and ")}. Events are kept in history even after editing, so avoid saving secrets.`] : [];
}

export { isMapping };
