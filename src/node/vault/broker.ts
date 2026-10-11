// The vault broker: one background process per user that holds unlocked vault
// keys in memory, so that each `gitroll vault …` command doesn't need the
// passphrase, and no command ever holds a key itself.
//
// It listens on a Unix socket or named pipe (runtime.ts), takes one
// newline-terminated JSON request per connection, and answers one JSON line.
// Every request carries the session token. Requests are size-limited and
// rate-limited, a wrong passphrase costs an increasing delay, and each vault
// locks itself after its idle timeout, or at once when the computer seems to
// have slept. With nothing unlocked, the broker exits.
//
// Clients get values only when they ask for them by name (reveal, run), never
// a key. Anything else running as this user can do the same: see SECURITY.md.

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import { ConflictError, NotFoundError, UserError } from "../../core/util.ts";
import { LIMITS, VaultError, newId, nowIso } from "../../core/vault/format.ts";
import type { Member } from "../../core/vault/format.ts";
import { checkItem, findItem, redactItem, searchItems } from "../../core/vault/items.ts";
import type { VaultField, VaultItem } from "../../core/vault/items.ts";
import { changeMembers, writeItems } from "../../core/vault/ops.ts";
import { nodeVaultCrypto } from "./crypto.ts";
import { unlockDevice } from "./device.ts";
import { localVault } from "./local.ts";
import { checkpointFor } from "./enroll.ts";
import { ensureRuntimeDir, socketPath, tokenFile } from "./runtime.ts";
import { VaultSession } from "./store.ts";

export const PROTOCOL_VERSION = 1;
export const MAX_MESSAGE = 1024 * 1024;
export const DEFAULT_TIMEOUT_S = 15 * 60;
export const MAX_TIMEOUT_S = 12 * 60 * 60;
const RATE = { window: 10_000, max: 300 };
const TICK_MS = 5_000;
/** A tick this late means the computer was asleep (or the process stopped): lock. */
const SLEEP_GAP_MS = 60_000;

export interface Request {
  v: number;
  token: string;
  op: string;
  vault?: string;
  [key: string]: unknown;
}

type Field = { name: string; value: string; secret: boolean };

interface Open {
  session: VaultSession;
  timeoutMs: number;
  expires: number;
  queue: Promise<unknown>;
}

const str = (v: unknown, what: string, max = 4096): string => {
  if (typeof v !== "string" || v.length > max) throw new VaultError("VAULT_INVALID", `${what} is missing or too long.`);
  return v;
};
const int = (v: unknown, what: string): number => {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) throw new VaultError("VAULT_INVALID", `${what} must be a positive whole number.`);
  return v;
};
function fields(v: unknown): Field[] {
  if (!Array.isArray(v)) throw new VaultError("VAULT_INVALID", "fields must be a list.");
  return v.map((f) => {
    if (!f || typeof f !== "object") throw new VaultError("VAULT_INVALID", "A field is malformed.");
    const o = f as Record<string, unknown>;
    return { name: str(o.name, "A field name", 64), value: str(o.value, "A field value", 65536), secret: o.secret === true };
  });
}

/** What a client sees of an error: the code and a message with no secret in it. */
export function errorReply(e: unknown): { code: string; message: string } {
  if (e instanceof VaultError) return { code: e.code, message: e.message };
  if (e instanceof NotFoundError) return { code: "NOT_FOUND", message: e.message };
  if (e instanceof ConflictError) return { code: "CONFLICT", message: e.message };
  if (e instanceof UserError) return { code: "USER_ERROR", message: e.message };
  return { code: "INTERNAL_ERROR", message: "The vault broker hit an unexpected error. Nothing was revealed; try again." };
}

export class Broker {
  readonly token = crypto.randomBytes(32).toString("base64url");
  #open = new Map<string, Open>();
  #failures = { count: 0, until: 0 };
  #recent: number[] = [];
  #lastTick = Date.now();
  #timer: NodeJS.Timeout | null = null;
  #server: net.Server | null = null;
  #busy = 0;
  #hadVault = false;
  onEmpty: () => void = () => {};

