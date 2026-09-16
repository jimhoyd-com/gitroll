import type { Attachment } from "../core/entry.ts";
import type { EntryChanges, EntryInput, HistoryItem, LoadedEntry, Problem, TemplateStatus } from "../core/layout.ts";

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
  /** How Ask is set up. Settings live with this person's settings, never in a Roll. */
  /** Tries the settings as typed, before they are saved. */
  /** Puts an earlier version of an event back, as a new commit. */
  restoreVersion(id: string, commit: string): Promise<LoadedEntry>;
  conflicts(): Promise<ConflictPair[]>;
  resolveConflict(id: string, choice: { keep: "mine" | "theirs" } | { text: string }): Promise<LoadedEntry>;
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
