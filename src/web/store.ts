import type { Attachment } from "../core/entry.ts";
import type { EntryChanges, EntryInput, HistoryItem, LoadedEntry, Problem, TemplateStatus } from "../core/layout.ts";

export interface SyncStatus {
  remote: string | null;
  remoteUrl: string | null;
  branch: string;
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
  ai: { enabled: boolean };
}

export interface Saved {
  entry: LoadedEntry;
  /** Privacy notices to show the user, e.g. location removed from a photo. */
  notices: string[];
}

export interface Answer {
  answer: string;
  sources: { id: string; short: string }[];
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
  ask(question: string): Promise<Answer>;
}

/** The backend can't be reached. */
export class ServerUnavailableError extends Error {}
/** The browser isn't signed in (or its session ended). */
export class SignedOutError extends Error {}
