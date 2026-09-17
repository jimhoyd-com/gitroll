import type { Attachment } from "../core/entry.ts";
import type { EntryChanges, EntryInput, HistoryItem, LoadedEntry, Problem, TemplateStatus } from "../core/layout.ts";

/** Something about the folder's Git state that stops syncing until a person deals with it. */
export type { SyncBlocker } from "../core/safety.ts";
import type { SyncBlocker } from "../core/safety.ts";

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
  /**
   * Entries that look like they hold a password, a key or a card number. Not a
   * problem with the Roll — somebody may have meant it — but Git keeps history,
   * so it is worth knowing before it is somewhere it can't be taken back from.
   */
  sensitive?: Problem[];
  /** Which template revision the Roll records, and whether this app may write to it. */
  template: TemplateStatus;
  warnings: string[];
  sync: SyncStatus;
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
  /** How Ask is set up. Settings live with this person's settings, never in a Roll. */
  /** Tries the settings as typed, before they are saved. */
  /** Puts an earlier version of an event back, as a new commit. */
  restoreVersion(id: string, commit: string): Promise<LoadedEntry>;
  /*
    What follows a store may not be able to do, and the interface asks before
    it offers: GitRoll.com works through GitHub's API on somebody's repository,
    where backing up means nothing (the repository is the storage) and archiving
    and reading deletions out of history are filesystem work that hasn't moved
    to the edge. A method that isn't here is a button that isn't drawn — which
    is honest, where a stub that throws would be a promise the app can't keep.
  */

  /** Names the Roll — and the entry for it in the list `--roll` reads. */
  rename?(name: string): Promise<{ name: string; key: string }>;
  /** Starts backing this Roll up: a folder on this computer, or an address elsewhere. */
  backup?(destination: string): Promise<{ created: boolean; url: string; sync: SyncResult }>;
  /** The Roll's filing periods, newest first. */
  periods?(): Promise<{
    periods: PeriodRow[];
    settings: StorageSettings;
    canCompress?: boolean;
    recordedZone?: string | null;
    /** Entries written by hand that have no permanent id yet. */
    unmarked?: number;
  }>;
  /**
   * Gives those entries an id, so links to them survive a change of heading.
   * Nothing else about them is touched, and the date each one already had is
   * kept — an entry whose first commit can't be found is left alone.
   */
  adoptEntries?(): Promise<{ adopted: number; skipped: number }>;
  /**
   * Settles which zone this Roll files by. GitRoll never writes this on
   * somebody's behalf, so it is offered where they can see what it means.
   */
  setTimezone?(zone: string): Promise<StorageSettings>;
  /**
   * Puts a period out of the way, or brings it back. Nothing is ever deleted.
   * A store that answers `canCompress: false` is never asked to compress.
   */
  archivePeriod?(period: string, compress: boolean): Promise<PeriodRow[]>;
  unarchivePeriod?(period: string): Promise<PeriodRow[]>;
  /** Entries that have left the Roll, newest first, read back out of Git history. */
  removed?(): Promise<RemovedEntry[]>;
  /** Puts one of them back, whole, as a new commit. */
  restoreRemoved?(id: string): Promise<LoadedEntry>;
  conflicts(): Promise<ConflictPair[]>;
  resolveConflict(id: string, choice: { keep: "mine" | "theirs" } | { text: string }): Promise<LoadedEntry>;
}

/** One filing period: a month (or day) of entries, and whether it is out of the way. */
export interface PeriodRow {
  period: string;
  entries: number;
  bytes: number;
  files: number;
  archived: boolean;
  compressed: boolean;
  unreadable: number;
}

/** How this Roll stores entries, as the app needs to describe it. */
export interface StorageSettings {
  mode: "event" | "monthly" | "daily";
  timezone: string;
  archive: { afterDays: number | null; compress: boolean };
  limits: { maxBytes: number; maxEntries: number };
}

/**
 * An entry that was deleted, as the app needs to show it. The file as it stood
 * stays on the Roll's side: putting it back names the entry, and the Roll is
 * what remembers the text, front matter and all.
 */
export interface RemovedEntry {
  id: string;
  title: string;
  path: string;
  body: string;
  /** When the deletion was committed. */
  deletedAt: string;
  commit: string;
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
