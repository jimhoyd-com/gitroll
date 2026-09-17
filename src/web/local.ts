// Talks to the GitRoll app running on this computer.

import type { Attachment } from "../core/entry.ts";
import type { EntryChanges, EntryInput, HistoryItem, LoadedEntry } from "../core/layout.ts";
import { UserError } from "../core/util.ts";
import { bytesToBase64 } from "./bytes.ts";
import { ServerUnavailableError, SignedOutError } from "./store.ts";
import type { ConflictPair, PeriodRow, RemovedEntry, Saved, StorageSettings, Store, StoreInfo, SyncProgress, SyncResult } from "./store.ts";

export { ServerUnavailableError, SignedOutError };

interface State {
  info: StoreInfo;
  entries: LoadedEntry[];
}


async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`api/${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    throw new ServerUnavailableError("GitRoll has stopped. Start it again from your terminal with: gitroll");
  }
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (res.status === 401) throw new SignedOutError(data?.error ?? "Open GitRoll from the link shown in your terminal.");
  if (!res.ok || data === null) throw new UserError(data?.error ?? `Something went wrong (${res.status}).`);
  return data;
}

export type Connection = { store: LocalStore } | { error: "stopped" | "signed-out" };

export class LocalStore implements Store {
  #state!: State;
  #version = "";

  static async connect(): Promise<Connection> {
    const store = new LocalStore();
    try {
      await store.refresh();
      return { store };
    } catch (e) {
      return { error: e instanceof SignedOutError ? "signed-out" : "stopped" };
    }
  }

  info = () => this.#state.info;
  version = () => this.#version;
  entries = () => this.#state.entries;

  async refresh(): Promise<void> {
    let res: Response;
    try {
      res = await fetch("api/state", { cache: "no-store" });
    } catch {
      throw new ServerUnavailableError("GitRoll has stopped.");
    }
    if (res.status === 401) throw new SignedOutError("Open GitRoll from the link shown in your terminal.");
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("application/json")) throw new ServerUnavailableError("GitRoll has stopped.");
    const text = await res.text();
    if (text === this.#version) return;
    this.#state = JSON.parse(text) as State;
    this.#version = text;
  }

  async #encode(files: File[]) {
    const max = this.#state.info.maxAttachmentBytes;
    const tooBig = files.find((f) => f.size > max);
    if (tooBig) throw new UserError(`${tooBig.name} is too large. Files can be up to ${Math.round(max / 1048576)} MB.`);
    return Promise.all(files.map(async (f) => ({ name: f.name, type: f.type, data: bytesToBase64(new Uint8Array(await f.arrayBuffer())) })));
  }

  async addEntry(input: EntryInput, files: File[]): Promise<Saved> {
    const saved = await call<Saved>("POST", "entries", { ...input, files: await this.#encode(files) });
    await this.refresh();
    return saved;
  }

  async updateEntry(id: string, changes: EntryChanges, files: File[]): Promise<Saved> {
    const saved = await call<Saved>("PATCH", `entries/${encodeURIComponent(id)}`, { ...changes, files: await this.#encode(files) });
    await this.refresh();
    return saved;
  }

  async deleteEntry(id: string): Promise<void> {
    await call("DELETE", `entries/${encodeURIComponent(id)}`);
    await this.refresh();
  }

  async history(id: string): Promise<HistoryItem[]> {
    return (await call<{ history: HistoryItem[] }>("GET", `entries/${encodeURIComponent(id)}/history`)).history;
  }

  attachmentUrl(a: Attachment): string {
    return `attachments/${a.path.split("/").map(encodeURIComponent).join("/")}`;
  }

  async sync(): Promise<SyncResult> {
    const result = await call<SyncResult>("POST", "sync", {});
    await this.refresh();
    return result;
  }

  syncProgress(): Promise<SyncProgress> {
    return call<SyncProgress>("GET", "sync");
  }

  async restoreVersion(id: string, commit: string): Promise<LoadedEntry> {
    const { entry } = await call<{ entry: LoadedEntry }>("POST", `entries/${encodeURIComponent(id)}/restore`, { commit });
    await this.refresh();
    return entry;
  }

  async rename(name: string): Promise<{ name: string; key: string }> {
    const result = await call<{ name: string; key: string }>("PATCH", "roll", { name });
    await this.refresh();
    return result;
  }

  async backup(destination: string): Promise<{ created: boolean; url: string; sync: SyncResult }> {
    const result = await call<{ created: boolean; url: string; sync: SyncResult }>("POST", "backup", { destination });
    await this.refresh();
    return result;
  }

  periods(): Promise<{ periods: PeriodRow[]; settings: StorageSettings; recordedZone: string | null }> {
    return call<{ periods: PeriodRow[]; settings: StorageSettings; recordedZone: string | null }>("GET", "periods");
  }

  async setTimezone(zone: string): Promise<StorageSettings> {
    const { settings } = await call<{ settings: StorageSettings }>("PATCH", "storage", { timezone: zone });
    await this.refresh();
    return settings;
  }

  async archivePeriod(period: string, compress: boolean): Promise<PeriodRow[]> {
    const { periods } = await call<{ periods: PeriodRow[] }>("POST", `periods/${encodeURIComponent(period)}/archive`, { compress });
    await this.refresh();
    return periods;
  }

  async unarchivePeriod(period: string): Promise<PeriodRow[]> {
    const { periods } = await call<{ periods: PeriodRow[] }>("POST", `periods/${encodeURIComponent(period)}/unarchive`, {});
    await this.refresh();
    return periods;
  }

  async removed(): Promise<RemovedEntry[]> {
    return (await call<{ removed: RemovedEntry[] }>("GET", "removed")).removed;
  }

  async restoreRemoved(id: string): Promise<LoadedEntry> {
    const { entry } = await call<{ entry: LoadedEntry }>("POST", `removed/${encodeURIComponent(id)}/restore`, {});
    await this.refresh();
    return entry;
  }

  async conflicts(): Promise<ConflictPair[]> {
    return (await call<{ conflicts: ConflictPair[] }>("GET", "conflicts")).conflicts;
  }

  async resolveConflict(id: string, choice: { keep: "mine" | "theirs" } | { text: string }): Promise<LoadedEntry> {
    const { entry } = await call<{ entry: LoadedEntry }>("POST", `entries/${encodeURIComponent(id)}/resolve`, choice);
    await this.refresh();
    return entry;
  }
}
