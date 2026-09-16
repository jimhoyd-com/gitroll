import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { planIngest } from "../core/adapter.ts";
import type { EventDraft } from "../core/adapter.ts";
import { parseEntry, retargetLinks, splitSource } from "../core/entry.ts";
import { availableTemplates } from "../core/templates.ts";
import type { EntryTemplate } from "../core/templates.ts";
import { readTemplate } from "./template-file.ts";
import {
  EVENT_FILE,
  GITROLL_DIR,
  TEMPLATE_VERSION,
  EVENTS_DIR,
  TEMPLATES_DIR,
  TEMPLATE_FILE,
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
import { ConflictError, NotFoundError, UserError, extensionFor, isoDate, summarize, uniq } from "../core/util.ts";
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

/** Something about the folder's Git state that stops syncing until a person deals with it. */
export type SyncBlocker = "detached" | "merging" | "rebasing";

export interface SyncStatus {
  /** Remote name, e.g. origin. */
  remote: string | null;
  /** Credential-free location, e.g. github.com/you/my-roll */
  remoteUrl: string | null;
  /**
   * The branch the log's own repository is on, or "" when HEAD isn't on one.
   * This is the Roll's branch: it is not the branch an event's `source:` says
   * its work happened on, even when they are the same repository.
   */
  branch: string;
  /** Why syncing can't run right now, if anything. Logging works regardless. */
  blocker: SyncBlocker | null;
  /** Files changed in the folder but not committed (hand edits, mostly). */
  uncommitted: number;
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
  /**
   * Log records changed in the folder but not committed — files under
   * .gitroll/ only. These are the ones a backup would *not* carry: a commit is
   * what gets uploaded, so writing that is only saved on disk is not backed up
   * however far ahead or behind the branch is.
   */
  uncommittedLog: number;
  /**
   * Commits waiting to be uploaded that touch files outside .gitroll/ — code,
   * in a Roll that lives beside a project. A sync pushes the branch, so these
   * go with it: a backup is never only the log when the branch carries more.
   */
  pendingOther: number;
}

export type SyncCode = "ok" | "no-remote" | "offline" | "auth" | "conflict" | "public" | "unverified" | "blocked" | "error";

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

/** An event that was deleted, as it was just before it went. */
export interface DeletedEntry {
  entry: LoadedEntry;
  /** The file exactly as it stood before the deletion, front matter and all. */
  source: string;
  /** When the deletion was committed. */
  deletedAt: string;
  commit: string;
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

/** What the person has to do about a Git state that stops syncing — and what still works meanwhile. */
export function describeBlocker(blocker: SyncBlocker): string {
  switch (blocker) {
    case "detached":
      return "This folder isn't on a branch, so GitRoll can't back it up. Logging still works and nothing is lost. To get back: git checkout main";
    case "merging":
      return "A merge is unfinished in this folder, so GitRoll won't sync on top of it. Logging still works. Finish it with: git merge --continue (or git merge --abort)";
    case "rebasing":
      return "A rebase is unfinished in this folder, so GitRoll won't sync on top of it. Logging still works. Finish it with: git rebase --continue (or git rebase --abort)";
  }
}

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

  /**
   * Commits exactly these paths, leaving anything else the user has staged alone.
   *
   * In a Roll configured `commit: manual` this writes nothing to Git at all:
   * the files are already on disk, and committing them is the person's to do,
   * with `gitroll save` or with Git itself. That is the point of the setting —
   * a log that shares a repository with a project shouldn't drop a commit into
   * the middle of somebody's branch.
   */
  #commit(paths: string[], message: string, opts: { force?: boolean } = {}): string | null {
    const unique = uniq(paths);
    if (!unique.length) return null;
    const config = this.config();
    // `gitroll save` is the person asking for a commit, which is the whole
    // point of manual mode rather than an exception to it.
    if (!config.autoCommit && !opts.force) return null;
    this.git(["add", "-A", "--", ...unique]);
    if (tryRun(this.root, ["diff", "--cached", "--quiet", "--", ...unique]) !== null) return null;
    try {
      this.git(["commit", "-q", "-m", `${config.commitPrefix}${message}`, "--", ...unique]);
    } catch (e) {
      throw commitRefused(e as Error, unique, this.#commitHooks());
    }
    return this.git(["rev-parse", "HEAD"]).trim();
  }

  /**
   * The repository's own commit hooks, if it has any that would run here.
   *
   * Git says nothing about hooks when one fails — it relays whatever the hook
   * printed and exits non-zero — so reading the failure text is guesswork.
   * Asking the repository which hooks exist is not.
   */
  #commitHooks(): string[] {
    const dir = tryRun(this.root, ["rev-parse", "--git-path", "hooks"])?.trim();
    if (!dir) return [];
    const hooks = path.resolve(this.root, dir);
    return ["pre-commit", "commit-msg", "prepare-commit-msg"].filter((name) => {
      try {
        return !!(fs.statSync(path.join(hooks, name)).mode & 0o111);
      } catch {
        return false;
      }
    });
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
  saveChanges(idOrPart: string, changes: EntryChanges, files: FileInput[] = [], opts: { expect?: string } = {}): SaveResult {
    requireWritable(this.config());
    const cur = this.entry(idOrPart);
    // An editor may have saved the same file since this writer read it.
    if (opts.expect !== undefined && opts.expect !== this.fingerprint(idOrPart)) {
      throw new ConflictError("This entry changed on disk since you opened it, so nothing was saved.");
    }
    const stored = files.map((f) => this.files.put(f));
    const next = applyChanges(this.#read(cur.path), changes, stored.map((s) => s.link), cur.path);
    safeWrite(this.root, cur.path, next);
    const entry = this.#reload(cur.path);
    this.#commit([cur.path, ...stored.map((s) => s.link.path)], commitMessage("edit", entry));
    return { entry, notices: [...stored.flatMap((s) => s.notices), ...droppedLinks(cur, entry), ...sensitiveNotices(entry)] };
  }

  /**
   * Writes an event's file exactly as given — the whole document, front matter
   * and all.
   *
   * This is what an edit made in the person's own text editor is: they were
   * shown the file, so what comes back is the file. Stripping the YAML and
   * keeping only the words under it would quietly throw away an amount, a date
   * or a key GitRoll doesn't read, which is precisely what someone editing
   * front matter by hand was trying to change. The text is parsed first, so an
   * unreadable document is refused before anything on disk is touched.
   */
  writeEntrySource(idOrPart: string, source: string, opts: { expect?: string } = {}): SaveResult {
    requireWritable(this.config());
    const cur = this.entry(idOrPart);
    if (opts.expect !== undefined && opts.expect !== this.fingerprint(idOrPart)) {
      throw new ConflictError("This entry changed on disk since you opened it, so nothing was saved.");
    }
    const text = source.replace(/\s*$/, "\n");
    parseEntry(cur.path, text); // throws before a word is written
    if (text === this.#read(cur.path)) return { entry: cur, notices: [] };
    safeWrite(this.root, cur.path, text);
    const entry = this.#reload(cur.path);
    this.#commit([cur.path], commitMessage("edit", entry));
    return { entry, notices: [...droppedLinks(cur, entry), ...sensitiveNotices(entry)] };
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
    // Events that point at this one are rewritten in the same commit. An event's
    // identity is its path, so moving it silently turns every reference to it
    // into a dead link — and the reference is usually the whole reason the
    // other event mentions it.
    const inbound = this.entries().filter((e) => e.path !== cur.path && e.links.includes(cur.path));
    safeWrite(this.root, target, moveEntry(this.#read(cur.path), cur.path, target));
    safeRemove(this.root, cur.path);
    this.#cache.delete(cur.path);
    for (const e of inbound) {
      const src = this.#read(e.path);
      const { head, body } = splitSource(src);
      safeWrite(this.root, e.path, `${head}${retargetLinks(body, e.path, cur.path, target)}`);
      this.#cache.delete(e.path);
    }
    const entry = this.#reload(target);
    this.#commit([cur.path, target, ...inbound.map((e) => e.path)], commitMessage("move", entry));
    return entry;
  }

  /**
   * Removes the event from the timeline. Git history keeps every earlier
   * version. Returns the file exactly as it was, so whoever deleted it can
   * hand it straight back to `restoreEntry`.
   */
  deleteEntry(idOrPart: string): string {
    requireWritable(this.config());
    const cur = this.entry(idOrPart);
    const source = this.#read(cur.path);
    safeRemove(this.root, cur.path);
    this.#cache.delete(cur.path);
    this.#commit([cur.path], commitMessage("delete", cur));
    return source;
  }

  /**
   * What the event's file looks like on disk right now. An editor opening the
   * same entry is an ordinary thing to do, so a writer takes this when it starts
   * and hands it back on save: if it no longer matches, someone else got there first.
   */
  fingerprint(idOrPart: string): string {
    const cur = this.entry(idOrPart);
    return createHash("sha256").update(safeRead(this.root, cur.path)).digest("hex");
  }

  /**
   * Puts a deleted event back, exactly as it was. Used by undo.
   *
   * `source` is the file, not the text of the event: rebuilding it from the
   * body alone would drop the front matter with it, losing the amount, the
   * topics, the tags and anything GitRoll itself doesn't read. It is required
   * for that reason — `deleteEntry` returns it, and `deleted()` carries it.
   */
  restoreEntry(entry: LoadedEntry, source: string): LoadedEntry {
    requireWritable(this.config());
    if (fs.existsSync(insideRoll(this.root, entry.path))) throw new UserError("That event is already in the Roll.");
    safeWrite(this.root, entry.path, source);
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
    // An event may have been called something else at that commit, so try every
    // name Git says it has had.
    const source = this.#atCommit(sha, cur.path);
    if (source === null) throw new NotFoundError(`This event doesn't exist in ${commit.slice(0, 12)}, under any of the names it has had.`);
    const current = this.#read(cur.path);
    if (source === current) return { entry: cur, from: sha.slice(0, 12), unchanged: true };
    safeWrite(this.root, cur.path, source);
    const entry = this.#reload(cur.path);
    this.#commit([cur.path], `restore: ${summarize(entry.title)} (from ${sha.slice(0, 12)})`);
    return { entry, from: sha.slice(0, 12), unchanged: false };
  }

  /**
   * The newest commit whose version of this event differs from what is on disk.
   * "The previous version" means the last time the text was different, not the
   * last commit that happened to touch the file: a rename or a move isn't a
   * version of the text worth restoring.
   */
  previousVersion(idOrPart: string): string | null {
    const cur = this.entry(idOrPart);
    const current = this.#read(cur.path);
    for (const item of this.history(cur.path)) {
      const text = this.#atCommit(item.commit, cur.path);
      if (text !== null && text !== current) return item.commit;
    }
    return null;
  }

  /** This event's text at a commit, under whichever name it had then. */
  #atCommit(sha: string, current: string): string | null {
    for (const name of this.#namesOf(current)) {
      const text = tryRun(this.root, ["show", `${sha}:${name}`]);
      if (text !== null) return text;
    }
    return null;
  }

  /** Every path this event has had, newest first: renames are ordinary Git renames. */
  #namesOf(current: string): string[] {
    const out = [current];
    const log = tryRun(this.root, ["log", "--follow", "-M25%", "--name-status", "--format=", "--", current]) ?? "";
    for (const line of log.split("\n")) {
      const rename = /^R\d*\t(.+)\t(.+)$/.exec(line.trim());
      if (rename && !out.includes(rename[1])) out.push(rename[1]);
    }
    return out;
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
    // Every path this event has had, then the commits touching any of them.
    // Not `git log --follow`: that asks Git to guess where a file came from
    // when it was added, and two events are similar enough — a heading, a
    // line of text and the same front matter keys — that it answers with an
    // unrelated event and shows its commits as this one's history. The rename
    // chain is read from Git's own R entries instead, which are only recorded
    // when a file really did move.
    const out = tryRun(this.root, ["log", "-p", "--format=%x1e%H%x1f%an%x1f%aI%x1f%s", "--", ...this.#namesOf(cur.path)]) ?? "";
    return out
      .split("\x1e")
      .filter((c) => c.trim())
      .map((chunk) => {
        const nl = chunk.indexOf("\n");
        const [commit, author, date, subject] = (nl < 0 ? chunk : chunk.slice(0, nl)).split("\x1f");
        return { commit, author, date, subject, patch: nl < 0 ? "" : chunk.slice(nl + 1).trim() };
      });
  }

  /**
   * Events that were deleted and aren't in the Roll now, newest deletion first,
   * read back out of Git history. Nothing here is lost — this is where someone
   * finds it without knowing a single Git command.
   *
   * A move is a delete and an add underneath, and Git only calls it a rename
   * when it goes looking: with `diff.renames` off, or past `diff.renameLimit`
   * in a large commit, a moved event arrives here as a deletion. So an event
   * whose text is in the Roll under another name is left out — it didn't go
   * anywhere, and offering to put back a second copy of it would be wrong.
   */
  deleted(limit = 50): DeletedEntry[] {
    const log = tryRun(this.root, ["log", "--diff-filter=D", "--name-only", `--max-count=${limit}`, "--format=%x1e%H%x1f%aI", "--", EVENTS_DIR]) ?? "";
    if (!log.trim()) return [];
    // Read once: every event in the Roll as its file stands now.
    const here = new Set(this.entries().map((e) => this.#read(e.path)));
    const found: DeletedEntry[] = [];
    const seen = new Set<string>();
    for (const chunk of log.split("\x1e").filter((c) => c.trim())) {
      const [head = "", ...paths] = chunk.split("\n");
      const [commit, deletedAt] = head.split("\x1f");
      for (const rel of paths.map((p) => p.trim()).filter((p) => EVENT_FILE.test(p))) {
        // Written again since, at the same path: not deleted any more.
        if (fs.existsSync(insideRoll(this.root, rel))) continue;
        // The version as it stood in the commit before the one that removed it.
        const source = tryRun(this.root, ["show", `${commit}^:${rel}`]);
        if (source === null || here.has(source) || seen.has(source)) continue;
        seen.add(source);
        try {
          found.push({ entry: parseEntry(rel, source), source, deletedAt, commit });
        } catch {
          // An event that never parsed isn't one this can offer to put back.
        }
      }
    }
    return found;
  }

  /**
   * Puts back an event that was deleted, found by path or by a distinctive part
   * of its name — the same way every other command finds an event. Recovery is
   * only real if somebody can reach it without knowing Git.
   */
  restoreDeleted(idOrPart: string, limit = 200): LoadedEntry {
    const gone = this.deleted(limit);
    if (!gone.length) throw new NotFoundError("Nothing has been deleted from this Roll.");
    const match = findEntry(gone.map((d) => d.entry), idOrPart);
    const chosen = gone.find((d) => d.entry.path === match.path)!;
    return this.restoreEntry(chosen.entry, chosen.source);
  }

  /**
   * The starting points this Roll offers: its own, then whichever of GitRoll's
   * it keeps. A Roll with no templates folder gets exactly what it always did.
   *
   * A file that can't be read is left out rather than breaking the list — the
   * person is told about it by `gitroll check`, which is where problems with
   * files in a Roll are reported.
   */
  templates(): EntryTemplate[] {
    return availableTemplates(this.rollTemplates(), this.config().builtInTemplates);
  }

  /** Only the ones written in this Roll, unreadable files skipped. */
  rollTemplates(): EntryTemplate[] {
    const dir = path.join(this.root, TEMPLATES_DIR);
    if (!fs.existsSync(dir)) return [];
    const out: EntryTemplate[] = [];
    for (const rel of walkFiles(this.root, TEMPLATES_DIR).files.filter((f) => TEMPLATE_FILE.test(f))) {
      try {
        out.push(readTemplate(rel, this.#read(rel)));
      } catch {
        // `check` reports it; a broken file mustn't cost somebody the rest of the list.
      }
    }
    return out;
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
    // Empty rather than a guess: HEAD really can be on no branch, and saying
    // "main" then measuring against origin/main is how you mislead someone.
    const branch = tryRun(this.root, ["symbolic-ref", "--short", "HEAD"])?.trim() ?? "";
    const head = tryRun(this.root, ["rev-parse", "--short", "HEAD"])?.trim() || null;
    const changes = (tryRun(this.root, ["status", "--porcelain"]) ?? "").split("\n").filter((l) => l.trim());
    const dirty = changes.length > 0;
    const blocker: SyncBlocker | null = !branch ? "detached" : this.#mergeInProgress() ? "merging" : this.#rebaseInProgress() ? "rebasing" : null;
    let ahead = 0;
    let behind = 0;
    if (remote && branch) {
      const counts = tryRun(this.root, ["rev-list", "--left-right", "--count", `refs/remotes/${remote}/${branch}...HEAD`]);
      if (counts) [behind, ahead] = counts.trim().split(/\s+/).map(Number);
      else ahead = Number(tryRun(this.root, ["rev-list", "--count", "HEAD"]) ?? 0); // never uploaded
    }
    const url = remote ? tryRun(this.root, ["remote", "get-url", remote])?.trim() : null;
    // Saved on disk and committed are different things, and so are committed
    // and uploaded. Count each separately rather than letting "no commits to
    // push" stand in for "everything you wrote is backed up".
    const inRoll = (line: string) => line.slice(3).replace(/^"|"$/g, "").split(" -> ").pop()?.startsWith(`${GITROLL_DIR}/`) ?? false;
    const uncommittedLog = changes.filter(inRoll).length;
    return {
      remote,
      remoteUrl: url ? displayRemote(url) : null,
      repo: url ? repoName(url) : null,
      branch,
      blocker,
      uncommitted: changes.length,
      head,
      hasCommits: !!head,
      ahead,
      behind,
      dirty,
      uncommittedLog,
      pendingOther: ahead ? this.#pendingOutsideRoll(remote, branch, ahead) : 0,
    };
  }

  /**
   * Commits log records that were written or edited outside GitRoll, so a
   * backup carries them.
   *
   * Only files under .gitroll/ are ever touched. A Roll can share a repository
   * with a project, and committing somebody's half-finished code because they
   * asked GitRoll to save their logbook would be indefensible; their staged
   * changes are left staged, too.
   */
  commitPending(): { committed: string[] } {
    requireWritable(this.config());
    const lines = (tryRun(this.root, ["status", "--porcelain", "--", GITROLL_DIR]) ?? "").split("\n").filter((l) => l.trim());
    const paths = uniq(
      lines.flatMap((l) => l.slice(3).replace(/^"|"$/g, "").split(" -> ").map((p) => p.trim())).filter((p) => p.startsWith(`${GITROLL_DIR}/`) || p === GITROLL_DIR),
    );
    if (!paths.length) return { committed: [] };
    this.#commit(paths, `log: save ${paths.length} ${paths.length === 1 ? "file" : "files"} written outside a GitRoll commit`, { force: true });
    this.#cache.clear();
    return { committed: paths };
  }

  /**
   * How many commits waiting to be uploaded change something other than the
   * log. `gitroll sync` pushes the branch, not a path: in a Roll that shares a
   * repository with a project, a pending code commit is uploaded too, and
   * whoever is syncing a private logbook deserves to be told that before it
   * happens rather than after.
   */
  #pendingOutsideRoll(remote: string | null, branch: string, ahead: number): number {
    if (!remote || !branch) return 0;
    const range = tryRun(this.root, ["rev-parse", "--verify", "-q", `refs/remotes/${remote}/${branch}`]) ? `refs/remotes/${remote}/${branch}..HEAD` : "HEAD";
    const log = tryRun(this.root, ["log", "--format=%x1e%s", "--name-only", `--max-count=${Math.min(ahead, 500)}`, range]) ?? "";
    return log
      .split("\x1e")
      .filter((c) => c.trim())
      .filter((c) => {
        const [subject = "", ...names] = c.split("\n");
        // Creating a Roll writes a README beside .gitroll/. That is GitRoll's
        // own commit, and calling it "code someone else wrote" would turn the
        // very first backup into a warning about nothing.
        if (subject.trim().startsWith("gitroll:")) return false;
        return names.map((l) => l.trim()).filter(Boolean).some((f) => !f.startsWith(`${GITROLL_DIR}/`));
      }).length;
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
    const status = this.status();
    if (status.blocker) return { ok: false, code: "blocked", message: describeBlocker(status.blocker) };
    if (!status.remote) {
      return { ok: false, code: "no-remote", message: "This Roll isn't backed up yet. Your events are saved on this computer. Run: gitroll backup" };
    }
    const { remote } = status;
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
    // sync() has already refused anything with a blocker, detached HEAD included.
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

  #mergeInProgress(): boolean {
    const gitPath = tryRun(this.root, ["rev-parse", "--git-path", "MERGE_HEAD"])?.trim();
    return !!gitPath && fs.existsSync(path.resolve(this.root, gitPath));
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

/**
 * What a sync is about to do, in the words someone needs *before* it happens.
 *
 * GitRoll commits the log by path, so it is easy to assume a backup uploads the
 * log by path too. It doesn't: `git push` sends the branch. In a Roll that
 * lives beside a project, that branch can carry code, and a private logbook
 * going to a private repository is a different promise from a repository's
 * whole branch going with it. It is said plainly instead of discovered.
 */
export interface SyncPlan {
  /** Where the push really goes, as shown to a person. */
  destination: string | null;
  branch: string;
  /** Commits being uploaded that change files outside .gitroll/. */
  otherCommits: number;
  /** Log records saved on this computer but not committed, so not in this backup. */
  uncommittedLog: number;
  /** What to say before syncing. Empty when there is nothing surprising. */
  notes: string[];
}

export function syncPlan(status: SyncStatus): SyncPlan {
  const notes: string[] = [];
  if (status.remoteUrl && status.branch) {
    notes.push(`Uploading branch ${status.branch} to ${status.remoteUrl}.`);
  }
  if (status.pendingOther) {
    notes.push(
      `This sends the whole branch, not just the log: ${status.pendingOther} ${status.pendingOther === 1 ? "commit changes" : "commits change"} files outside ${GITROLL_DIR}/ and will be uploaded too.`,
    );
  }
  if (status.uncommittedLog) {
    notes.push(
      `${status.uncommittedLog} ${status.uncommittedLog === 1 ? "log record is" : "log records are"} saved on this computer but not committed, so ${status.uncommittedLog === 1 ? "it won't be" : "they won't be"} in this backup. Commit ${status.uncommittedLog === 1 ? "it" : "them"} first: gitroll save`,
    );
  }
  return { destination: status.remoteUrl, branch: status.branch, otherCommits: status.pendingOther, uncommittedLog: status.uncommittedLog, notes };
}

/**
 * A commit GitRoll couldn't make, said in a way that doesn't read as lost work.
 *
 * The event is already written — `safeWrite` ran before Git was asked anything —
 * so the only thing that failed is recording it. In a repository that also holds
 * a project, the usual reason is that repository's own commit hook: it runs the
 * team's linter or tests, and those have nothing to do with a logbook entry.
 */
function commitRefused(error: Error, paths: string[], hooks: string[]): UserError {
  const where = paths[0] ?? "the event";
  return new UserError(
    `${where} is written and safe on this computer, but Git wouldn't commit it.\n\n${error.message.trim()}\n\n` +
      (hooks.length
        ? `This repository has its own ${hooks.join(" and ")} hook, which is about its code rather than your log. Commit the event yourself once the hook is happy, or set "commit: manual" in .gitroll/config.yaml so GitRoll writes events without committing them and "gitroll save" commits when it suits you.`
        : `Nothing was lost. Commit it with "gitroll save" once Git is happy again.`),
  );
}
