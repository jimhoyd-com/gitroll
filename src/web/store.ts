import type { Attachment } from "../core/entry.ts";
import type { EntryChanges, EntryInput, HistoryItem, LoadedEntry, Problem, TemplateStatus } from "../core/layout.ts";
import type { EntryTemplate } from "../core/templates.ts";
import type { QuickFilter } from "../core/filters.ts";
import type { Todo } from "../core/todos.ts";
import { UserError } from "../core/util.ts";

/** Something about the folder's Git state that stops syncing until a person deals with it. */
export type SyncBlocker = "detached" | "merging" | "rebasing";

export interface SyncStatus {
  remote: string | null;
  remoteUrl: string | null;
  /** owner/repo of the log's own repository, when it has one. */
  repo: string | null;
  /** The branch the log's repository is on, or "" when HEAD isn't on one. */
  branch: string;
  blocker: SyncBlocker | null;
  /** Files changed in the folder but not committed. */
  uncommitted: number;
  head: string | null;
  hasCommits: boolean;
  ahead: number;
  behind: number;
  dirty: boolean;
  /** Log records saved on this computer but not committed, so not in any backup. */
  uncommittedLog: number;
  /** Commits waiting to be uploaded that change files outside .gitroll/. */
  pendingOther: number;
}

/** Where a sync has got to, for an interface that shows progress. */
export type SyncStage = "checking" | "downloading" | "combining" | "uploading";

export interface SyncProgress {
  running: boolean;
  stage: SyncStage | null;
  startedAt: number | null;
  last: { at: number; result: SyncResult } | null;
  status: SyncStatus;
}

export interface SyncResult {
  ok: boolean;
  code: "ok" | "no-remote" | "offline" | "auth" | "conflict" | "public" | "unverified" | "error";
  message: string;
  merged?: string[];
  conflicts?: string[];
}

export interface StoreInfo {
  name: string;
  author: string;
  /** Folder on this computer. */
  location: string;
  maxAttachmentBytes: number;
  problems: Problem[];
  /** Which template revision the Roll records, and whether this app may write to it. */
  template: TemplateStatus;
  warnings: string[];
  sync: SyncStatus;
  /** The starting points this Roll offers: its own first, then the built-ins it keeps. */
  templates: EntryTemplate[];
  /** The buttons under the search box, as this Roll wants them. */
  filters: QuickFilter[];
}

export interface Saved {
  entry: LoadedEntry;
  /** Privacy notices to show the user, e.g. location removed from a photo. */
  notices: string[];
}

/** The Roll as the web app sees it: in memory, refreshed from the folder on this computer. */
export interface Store {
  info(): StoreInfo;
  /** Changes whenever the Roll changes. */
  version(): string;
  refresh(): Promise<void>;
  entries(): LoadedEntry[];
  /** Projects any event mentions. There is nothing to create. */
  projects(): string[];
  addEntry(input: EntryInput, files: File[]): Promise<Saved>;
  /** `base` is the entry as it was when the person opened it; stores refuse to overwrite a newer version. */
  updateEntry(id: string, changes: EntryChanges, files: File[], base?: LoadedEntry): Promise<Saved>;
  deleteEntry(id: string, base?: LoadedEntry): Promise<void>;
  history(id: string): Promise<HistoryItem[]>;
  /** A URL for a file an event links to. */
  attachmentUrl(a: Attachment): string;
  sync(): Promise<SyncResult>;
  /** Where a running sync has got to. Cheap enough to poll while one runs. */
  syncProgress(): Promise<SyncProgress>;
  /** Puts an earlier version of an event back, as a new commit. */
  restoreVersion(id: string, commit: string): Promise<LoadedEntry>;
  /** Events deleted from this Roll, newest first, read back out of Git history. */
  deleted(): Promise<DeletedItem[]>;
  /** Puts a deleted event back, exactly as it was. */
  restoreDeleted(path: string): Promise<LoadedEntry>;
  conflicts(): Promise<ConflictPair[]>;
  resolveConflict(id: string, choice: { keep: "mine" | "theirs" } | { text: string }): Promise<LoadedEntry>;
}

/** A file under .gitroll/files/, as `gitroll files` reports it. */
export interface FileItem {
  /** The path links use; for a file kept in parts, the whole file's name. */
  path: string;
  title: string;
  size: number | null;
  parts: number | null;
  sidecar: string | null;
  fields: Record<string, unknown>;
  /** Events and notes that link to it. */
  linkedFrom: string[];
  unfiled: boolean;
  missing: boolean;
}

/**
 * What the pages beside the timeline are made from: the notes (records
 * included), every to-do with its line, and the files. The views themselves
 * (records, upcoming, ledger, inventory) are worked out from these by src/core.
 */
