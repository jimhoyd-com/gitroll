import type { Attachment } from "../core/entry.ts";
import type { EntryChanges, EntryInput, HistoryItem, LoadedEntry, Problem, Project } from "../core/layout.ts";
import type { EventType } from "../core/types.ts";

export interface SyncStatus {
  remote: string | null;
  remoteUrl: string | null;
  branch: string;
  ahead: number;
  behind: number;
  dirty: boolean;
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
  projects(): Project[];
  types(): EventType[];
  addEntry(input: EntryInput, files: File[]): Promise<Saved>;
  /** `base` is the entry as it was when the person opened it; stores refuse to overwrite a newer version. */
  updateEntry(id: string, changes: EntryChanges, files: File[], base?: LoadedEntry): Promise<Saved>;
  deleteEntry(id: string, base?: LoadedEntry): Promise<void>;
  createProject(name: string): Promise<Project>;
  history(id: string): Promise<HistoryItem[]>;
  attachmentUrl(a: Attachment): string;
  sync(): Promise<SyncResult>;
  ask(question: string): Promise<Answer>;
}

/** The backend can't be reached. */
export class ServerUnavailableError extends Error {}
/** The browser isn't signed in (or its session ended). */
export class SignedOutError extends Error {}
