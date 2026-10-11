// Where a vault meets the disk and Git. Everything written is already
// ciphertext or signed public data: items are encrypted in memory (core/vault)
// before a single byte reaches the working tree.
//
// A write adds new objects (each written to a temporary name and renamed, never
// over an existing file), then replaces state.json atomically after checking it
// is still the state the change was made from, then removes objects the new
// state doesn't refer to, then commits the vault's folder and nothing else.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { X25519Identity } from "../../core/age/format.ts";
import { OBJECT_FILE, STATE_FILE, VaultError, LIMITS, objectFile, openKeyBundle, openState, referencedObjects, vaultDir } from "../../core/vault/format.ts";
import type { VerifiedState } from "../../core/vault/format.ts";
import { openItem } from "../../core/vault/items.ts";
import type { VaultItem } from "../../core/vault/items.ts";
import type { VaultWrite } from "../../core/vault/ops.ts";
import { NotFoundError, UserError } from "../../core/util.ts";
import { insideRoll, walkFiles } from "../fs-safe.ts";
import { GitRoll } from "../repo.ts";
import { nodeVaultCrypto } from "./crypto.ts";
import type { UnlockedDevice } from "./device.ts";
import { advancePin, localVault } from "./local.ts";
import { clearPendingMerge, mergeVault, pendingMerge } from "./merge.ts";
import type { LocalVault } from "./local.ts";

const sha = (b: Uint8Array) => crypto.createHash("sha256").update(b).digest("hex");

export class VaultFiles {
  readonly roll: GitRoll;
  readonly name: string;
  readonly dir: string;
  constructor(roll: GitRoll, name: string) {
    this.roll = roll;
    this.name = name;
    this.dir = vaultDir(name);
  }