  start(): void {
    this.#timer = setInterval(() => this.#tick(), TICK_MS);
    this.#timer.unref();
  }

  #tick(): void {
    const now = Date.now();
    const slept = now - this.#lastTick > SLEEP_GAP_MS;
    this.#lastTick = now;
    for (const [id, o] of this.#open) if (slept || o.expires <= now) this.#open.delete(id);
    if (!this.#open.size && this.#hadVault && !this.#busy) this.onEmpty();
  }

  #rateLimit(): void {
    const now = Date.now();
    this.#recent = this.#recent.filter((t) => now - t < RATE.window);
    if (this.#recent.length >= RATE.max) throw new VaultError("VAULT_INVALID", "Too many requests. Wait a few seconds.");
    this.#recent.push(now);
  }

  #get(vault: unknown): Open {
    const o = this.#open.get(str(vault, "vault", 64));
    if (!o || o.expires <= Date.now()) {
      if (o) this.#open.delete(String(vault));
      throw new VaultError("VAULT_LOCKED", "That vault is locked. Unlock it with: gitroll vault unlock <name>");
    }
    o.expires = Date.now() + o.timeoutMs;
    return o;
  }

  /** Runs one request. Requests for the same vault run one at a time. */
  async handle(req: Request): Promise<unknown> {
    this.#rateLimit();
    if (req.v !== PROTOCOL_VERSION) throw new VaultError("VAULT_UNSUPPORTED", "This vault broker speaks another protocol version. Lock all vaults (gitroll vault lock) and unlock again.");
    const given = Buffer.from(typeof req.token === "string" ? req.token : "");
    const want = Buffer.from(this.token);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) throw new VaultError("VAULT_FORBIDDEN", "This request didn't carry the broker's session token.");
    switch (req.op) {
      case "ping":
        return { pid: process.pid, vaults: [...this.#open].map(([id, o]) => ({ vault: id, name: o.session.entry.name, expiresAt: new Date(o.expires).toISOString() })) };
      case "unlock":
        return this.#unlock(req);
      case "lock": {
        const ids = req.vault === undefined ? [...this.#open.keys()] : [str(req.vault, "vault", 64)].filter((id) => this.#open.has(id));
        for (const id of ids) this.#open.delete(id);
        if (!this.#open.size) setImmediate(() => this.onEmpty());
        return { locked: ids };
      }
    }
    const open = this.#get(req.vault);
    const run = open.queue.then(() => this.#op(open.session, req));
    open.queue = run.catch(() => undefined);
    return run;
  }

  async #unlock(req: Request): Promise<unknown> {
    const now = Date.now();
    if (now < this.#failures.until) throw new VaultError("VAULT_LOCKED", `Too many wrong passphrases. Try again in ${Math.ceil((this.#failures.until - now) / 1000)} s.`);
    const vault = str(req.vault, "vault", 64);
    const entry = localVault(vault);
    const timeout = req.timeout === undefined ? DEFAULT_TIMEOUT_S : int(req.timeout, "timeout");
    if (timeout > MAX_TIMEOUT_S) throw new VaultError("VAULT_INVALID", "A vault stays unlocked for at most 12 hours.");
    let session: VaultSession;
    try {
      const device = await unlockDevice(req.passphrase === undefined || req.passphrase === null ? null : str(req.passphrase, "passphrase", 1024));
      session = await VaultSession.open(entry, device);
    } catch (e) {
      if (e instanceof VaultError && e.code === "VAULT_LOCKED") {
        this.#failures.count++;
        this.#failures.until = Date.now() + Math.min(30_000, 1000 * 2 ** (this.#failures.count - 1));
      }
      throw e;
    }
    this.#failures = { count: 0, until: 0 };
    const timeoutMs = timeout * 1000;
    this.#open.set(vault, { session, timeoutMs, expires: Date.now() + timeoutMs, queue: Promise.resolve() });
    this.#hadVault = true;
    return { vault, name: entry.name, expiresAt: new Date(Date.now() + timeoutMs).toISOString(), recoveryChecked: localVault(vault).recoveryChecked };
  }

  async #op(session: VaultSession, req: Request): Promise<unknown> {
    const message = `vault: update ${session.entry.name}`;
    switch (req.op) {
      case "list": {
        const { state, vaultKey } = await session.current();
        const items = searchItems(await session.items(state, vaultKey), typeof req.query === "string" ? req.query : "");
        return { items: items.sort((a, b) => a.title.localeCompare(b.title)).map(redactItem) };
      }
      case "get": {
        const { state, vaultKey } = await session.current();
        const item = findItem(await session.items(state, vaultKey), str(req.item, "item"));
        const reveal = Array.isArray(req.reveal) ? req.reveal.map((f) => str(f, "field", 64)) : [];
        for (const name of reveal) if (!item.fields.some((f) => f.name === name)) throw new VaultError("VAULT_INVALID", `That item has no field called ${name}.`);
        const shown = redactItem(item);
        return { item: { ...shown, fields: item.fields.map((f, i) => (reveal.includes(f.name) ? { name: f.name, secret: f.secret, value: f.value } : shown.fields[i])), notes: req.notes === true ? item.notes : shown.notes } };
      }
      case "resolve": {
        const { state, vaultKey } = await session.current();
        const items = await session.items(state, vaultKey);
        if (!Array.isArray(req.refs) || !req.refs.length || req.refs.length > 100) throw new VaultError("VAULT_INVALID", "Ask for 1–100 values.");
        return {
          values: req.refs.map((r) => {
            const ref = r as Record<string, unknown>;
            const item = findItem(items, str(ref.item, "item"));
            const name = ref.field === undefined || ref.field === null ? defaultField(item) : str(ref.field, "field", 64);
            const field = item.fields.find((f) => f.name === name);
            if (!field) throw new VaultError("VAULT_INVALID", `“${item.title}” has no field called ${name}.`);
            return field.value;
          }),
        };
      }
      case "add": {
        const input = (req.item ?? {}) as Record<string, unknown>;
        const now = nowIso();
        const item: VaultItem = { id: await newId(nodeVaultCrypto), rev: 1, kind: str(input.kind ?? "login", "kind", 32), title: str(input.title, "title"), fields: fields(input.fields ?? []), notes: input.notes === undefined ? "" : str(input.notes, "notes", 1024 * 1024), created: now, updated: now, ext: {} };
        checkItem(item);
        const { commit } = await session.change((state, key) => writeItems(state, key, { put: [item] }, session.signer, nodeVaultCrypto), message);
        return { item: redactItem(item), commit };
      }
      case "edit": {
        const rev = int(req.rev, "rev");
        let saved: VaultItem | null = null;
        const { commit } = await session.change(async (state, key, items) => {
          const cur = findItem(items, str(req.item, "item"));
          if (cur.rev !== rev) throw new ConflictError(`“${cur.title}” is at revision ${cur.rev}, not ${rev}: it changed since you read it. Look again (gitroll vault show) and retry with --rev ${cur.rev}.`);
          const patch = (req.patch ?? {}) as Record<string, unknown>;
          const next: VaultItem = { ...cur, rev: cur.rev + 1, updated: nowIso(), fields: [...cur.fields] };
          if (patch.title !== undefined) next.title = str(patch.title, "title");
          if (patch.kind !== undefined) next.kind = str(patch.kind, "kind", 32);
          if (patch.notes !== undefined) next.notes = str(patch.notes, "notes", 1024 * 1024);
          for (const f of fields(patch.set ?? [])) {
            const at = next.fields.findIndex((x) => x.name === f.name);
            if (at >= 0) next.fields[at] = { ...f, secret: f.secret || next.fields[at].secret };
            else next.fields.push(f);
          }
          for (const name of Array.isArray(patch.unset) ? patch.unset : []) {
            const at = next.fields.findIndex((x) => x.name === name);
            if (at < 0) throw new VaultError("VAULT_INVALID", `There's no field called ${String(name).slice(0, 64)} to remove.`);
            next.fields.splice(at, 1);
          }
          checkItem(next);
          saved = next;
          return writeItems(state, key, { put: [next] }, session.signer, nodeVaultCrypto);
        }, message);
        return { item: redactItem(saved!), commit };
      }
      case "remove": {
        const rev = int(req.rev, "rev");
        let gone: VaultItem | null = null;
        const { commit } = await session.change(async (state, key, items) => {
          const cur = findItem(items, str(req.item, "item"));
          if (cur.rev !== rev) throw new ConflictError(`“${cur.title}” is at revision ${cur.rev}, not ${rev}: it changed since you read it.`);
          gone = cur;
          return writeItems(state, key, { remove: [cur.id] }, session.signer, nodeVaultCrypto);
        }, message);
        return { removed: { id: gone!.id, title: gone!.title }, commit };
      }
      case "import": {
        // Many items at once, from an importer's drafts (core/vault/interop.ts), in one commit.
        if (!Array.isArray(req.items) || !req.items.length || req.items.length > 5000) throw new VaultError("VAULT_INVALID", "Import 1–5000 items at a time.");
        const now = nowIso();
        const created: VaultItem[] = [];
        for (const raw of req.items) {
          const input = (raw ?? {}) as Record<string, unknown>;
          const ext = input.ext === undefined ? {} : input.ext;
          if (!ext || typeof ext !== "object" || Array.isArray(ext)) throw new VaultError("VAULT_INVALID", "An imported item's extra data must be a mapping.");
          const time = (t: unknown) => (typeof t === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(t) ? t : now);
          const item: VaultItem = { id: await newId(nodeVaultCrypto), rev: 1, kind: str(input.kind ?? "login", "kind", 32), title: str(input.title, "title"), fields: fields(input.fields ?? []), notes: input.notes === undefined ? "" : str(input.notes, "notes", 1024 * 1024), created: time(input.created), updated: time(input.updated ?? input.created), ext: ext as Record<string, unknown> };
          checkItem(item);
          created.push(item);
        }
        const { commit } = await session.change((state, key) => {
          if (state.snapshot.items.length + created.length > LIMITS.items) throw new VaultError("VAULT_INVALID", `A vault holds at most ${LIMITS.items} items.`);
          return writeItems(state, key, { put: created }, session.signer, nodeVaultCrypto);
        }, `vault: import ${created.length} item${created.length === 1 ? "" : "s"} into ${session.entry.name}`);
        return { imported: created.length, commit };
      }
      case "export": {
        // Every item in full, for `gitroll vault export`, which asked first.
        const { state, vaultKey } = await session.current();
        const items = await session.items(state, vaultKey);
        if (req.item !== undefined) return { items: [findItem(items, str(req.item, "item"))], next: null };
        // A page at a time, so a large vault fits the reply limit.
        const from = req.from === undefined || req.from === 0 ? 0 : int(req.from, "from");
        const page: VaultItem[] = [];
        let size = 0;
        for (let i = from; i < items.length; i++) {
          size += JSON.stringify(items[i]).length;
          if (page.length && size > MAX_MESSAGE * 2) return { items: page, next: i };
          page.push(items[i]);
        }
        return { items: page, next: null };
      }
      case "members": {
        const { state } = await session.current();
        return { epoch: state.chain.head.epoch, members: state.chain.head.members.map((m) => ({ id: m.id, role: m.role, thisDevice: m.id === session.device.member.id })) };
      }
      case "add-member": {
        const member = req.member as Member;
        if (!member || typeof member !== "object" || member.role !== "device") throw new VaultError("VAULT_INVALID", "That isn't a device enrollment request.");
        const { commit } = await session.change((state, key, items) => changeMembers(state, key, items, { add: [{ id: str(member.id, "id", 26), role: "device", age: str(member.age, "age", 100), sign: str(member.sign, "sign", 60) }] }, session.signer, nodeVaultCrypto), `vault: add a device to ${session.entry.name}`);
        const { state } = await session.current();
        return { checkpoint: checkpointFor(session.entry.name, state), commit };
      }
      case "remove-member":
      case "rotate": {
        const remove = req.op === "rotate" ? [] : [str(req.member, "member", 26)];
        const { commit } = await session.change((state, key, items) => changeMembers(state, key, items, { remove, rotate: true }, session.signer, nodeVaultCrypto), `vault: ${req.op === "rotate" ? "rotate the key of" : "remove a device from"} ${session.entry.name}`);
        const { state } = await session.current();
        return { epoch: state.chain.head.epoch, members: state.chain.head.members.length, commit };
      }
    }
    throw new VaultError("VAULT_INVALID", `Unknown request: ${String(req.op).slice(0, 40)}`);
  }

  async serve(): Promise<void> {
    ensureRuntimeDir();
    const file = socketPath();
    if (process.platform !== "win32") {
      // A socket left by a broker that died. Anything else at that path is not ours to remove.
      try {
        if (fs.lstatSync(file).isSocket()) fs.rmSync(file);
      } catch {
        // nothing there
      }
    }
    const server = net.createServer({ allowHalfOpen: false }, (socket) => this.#connection(socket));
    server.maxConnections = 32;
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      const old = process.umask(0o177);
      server.listen(file, () => {
        process.umask(old);
        resolve();
      });
    });
    const tmp = `${tokenFile()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, this.token, { mode: 0o600 });
    fs.renameSync(tmp, tokenFile());
    this.start();
    this.onEmpty = () => this.stop();
  }

  #connection(socket: net.Socket): void {
    let data = "";
    socket.setEncoding("utf8");
    socket.setTimeout(30_000, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk: string) => {
      data += chunk;
      if (data.length > MAX_MESSAGE) {
        socket.end(`${JSON.stringify({ ok: false, error: { code: "VAULT_INVALID", message: "The request is too large." } })}\n`);
        socket.destroy();
        return;
      }
      const nl = data.indexOf("\n");
      if (nl < 0) return;
      socket.removeAllListeners("data");
      let req: Request;
      try {
        req = JSON.parse(data.slice(0, nl)) as Request;
      } catch {
        socket.end(`${JSON.stringify({ ok: false, error: { code: "VAULT_INVALID", message: "The request isn't JSON." } })}\n`);
        return;
      }
      this.#busy++;
      this.handle(req).finally(() => this.#busy--).then(
        (result) => socket.end(`${JSON.stringify({ ok: true, result })}\n`),
        (e) => socket.end(`${JSON.stringify({ ok: false, error: errorReply(e) })}\n`),
      );
    });
  }

  stop(): void {
    this.#open.clear();
    if (this.#timer) clearInterval(this.#timer);
    try {
      if (fs.readFileSync(tokenFile(), "utf8") === this.token) fs.rmSync(tokenFile(), { force: true });
    } catch {
      // already gone
    }
    this.#server?.close();
    if (process.platform !== "win32") fs.rmSync(socketPath(), { force: true });
    // Give the last reply a moment to flush, then go.
    setTimeout(() => process.exit(0), 100).unref();
  }
}

/** The field `run` and `reveal` use when none is named: the item's first secret one. */
export function defaultField(item: VaultItem): string {
  const f: VaultField | undefined = item.fields.find((x) => x.secret) ?? item.fields[0];
  if (!f) throw new VaultError("VAULT_INVALID", `“${item.title}” has no fields.`);
  return f.name;
}

/** `gitroll vault __broker`: the background process itself. */
export async function runBroker(): Promise<void> {
  const broker = new Broker();
  await broker.serve();
  // Nothing unlocked within a minute of starting (a failed unlock): go.
  setTimeout(() => {
    void broker.handle({ v: PROTOCOL_VERSION, token: broker.token, op: "ping" }).then((r) => {
      if (!(r as { vaults: unknown[] }).vaults.length) broker.stop();
    });
  }, 60_000).unref();
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => broker.stop());
  await new Promise(() => {}); // keep running until stop() exits
}
