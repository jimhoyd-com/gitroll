import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { planIngest } from "../core/adapter.ts";
import type { EventDraft } from "../core/adapter.ts";
import { parseEntry } from "../core/entry.ts";
import {
  EVENT_FILE,
  GITROLL_DIR,
  TEMPLATE_VERSION,
  EVENTS_DIR,
  FILES_DIR,
  MARKER_PATH,
  applyChanges,
  buildEntry,
  commitMessage,
  filePath,
  findEntry,
  moveEntry,
  parseConfig,
  requireWritable,
  serializeConfig,
  sortEntries,
  templateStatus,
} from "../core/layout.ts";
import type { Config, EntryChanges, EntryInput, EntryLink, HistoryItem, LoadedEntry, Problem, TemplateStatus } from "../core/layout.ts";
import { repoName, repoUrl } from "../core/code.ts";
import type { SourceRef } from "../core/code.ts";
import { findSensitive, removeJpegLocation } from "../core/privacy.ts";
import { NotFoundError, UserError, extensionFor, isoDate, summarize, uniq } from "../core/util.ts";
import { validateRepo } from "../core/validate.ts";
import { fsSource } from "./fs-source.ts";
import { insideRoll, safeRead, safeRemove, safeWrite, walkFiles } from "./fs-safe.ts";
import { githubVisibility, parseGitHubRemote } from "./github.ts";
import { CONFLICT_TAG, mergeEntry, splitConflict } from "./merge.ts";
import { loadUserConfig } from "./user-config.ts";

/** Finds a bundled asset directory whether running from source (src/node) or the build (dist). */
export function assetDir(marker: string, ...candidates: string[]): string {
  for (const c of candidates) {
    const dir = fileURLToPath(new URL(c, import.meta.url));
    if (fs.existsSync(path.join(dir, marker))) return dir;
  }
  return fileURLToPath(new URL(candidates[0], import.meta.url));
}

export const TEMPLATE_DIR = assetDir(MARKER_PATH, "../template/", "../../template/");
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
  /**
   * The branch the log's own repository is on. This is the Roll's branch, which
   * is not the same thing as the branch an event says its work happened on.
   * null when HEAD is detached.
   */
  branch: string | null;
  /** Set when HEAD isn't on a branch, so writes still work but nothing tracks them. */
  detached: boolean;
  /** Short HEAD commit, or null in a repository with no commits yet. */
  head: string | null;
  /** False before the first commit: there is no branch to be on yet. */
  hasCommits: boolean;
  /** owner/repo of the log's own repository, when it is hosted somewhere that has one. */
  repo: string | null;
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

/** A conflicted event, as two texts a person can choose between. */
export interface Conflict {
  entry: LoadedEntry;
  /** The version saved on this computer. */
  mine: string;
  /** The version that arrived from someone else. */
  theirs: string;
  /** The day the sync note was written. */
  noted: string;
}

export interface SaveResult {
  entry: LoadedEntry;
  /** Privacy notices, e.g. "Removed location from photo.jpg". */
  notices: string[];
}

export class GitError extends Error {}

export function isRepo(dir: string): boolean {
  try {
    return fs.lstatSync(path.join(dir, MARKER_PATH)).isFile();
  } catch {
    return false;
  }
}