export interface ViewsData {
  notes: LoadedEntry[];
  todos: (Todo & { title: string })[];
  files: FileItem[];
  /**
   * Each note's revision, by path: the sha256 of the file it was read from,
   * as `gitroll show --json` gives it. A field edit sends it back, and is
   * refused if the file has changed since. A note without one can't be edited
   * in place.
   */
  revisions?: Record<string, string>;
}

/** A field written in place, as `gitroll set` reports it. */
export interface FieldsSaved extends Saved {
  /** False when the field already said that, so nothing was written. */
  changed: boolean;
}

/**
 * The parts of a Roll a store can offer beyond the timeline. A store that
 * leaves these out, as GitRoll.com's does for now, simply has no Notes,
 * Records, Upcoming, Ledger, Inventory or Files pages.
 */
export interface ViewsStore {
  views(): Promise<ViewsData>;
  /** Ticks a to-do off, or back on, by the line it is on. */
  markTodo(path: string, line: number, done: boolean): Promise<void>;
  /** A link that downloads the Roll's calendar as an iCalendar file. */
  calendarUrl(): string;

  // Writing. Each is optional: a store without one simply shows no control
  // for it, and the pages stay as they read.

  /** A new note in .gitroll/notes/, as `gitroll note` writes one. */
  addNote?(input: { title: string; text: string }): Promise<Saved>;
  /** A new record in a collection, as `gitroll add <collection> <title> --field k=v` writes one. Values are YAML. */
  addRecord?(input: { collection: string; title: string; fields: [string, string][] }): Promise<Saved>;
  /**
   * Sets one field of a note, as `gitroll set <file> k=v --expect <revision>`
   * does; an empty value removes it (`--unset k`). Refused with
   * ChangedOnDiskError when the file is no longer at `revision`.
   */
  setField?(path: string, key: string, value: string, revision: string): Promise<FieldsSaved>;
  /** A to-do at the end of .gitroll/notes/todo.md, as `gitroll todo` adds one, with an optional 📅 day. */
  addTodo?(text: string, due?: string): Promise<void>;
}

export const hasViews = (store: Store): store is Store & ViewsStore => typeof (store as Partial<ViewsStore>).views === "function";

/**
 * Searches kept by name, as `gitroll find "…" --save <name>` keeps them. The
 * app on this computer keeps them in your settings folder, so they are yours
 * on this computer and work in every Roll. A store without them shows none.
 */
export interface SavedSearchesStore {
  /** Saved searches by name, in the order they were saved. */
  savedSearches(): Promise<Record<string, string>>;
  /** Keeps a search under a name, replacing one already called that. Returns the name it was saved as. */
  saveSearch(name: string, query: string): Promise<string>;
  /** Gives a saved search a new name; never over another one. */
  renameSearch(from: string, to: string): Promise<string>;
  deleteSearch(name: string): Promise<void>;
}

export const hasSavedSearches = (store: Store): store is Store & SavedSearchesStore =>
  typeof (store as Partial<SavedSearchesStore>).savedSearches === "function";

/** What one Roll on this computer holds for a search, as `gitroll find --all` lists it. */
export interface RollHits {
  /** Its name in `gitroll rolls`, or null for the open Roll when it isn't on that list. */
  key: string | null;
  name: string;
  /** The Roll this app is open on. */
  current: boolean;
  /** Why it couldn't be searched, when it couldn't. */
  problem?: string;
  /** How many matched; `entries` may hold only the first of them. */
  total: number;
  entries: LoadedEntry[];
}

/**
 * Every Roll on this computer, searched at once. Read-only. Only the app on
 * this computer knows which Rolls there are, so other stores leave it out.
 */
export interface AllRollsStore {
  searchAllRolls(query: string): Promise<RollHits[]>;
  /** A link that opens another Roll's app, signed in. */
  openRoll(key: string): Promise<string>;
}

export const hasAllRolls = (store: Store): store is Store & AllRollsStore => typeof (store as Partial<AllRollsStore>).searchAllRolls === "function";

/** An event that was deleted, as it stood just before it went. */
export interface DeletedItem {
  path: string;
  title: string;
  date: string | null;
  deletedAt: string;
  body: string;
}

/** An event changed in two places, as the two texts a person chooses between. */
export interface ConflictPair {
  entry: LoadedEntry;
  mine: string;
  theirs: string;
  noted: string;
}

/** The backend can't be reached. */
export class ServerUnavailableError extends Error {}
/** The browser isn't signed in (or its session ended). */
export class SignedOutError extends Error {}
/** A write was refused because the file changed since it was read. Nothing was overwritten. */
export class ChangedOnDiskError extends UserError {}