  #abs(rel: string): string {
    return insideRoll(this.roll.root, `${this.dir}/${rel}`);
  }

  exists(): boolean {
    return fs.existsSync(this.#abs(STATE_FILE));
  }

  readState(): Uint8Array {
    const file = this.#abs(STATE_FILE);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(file);
    } catch {
      throw new NotFoundError(`There's no vault called ${this.name} in this Roll (${this.dir}/${STATE_FILE} is missing).`);
    }
    if (!stat.isFile()) throw new VaultError("VAULT_TAMPERED", `${this.dir}/${STATE_FILE} isn't a plain file.`);
    if (stat.size > LIMITS.stateBytes) throw new VaultError("VAULT_TAMPERED", `${this.dir}/${STATE_FILE} is too large.`);
    return new Uint8Array(fs.readFileSync(file));
  }

  readObject(hash: string): Uint8Array | null {
    const file = this.#abs(objectFile(hash));
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(file);
    } catch {
      return null;
    }
    if (!stat.isFile()) throw new VaultError("VAULT_TAMPERED", `${this.dir}/${objectFile(hash)} isn't a plain file.`);
    if (stat.size > LIMITS.objectBytes) throw new VaultError("VAULT_TAMPERED", `${this.dir}/${objectFile(hash)} is too large.`);
    return new Uint8Array(fs.readFileSync(file));
  }

  /** Every file in the vault's folder, as paths inside it. A symbolic link is refused. */
  files(): string[] {
    const { files, links } = walkFiles(this.roll.root, this.dir);
    if (links.length) throw new VaultError("VAULT_TAMPERED", `The vault contains a symbolic link (${links[0]}). GitRoll doesn't follow links.`);
    return files.map((f) => f.slice(this.dir.length + 1));
  }

  /** Writes a change, if state.json is still `expected` (the bytes the change was made from, or null for a new vault). */
  apply(write: VaultWrite, expected: Uint8Array | null, message: string): string | null {
    const current = this.exists() ? this.readState() : null;
    if ((current === null) !== (expected === null) || (current && expected && sha(current) !== sha(expected))) {
      throw new VaultError("VAULT_INVALID", "The vault changed while this was being saved (a sync, or another command). Nothing was written; try again.");
    }
    fs.mkdirSync(this.#abs("objects"), { recursive: true });
    for (const [hash, bytes] of write.objects) {
      const target = this.#abs(objectFile(hash));
      if (fs.existsSync(target)) {
        if (sha(fs.readFileSync(target)) === hash) continue;
        fs.rmSync(target); // a damaged leftover; its name promises other bytes
      }
      this.#atomicWrite(target, bytes);
    }
    this.#atomicWrite(this.#abs(STATE_FILE), `${JSON.stringify(write.state, null, 2)}\n`);
    const keep = new Set(referencedObjects(write.state.snapshot));
    for (const rel of this.files()) {
      const m = OBJECT_FILE.exec(rel);
      if ((m && !keep.has(m[1])) || rel.startsWith("objects/.tmp-")) fs.rmSync(this.#abs(rel), { force: true });
    }
    return this.roll.commitFiles([this.dir], message);
  }

  #atomicWrite(target: string, data: string | Uint8Array): void {
    const tmp = path.join(path.dirname(target), `.tmp-${crypto.randomBytes(8).toString("hex")}`);
    const fd = fs.openSync(tmp, "wx", 0o644);
    try {
      fs.writeSync(fd, typeof data === "string" ? Buffer.from(data) : data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, target);
  }
}

export const vaultFiles = (entry: Pick<LocalVault, "roll" | "name">): VaultFiles => new VaultFiles(new GitRoll(entry.roll), entry.name);

/** Reads and authenticates a vault's state against this device's pin. */
export async function verifiedState(files: VaultFiles, entry: LocalVault | null): Promise<{ state: VerifiedState; bytes: Uint8Array }> {
  const bytes = files.readState();
  const state = await openState(bytes, nodeVaultCrypto, entry ? { expectVault: entry.id, pin: localVault(entry.id).pin } : {});
  return { state, bytes };
}

/**
 * An unlocked vault: this device's keys and the vault key, used to read and
 * change it. Every operation re-reads state.json and authenticates it again,
 * so a sync that happened since unlocking is seen, and a tampered or rolled
 * back vault is refused at the moment it matters.
 */
export class VaultSession {
  readonly entry: LocalVault;
  readonly device: UnlockedDevice;
  #vaultKey: X25519Identity;
  #epoch: number;
  /** Items kept twice by the last merge, because two devices changed them differently. */
  lastMergeConflicts = 0;

  private constructor(entry: LocalVault, device: UnlockedDevice, vaultKey: X25519Identity, epoch: number) {
    this.entry = entry;
    this.device = device;
    this.#vaultKey = vaultKey;
    this.#epoch = epoch;
  }

  static async open(entry: LocalVault, device: UnlockedDevice): Promise<VaultSession> {
    const files = vaultFiles(entry);
    const { state } = await verifiedState(files, entry);
    const key = await keyFor(state, files, device, entry);
    advancePin(entry.id, state.pin);
    return new VaultSession(entry, device, key, state.chain.head.epoch);
  }

  get files(): VaultFiles {
    return vaultFiles(this.entry);
  }

  /** The current state, authenticated, with the vault key for its epoch. */
  async current(): Promise<{ state: VerifiedState; bytes: Uint8Array; vaultKey: X25519Identity }> {
    const files = this.files;
    const pending = pendingMerge(files.roll.root, this.entry.name);
    if (pending) {
      const theirs = files.readState();
      const { write, conflicts } = await mergeVault(files.roll, files.dir, this.entry.id, pending, theirs, this.device);
      files.apply(write, theirs, `vault: merge ${this.entry.name} after a sync${conflicts ? ` (${conflicts} changed on two devices, both kept)` : ""}`);
      clearPendingMerge(files.roll.root, this.entry.name);
      this.lastMergeConflicts = conflicts;
    }
    const { state, bytes } = await verifiedState(files, this.entry);
    if (state.chain.head.epoch !== this.#epoch) {
      this.#vaultKey = await keyFor(state, files, this.device, this.entry);
      this.#epoch = state.chain.head.epoch;
    } else ensureMember(state, this.device, this.entry);
    advancePin(this.entry.id, state.pin);
    return { state, bytes, vaultKey: this.#vaultKey };
  }

  async items(state: VerifiedState, vaultKey: X25519Identity): Promise<VaultItem[]> {
    const files = this.files;
    const out: VaultItem[] = [];
    for (const ref of state.snapshot.items) out.push(await openItem(state, ref, files.readObject(ref.object), vaultKey, nodeVaultCrypto));
    return out;
  }

  /** Runs a change against the current state and writes it, refusing if the state moved underneath. */
  async change(make: (state: VerifiedState, vaultKey: X25519Identity, items: VaultItem[]) => Promise<VaultWrite>, message: string): Promise<{ write: VaultWrite; commit: string | null }> {
    const { state, bytes, vaultKey } = await this.current();
    const write = await make(state, vaultKey, await this.items(state, vaultKey));
    const commit = this.files.apply(write, bytes, message);
    const after = await this.current();
    this.#vaultKey = write.vaultKey;
    this.#epoch = after.state.chain.head.epoch;
    return { write, commit };
  }

  get signer() {
    return { id: this.device.member.id, seed: this.device.seed };
  }
}

function ensureMember(state: VerifiedState, device: UnlockedDevice, entry: LocalVault): void {
  const m = state.chain.head.members.find((x) => x.id === entry.member);
  if (!m || entry.member !== device.member.id || m.age !== device.member.age || m.sign !== device.member.sign) {
    throw new VaultError("VAULT_FORBIDDEN", "This device is no longer a member of the vault. Ask a device that is to add it again, or recover with the recovery kit.");
  }
}

async function keyFor(state: VerifiedState, files: VaultFiles, device: UnlockedDevice, entry: LocalVault): Promise<X25519Identity> {
  ensureMember(state, device, entry);
  return openKeyBundle(state, files.readObject(state.snapshot.keys), device.age, nodeVaultCrypto);
}

export function requireVaultName(name: string | undefined): string {
  if (!name || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(name)) throw new UserError("A vault name is 1–32 lowercase letters, digits and dashes, like personal.");
  return name;
}