/** The nearest folder at or above `start` that holds a log. */
export function findRepoRoot(start: string = process.cwd()): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (isRepo(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The Git repository `start` is in, however deep in it we are. */
export function findGitRoot(start: string = process.cwd()): string | null {
  const out = tryRun(path.resolve(start), ["rev-parse", "--show-toplevel"]);
  const root = out?.trim();
  return root && fs.existsSync(root) ? fs.realpathSync(root) : null;
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

/** Copies only a template's readable setup: its marker, README and theme. Never code, workflows or events. */
const TEMPLATE_ALLOWED = [/^\.gitroll\/config\.yaml$/, /^\.gitroll\/theme\.css$/, /^\.gitroll\/README\.md$/, /^\.gitroll\/\.gitattributes$/, /^README\.md$/];

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
 * Where files kept with an event live. They are ordinary files with readable
 * names under files/, linked from the event's Markdown. No hashes, no manifest.
 */
export interface FileStore {
  put(file: FileInput): { link: EntryLink; notices: string[] };
  locate(relPath: string): string | null;
}

class RepoFileStore implements FileStore {
  #roll: GitRoll;

  constructor(roll: GitRoll) {
    this.#roll = roll;
  }

  /** Stores a file under a readable name, never overwriting one that is already there. */
  put(file: FileInput): { link: EntryLink; notices: string[] } {
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
    const rel = filePath(file.name || `file${ext}`, (p) => fs.existsSync(path.join(this.#roll.root, p)));
    safeWrite(this.#roll.root, rel, data);
    const image = (file.type ?? "").startsWith("image/") || /\.(jpg|jpeg|png|gif|webp|heic)$/i.test(rel);
    return { link: { path: rel, name: file.name?.trim() || rel.split("/").pop()!, image }, notices };
  }

  /** The file on disk for a repository-relative path, or null when it isn't a file in this Roll. */
  locate(relPath: string): string | null {
    try {
      const abs = insideRoll(this.#roll.root, relPath);
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
  readonly files: FileStore;
  #cache = new Map<string, { key: string; entry?: LoadedEntry; error?: string }>();
  #identityEnv: Record<string, string> | null = null;

  constructor(root: string) {
    if (!isRepo(root)) throw new UserError(`There's no log in ${path.resolve(root)} (a repository with a log has a .gitroll/config.yaml)`);
    this.root = fs.realpathSync(path.resolve(root));
    this.files = new RepoFileStore(this);
  }

  /**
   * Adds a log to a folder: a new one, a freshly cloned repository, or a project
   * that is already there. Everything written lives in .gitroll/, and only the
   * files GitRoll created are committed, so unrelated work in progress — staged
   * or not — is left exactly as it was.
   */
  static init(dir: string, opts: { name?: string; template?: string } = {}): GitRoll {
    const target = path.resolve(dir);
    if (isRepo(target)) throw new UserError(`There's already a log in ${target}`);
    if (!fs.existsSync(path.join(TEMPLATE_DIR, MARKER_PATH))) throw new Error(`GitRoll's starter files are missing (${TEMPLATE_DIR}). Reinstall GitRoll.`);
    // Something else owns a .gitroll/ here. Refuse rather than write into it.
    if (fs.existsSync(path.join(target, GITROLL_DIR))) {
      throw new UserError(
        `${target} already has a .gitroll folder that isn't a GitRoll log (there's no .gitroll/config.yaml). ` +
          "Nothing was changed. Move or remove it first, or add the log to another repository.",
      );
    }
    fs.mkdirSync(target, { recursive: true });
    const root = fs.realpathSync(target);
    const existingProject = fs.readdirSync(root).some((f) => f !== ".git");
    const written = new Set<string>();

    const copy = (src: string, filter: ((rel: string) => boolean) | null, overwrite: boolean) => {
      for (const rel of walkFiles(src).files) {
        if (filter && !filter(rel)) continue;
        const dest = insideRoll(root, rel);
        if (!overwrite && fs.existsSync(dest)) continue;
        safeWrite(root, rel, fs.readFileSync(path.join(src, rel)));
        written.add(rel);
      }
    };
    // A repository that already holds a project keeps its own root README.
    copy(TEMPLATE_DIR, (rel) => !existingProject || rel.startsWith(`${GITROLL_DIR}/`), false);
    if (opts.template) {
      const t = resolveTemplate(opts.template);
      try {
        copy(t.dir, (rel) => TEMPLATE_ALLOWED.some((re) => re.test(rel)), true);
      } finally {
        if (t.cleanup) fs.rmSync(t.cleanup, { recursive: true, force: true });
      }
    }

    const name = opts.name?.trim() || path.basename(root);
    safeWrite(root, MARKER_PATH, serializeConfig(name));
    written.add(MARKER_PATH);
    if (!fs.existsSync(path.join(root, ".git"))) run(root, ["init", "-q", "-b", "main"]);
    const roll = new GitRoll(root);
    roll.#warnIfIgnored();
    roll.#commit([...written].filter((p) => fs.existsSync(path.join(root, p))), `gitroll: add a log to this repository`);
    return roll;
  }

  /** .gitroll/ is tracked content, so an ignore rule would quietly throw events away. */
  #warnIfIgnored(): string | null {
    // --no-index: a rule still matters once the file is tracked, and a tracked path is excluded without it.
    const ignored = tryRun(this.root, ["check-ignore", "--no-index", "-q", MARKER_PATH]) !== null;
    return ignored
      ? `.gitroll/ is covered by a .gitignore rule in this repository. It holds your events and must be committed: remove that rule, or add "!.gitroll/" below it.`
      : null;
  }

  /** A warning worth showing when a log is opened, or null. */
  warning(): string | null {
    return this.#warnIfIgnored();
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
    return parseConfig(safeRead(this.root, MARKER_PATH).toString("utf8"), path.basename(this.root));
  }

  /** Which template revision this Roll follows, and whether this GitRoll may write to it. */
  template(): TemplateStatus {
    return templateStatus(this.config());
  }

  /**
   * Records a template version in gitroll.yaml. Only ever run because someone asked:
   * GitRoll never fills this in by itself, and upgrading a Roll's template is a
   * separate, reviewable step that sets the marker once it has succeeded.
   */
  setTemplateVersion(version: number): void {
    if (!Number.isInteger(version) || version < 1) throw new UserError("A template version is a whole number, for example 1.");
    if (version > TEMPLATE_VERSION) throw new UserError(`This GitRoll understands template versions up to ${TEMPLATE_VERSION}.`);
    const text = safeRead(this.root, MARKER_PATH).toString("utf8");
    const next = /^template_version:.*$/m.test(text)
      ? text.replace(/^template_version:.*$/m, `template_version: ${version}`)
      : `template_version: ${version}\n${text}`;
    safeWrite(this.root, MARKER_PATH, next);
    this.#commit([MARKER_PATH], `template: version ${version}`);
  }

  /** Renames the log (the name shown in GitRoll; the folder stays put). */
  rename(name: string): void {
    const clean = name.trim();
    if (!clean) throw new UserError("Please give the Roll a name.");
    requireWritable(this.config());
    const text = safeRead(this.root, MARKER_PATH).toString("utf8");
    const line = `name: ${JSON.stringify(clean)}`;
    safeWrite(this.root, MARKER_PATH, /^name:.*$/m.test(text) ? text.replace(/^name:.*$/m, line) : `${text.replace(/\n*$/, "\n")}${line}\n`);
    this.#commit([MARKER_PATH], `rename: ${clean}`);
  }

  maxAttachmentBytes(): number {
    const mb = Math.min(this.config().maxAttachmentMb ?? DEFAULT_MAX_ATTACHMENT_MB, HARD_MAX_ATTACHMENT_MB);
    return Math.round(mb * 1024 * 1024);
  }

  /** Your name on this computer, used only for Git commits. Events carry no author field. */
  get author(): string {
    return loadUserConfig().author || tryRun(this.root, ["config", "user.name"])?.trim() || os.userInfo().username;
  }

  /** Every project named by any event. Projects are just words: nothing defines them. */
  projects(): string[] {
    return uniq(this.entries().flatMap((e) => e.projects)).sort();
  }

  // ── Events ──────────────────────────────────────────────────────────────

  /** Reads every event from disk (cached by mtime and size), so edits made outside GitRoll show up immediately. */
  load(): { entries: LoadedEntry[]; problems: Problem[] } {
    const entries: LoadedEntry[] = [];
    const problems: Problem[] = [];
    const seen = new Set<string>();
    const { files, links } = walkFiles(this.root, EVENTS_DIR);
    for (const link of links) problems.push({ path: link, error: "symbolic links aren't allowed in a Roll" });
    for (const rel of files.filter((f) => EVENT_FILE.test(f))) {
      seen.add(rel);
      const abs = insideRoll(this.root, rel);
      const st = fs.lstatSync(abs);
      const key = `${st.mtimeMs}:${st.size}`;
      let hit = this.#cache.get(rel);
      if (!hit || hit.key !== key) {
        try {
          hit = { key, entry: parseEntry(rel, fs.readFileSync(abs, "utf8")) };
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

  /** Finds an event by path, file name, or a distinctive part of either. */
  entry(idOrPart: string): LoadedEntry {
    return findEntry(this.entries(), idOrPart);
  }

  #read(rel: string): string {
    return safeRead(this.root, rel).toString("utf8");
  }

  #taken(): (rel: string) => boolean {
    return (rel) => fs.existsSync(path.join(this.root, rel));
  }

  #reload(rel: string): LoadedEntry {
    this.#cache.delete(rel);
    return parseEntry(rel, this.#read(rel));
  }

  addEntry(input: EntryInput, files: FileInput[] = []): LoadedEntry {
    return this.save(input, files).entry;
  }

  /** Logs an event and reports privacy notices (location removed, sensitive text spotted). */
  save(input: EntryInput, files: FileInput[] = []): SaveResult {
    requireWritable(this.config());
    const stored = files.map((f) => this.files.put(f));
    const draft = buildEntry(input, stored.map((s) => s.link), this.#taken());
    safeWrite(this.root, draft.path, draft.source);
    const entry = this.#reload(draft.path);
    this.#commit([draft.path, ...stored.map((s) => s.link.path)], commitMessage("log", entry));
    return { entry, notices: [...stored.flatMap((s) => s.notices), ...sensitiveNotices(entry)] };
  }

  updateEntry(idOrPart: string, changes: EntryChanges, files: FileInput[] = []): LoadedEntry {
    return this.saveChanges(idOrPart, changes, files).entry;
  }

  /** Rewrites only what changed: handwritten Markdown, links and unknown metadata are kept. */
  saveChanges(idOrPart: string, changes: EntryChanges, files: FileInput[] = []): SaveResult {
    requireWritable(this.config());
    const cur = this.entry(idOrPart);
    const stored = files.map((f) => this.files.put(f));
    const next = applyChanges(this.#read(cur.path), changes, stored.map((s) => s.link), cur.path);
    safeWrite(this.root, cur.path, next);
    const entry = this.#reload(cur.path);
    this.#commit([cur.path, ...stored.map((s) => s.link.path)], commitMessage("edit", entry));
    return { entry, notices: [...stored.flatMap((s) => s.notices), ...droppedLinks(cur, entry), ...sensitiveNotices(entry)] };
  }

  /**
   * Moves or renames an event, keeping its links to files working. Git follows
   * the rename, so the event keeps its history even though its path is its name.
   */
  moveEntry(idOrPart: string, toPath: string): LoadedEntry {
    requireWritable(this.config());
    const cur = this.entry(idOrPart);
    const target = toPath.replace(/^\.?\//, "").replace(/\\/g, "/");
    if (!EVENT_FILE.test(target)) throw new UserError(`An event lives under ${EVENTS_DIR}/ and ends in .md: ${toPath}`);
    if (target === cur.path) return cur;
    if (fs.existsSync(insideRoll(this.root, target))) throw new UserError(`There's already a file at ${target}.`);
    safeWrite(this.root, target, moveEntry(this.#read(cur.path), cur.path, target));
    safeRemove(this.root, cur.path);
    this.#cache.delete(cur.path);
    const entry = this.#reload(target);
    this.#commit([cur.path, target], commitMessage("move", entry));
    return entry;
  }

  /** Removes the event from the timeline. Git history keeps every earlier version. */
  deleteEntry(idOrPart: string): void {
    requireWritable(this.config());
    const cur = this.entry(idOrPart);
    safeRemove(this.root, cur.path);
    this.#cache.delete(cur.path);
    this.#commit([cur.path], commitMessage("delete", cur));
  }

  /** Puts a deleted event back, exactly as it was. Used by undo. */
  restoreEntry(entry: LoadedEntry, source?: string): LoadedEntry {
    requireWritable(this.config());
    if (fs.existsSync(insideRoll(this.root, entry.path))) throw new UserError("That event is already in the Roll.");
    safeWrite(this.root, entry.path, source ?? `${entry.body}\n`);
    const restored = this.#reload(entry.path);
    this.#commit([entry.path], commitMessage("restore", restored));
    return restored;
  }

  /**
   * Puts an earlier version of an event back, as a new commit. Nothing is
   * rewritten and nothing is lost: the versions in between stay in history, and
   * the restore is itself an entry in it.
   */
  restoreVersion(idOrPart: string, commit: string): { entry: LoadedEntry; from: string; unchanged: boolean } {
    requireWritable(this.config());
    const cur = this.entry(idOrPart);
    if (!/^[0-9a-zA-Z_^~@{}./-]{1,200}$/.test(commit)) throw new UserError(`That isn't a commit: ${commit}`);
    const sha = tryRun(this.root, ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`])?.trim();
    if (!sha) throw new NotFoundError(`There's no commit ${commit} in this Roll's history.`);
    // --follow means a version from before a rename is still reachable by the event's current path.
    const oldPath = this.#pathAt(sha, cur.path);
    const source = tryRun(this.root, ["show", `${sha}:${oldPath}`]);
    if (source === null) throw new NotFoundError(`This event doesn't exist in ${commit.slice(0, 12)}.`);
    const current = this.#read(cur.path);
    if (source === current) return { entry: cur, from: sha.slice(0, 12), unchanged: true };
    safeWrite(this.root, cur.path, source);
    const entry = this.#reload(cur.path);
    this.#commit([cur.path], `restore: ${summarize(entry.title)} (from ${sha.slice(0, 12)})`);
    return { entry, from: sha.slice(0, 12), unchanged: false };
  }

  /** Where this event lived at `sha`, following renames back through history. */
  #pathAt(sha: string, current: string): string {
    const out = tryRun(this.root, ["log", "--follow", "-M25%", "--name-only", "--format=%x1e%H", `${sha}..HEAD`, "--", current]);
    if (!out) return current;
    // The oldest name in the range is what the file was called at `sha`.
    const names = out.split("\x1e").flatMap((chunk) => chunk.split("\n").slice(1).filter((l) => l.trim()));
    return names[names.length - 1] ?? current;
  }

  /** The file as it is on disk, for interfaces that edit the Markdown itself. */
  entrySource(idOrPart: string): string {
    return this.#read(this.entry(idOrPart).path);
  }

  /**
   * Events a sync couldn't combine on its own. Each keeps this device's version
   * intact with the other one quoted underneath, so both texts are still here
   * and a person decides between them.
   */
  conflicts(): Conflict[] {
    return this.entries()
      .filter((e) => e.tags.includes(CONFLICT_TAG))
      .flatMap((e) => {
        const split = splitConflict(this.#read(e.path));
        return split ? [{ entry: e, ...split }] : [];
      });
  }

  /**
   * Settles one conflicted event: keep what is here, take the other version, or
   * supply the text you made of the two. Whichever way, it is a new commit, and
   * every earlier version stays in history.
   */
  resolveConflict(idOrPart: string, choice: "mine" | "theirs" | { text: string }): LoadedEntry {
    requireWritable(this.config());
    const cur = this.entry(idOrPart);
    const source = this.#read(cur.path);
    const split = splitConflict(source);
    if (!split) throw new UserError(`${cur.path} isn't waiting on a conflict.`);
    const text = typeof choice === "object" ? choice.text.trim() : choice === "mine" ? split.mine : split.theirs;
    if (!text.trim()) throw new UserError("A resolved event still needs some text.");
    const next = applyChanges(source, { text, tags: cur.tags.filter((t) => t !== CONFLICT_TAG) }, [], cur.path);
    safeWrite(this.root, cur.path, next);
    const entry = this.#reload(cur.path);
    this.#commit([cur.path], `resolve: ${summarize(entry.title)}`);
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
    // -M25% so a move that also rewrote the event's relative links is still
    // followed: an event is a small file, and its path is its name.
    const out = tryRun(this.root, ["log", "--follow", "-M25%", "-p", "--format=%x1e%H%x1f%an%x1f%aI%x1f%s", "--", cur.path]) ?? "";
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
    return this.entries().flatMap((e) => findSensitive(e.body).map((kind) => ({ path: e.path, error: `may contain a ${kind}` })));
  }

  /** The file on disk for a repository-relative path an event links to. */
  attachmentFile(relPath: string): string | null {
    return this.files.locate(relPath);
  }

  /** A portable copy of the Roll's events as JSON or a readable Markdown timeline. */
  export(format: "json" | "markdown"): string {
    const entries = this.entries();
    if (format === "json") {
      return JSON.stringify({ roll: this.config().name, exported: isoDate(), events: entries }, null, 2);
    }
    const lines = [`# ${this.config().name}`, "", `Exported ${isoDate()} · ${entries.length} events`, ""];
    for (const e of entries) {
      lines.push(`## ${e.date ?? "Undated"}${e.projects.length ? ` · ${e.projects.join(", ")}` : ""}`);
      lines.push("", e.body || "(no text)", "");
      const meta = [e.amount ? `Amount: ${e.amount.value} ${e.amount.currency}` : "", e.tags.length ? `Tags: ${e.tags.join(", ")}` : ""].filter(Boolean);
      if (meta.length) lines.push(meta.join(" · "), "");
    }
    return lines.join("\n");
  }

  // ── Sync ────────────────────────────────────────────────────────────────

  /**
   * Where this log stands right now: its branch, its head, and what is backed
   * up. Read from Git every time it is asked for, so a branch someone switched
   * in another terminal shows up on the next refresh.
   */
  status(): SyncStatus {
    const remote = tryRun(this.root, ["remote"])?.split("\n").map((s) => s.trim()).find(Boolean) ?? null;
    const head = tryRun(this.root, ["rev-parse", "--short", "HEAD"])?.trim() || null;
    const hasCommits = !!head;
    // symbolic-ref fails on a detached HEAD, and before the first commit it
    // names the branch that is about to exist.
    const symbolic = tryRun(this.root, ["symbolic-ref", "--short", "HEAD"])?.trim() || null;
    const detached = hasCommits && !symbolic;
    const branch = detached ? null : symbolic;
    const dirty = (tryRun(this.root, ["status", "--porcelain"]) ?? "").trim().length > 0;
    let ahead = 0;
    let behind = 0;
    if (remote && branch) {
      const counts = tryRun(this.root, ["rev-list", "--left-right", "--count", `refs/remotes/${remote}/${branch}...HEAD`]);
      if (counts) [behind, ahead] = counts.trim().split(/\s+/).map(Number);
      else ahead = Number(tryRun(this.root, ["rev-list", "--count", "HEAD"]) ?? 0); // never uploaded
    }
    const url = remote ? tryRun(this.root, ["remote", "get-url", remote])?.trim() : null;
    return {
      remote,
      remoteUrl: url ? displayRemote(url) : null,
      repo: url ? repoName(url) : null,
      branch,
      detached,
      head,
      hasCommits,
      ahead,
      behind,
      dirty,
    };
  }

  /**
   * What the repository this log lives in is doing right now, for an event that
   * wants to record it: the repository, the branch and the commit. This is the
   * *source* repository — where the work happened — which is the same
   * repository as the log when the log sits next to the project.
   */
  sourceNow(dir: string = this.root): SourceRef | null {
    const root = findGitRoot(dir);
    if (!root) return null;
    const url = tryRun(root, ["remote", "get-url", tryRun(root, ["remote"])?.split("\n")[0]?.trim() || "origin"])?.trim();
    const commit = tryRun(root, ["rev-parse", "HEAD"])?.trim();
    const branch = tryRun(root, ["symbolic-ref", "--short", "HEAD"])?.trim();
    const ref: SourceRef = {};
    if (url) {
      const name = repoName(url);
      if (name) ref.repo = name;
      const web = repoUrl(url);
      if (web && !name) ref.url = web;
    }
    if (!ref.repo && !ref.url) ref.repo = path.basename(root);
    if (branch) ref.branch = branch;
    if (commit && /^[0-9a-f]{40}$/.test(commit)) ref.commit = commit;
    return ref.commit || ref.branch ? ref : null;
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
    const { remote, branch, detached } = this.status();
    if (!remote) return { ok: false, code: "no-remote", message: "This Roll isn't backed up yet." };
    if (detached || !branch) {
      return {
        ok: false,
        code: "error",
        message:
          "This repository isn't on a branch (detached HEAD), so there's nothing to sync with. " +
          "Your events are saved here. Run `git switch -c <branch>` or `git switch main`, then sync again.",
      };
    }
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
      for (const p of conflicts) if (EVENT_FILE.test(p)) merged.add(p);
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
      if (EVENT_FILE.test(rel)) {
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
      if (rel.startsWith(`${FILES_DIR}/`)) {
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

/** New text can leave a file behind: say so, because the file itself is still there. */
function droppedLinks(before: LoadedEntry, after: LoadedEntry): string[] {
  const kept = new Set(after.attachments.map((a) => a.path));
  const gone = before.attachments.filter((a) => !kept.has(a.path)).map((a) => a.path);
  if (!gone.length) return [];
  return [`This event no longer links ${gone.join(", ")}. The ${gone.length === 1 ? "file is" : "files are"} still in the Roll; link ${gone.length === 1 ? "it" : "them"} again, or delete ${gone.length === 1 ? "it" : "them"} with Git.`];
}

function sensitiveNotices(entry: LoadedEntry): string[] {
  const kinds = findSensitive(entry.body);
  return kinds.length ? [`This event may contain a ${kinds.join(" and ")}. Events are kept in history even after editing, so avoid saving secrets.`] : [];
}
