// Two devices changed the same vault before syncing.
//
// Objects never conflict: they are named by their contents and never change.
// Only state.json does, and Git can't merge it: it is signed. So when a sync
// meets that conflict (repo.ts), it takes the other device's state.json, and
// keeps this device's version and the common ancestor aside, outside the
// working tree, in .git/gitroll-vault/<name>.merge.json. Nothing there is
// secret: both are the signed public states.
//
// The next time the vault is unlocked, those are merged, item by item, and
// signed by this device:
//
//   - changed on one side only: that side's version;
//   - changed the same way on both: either;
//   - changed differently on both: the other device's version stays, and this
//     device's is kept beside it as a new item titled "… (conflict)", for the
//     person to settle — never silently dropped;
//   - edited on one side and removed on the other: the edit is kept.
//
// The trust chain isn't merged: if both devices changed the members at the
// same time, the merge stops and says so.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { X25519Identity } from "../../core/age/format.ts";
import { VaultError, checkFresh, newId, nowIso, objectFile, openKeyBundle, openState, signSnapshot, recordHash } from "../../core/vault/format.ts";
import type { ItemRef, VerifiedState } from "../../core/vault/format.ts";
import { encodeItem, openItem, sealItem } from "../../core/vault/items.ts";
import type { VaultItem } from "../../core/vault/items.ts";
import type { VaultWrite } from "../../core/vault/ops.ts";
import type { GitRoll } from "../repo.ts";
import { nodeVaultCrypto as crypto } from "./crypto.ts";
import type { UnlockedDevice } from "./device.ts";

interface Pending {
  v: 1;
  base: string;
  mine: string;
}

/** Where a pending merge is kept: inside .git, so it is never committed or synced. */
function pendingFile(root: string, name: string): string | null {
  try {
    // .git is a folder, or a file pointing at one (a worktree).
    const dotGit = path.join(root, ".git");
    const stat = fs.lstatSync(dotGit);
    let dir = dotGit;
    if (stat.isFile()) {
      const m = /^gitdir: (.+)$/m.exec(fs.readFileSync(dotGit, "utf8"));
      if (!m) return null;
      dir = path.resolve(root, m[1].trim());
    } else if (!stat.isDirectory()) return null;
    return path.join(dir, "gitroll-vault", `${name}.merge.json`);
  } catch {
    return null;
  }
}

/** Bytes of a file as some commit holds it, or null. */
function fromHistory(root: string, rel: string): Uint8Array | null {
  const git = (args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  try {
    const commit = git(["log", "--all", "-1", "--format=%H", "--", rel]).toString().trim();
    if (!commit) return null;
    for (const spec of [`${commit}:${rel}`, `${commit}^:${rel}`]) {
      try {
        return new Uint8Array(git(["show", spec]));
      } catch {
        // not in that commit
      }
    }
  } catch {
    // no history
  }
  return null;
}

/** Called by sync when state.json conflicts: keep the ancestor and this device's state aside. False when it can't. */
export function savePendingMerge(root: string, name: string, base: string, mine: string): boolean {
  const file = pendingFile(root, name);
  if (!file) return false;
  if (fs.existsSync(file)) {
    // An earlier merge hasn't happened yet. Keep its ancestor; this device's newest state supersedes its older one.
    const old = JSON.parse(fs.readFileSync(file, "utf8")) as Pending;
    fs.writeFileSync(file, JSON.stringify({ v: 1, base: old.base, mine } satisfies Pending), { mode: 0o600 });
    return true;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ v: 1, base, mine } satisfies Pending), { mode: 0o600 });
  return true;
}

export function pendingMerge(root: string, name: string): Pending | null {
  const file = pendingFile(root, name);
  if (!file || !fs.existsSync(file)) return null;
  const p = JSON.parse(fs.readFileSync(file, "utf8")) as Pending;
  return p.v === 1 && typeof p.base === "string" && typeof p.mine === "string" ? p : null;
}

export function clearPendingMerge(root: string, name: string): void {
  const file = pendingFile(root, name);
  if (file) fs.rmSync(file, { force: true });
}

const isPrefix = (a: string[], b: string[]) => a.length <= b.length && a.every((h, i) => b[i] === h);

/**
 * The merged state. `read` finds an object in the working tree or, for one a
 * later commit removed (an old key bundle after a rotation), in Git history.
 */
export async function mergeVault(roll: GitRoll, dir: string, expectVault: string, pending: Pending, theirsBytes: Uint8Array, device: UnlockedDevice): Promise<{ write: VaultWrite; conflicts: number }> {
  const enc = new TextEncoder();
  const base = await openState(enc.encode(pending.base), crypto, { expectVault });
  const mine = await openState(enc.encode(pending.mine), crypto, { expectVault, pin: base.pin });
  const theirs = await openState(theirsBytes, crypto, { expectVault, pin: base.pin });
  const read = (hash: string): Uint8Array | null => {
    const rel = `${dir}/${objectFile(hash)}`;
    const abs = path.join(roll.root, rel);
    return fs.existsSync(abs) ? new Uint8Array(fs.readFileSync(abs)) : fromHistory(roll.root, rel);
  };
  let final: VerifiedState;
  if (isPrefix(mine.chain.hashes, theirs.chain.hashes)) final = theirs;
  else if (isPrefix(theirs.chain.hashes, mine.chain.hashes)) final = mine;
  else throw new VaultError("VAULT_INVALID", "Both devices changed who belongs to this vault at the same time, so the changes can't be merged. Nothing was changed. Undo the device change on one of them and sync again.");
  const me = final.chain.head.members.find((m) => m.id === device.member.id);
  if (!me) throw new VaultError("VAULT_FORBIDDEN", "This device was removed from the vault on another device.");
  const keys = new Map<number, X25519Identity>();
  const keyOf = async (s: VerifiedState) => {
    if (!keys.has(s.chain.head.epoch)) keys.set(s.chain.head.epoch, await openKeyBundle(s, read(s.snapshot.keys), device.age, crypto));
    return keys.get(s.chain.head.epoch)!;
  };
  const open = async (s: VerifiedState, ref: ItemRef | undefined) => (ref ? openItem(s, ref, read(ref.object), await keyOf(s), crypto) : null);
  const text = (vaultId: string, i: VaultItem | null) => (i ? encodeItem(vaultId, i) : null);
  const byId = (s: VerifiedState) => new Map(s.snapshot.items.map((r) => [r.id, r]));
  const [b, m, t] = [byId(base), byId(mine), byId(theirs)];
  const out: { item: VaultItem; from: VerifiedState; ref: ItemRef }[] = [];
  let conflicts = 0;
  for (const id of new Set([...b.keys(), ...m.keys(), ...t.keys()])) {
    const [ib, im, it] = [await open(base, b.get(id)), await open(mine, m.get(id)), await open(theirs, t.get(id))];
    const [xb, xm, xt] = [text(base.vaultId, ib), text(base.vaultId, im), text(base.vaultId, it)];
    if (xm === xt || xm === xb) {
      if (it) out.push({ item: it, from: theirs, ref: t.get(id)! });
    } else if (xt === xb || !it) {
      if (im) out.push({ item: im, from: mine, ref: m.get(id)! });
    } else if (!im) {
      out.push({ item: it, from: theirs, ref: t.get(id)! });
    } else {
      conflicts++;
      out.push({ item: it, from: theirs, ref: t.get(id)! });
      const now = nowIso();
      const copy: VaultItem = { ...im, id: await newId(crypto), rev: 1, title: `${im.title} (conflict)`.slice(0, 1024), created: now, updated: now, ext: { ...im.ext, conflict_of: im.id } };
      out.push({ item: copy, from: mine, ref: { id: copy.id, rev: 1, object: "" } });
    }
  }
  const objects = new Map<string, Uint8Array>();
  const refs: ItemRef[] = [];
  for (const o of out) {
    if (o.ref.object && o.from.chain.head.epoch === final.chain.head.epoch && read(o.ref.object)) {
      refs.push(o.ref);
      const bytes = read(o.ref.object)!;
      if (!fs.existsSync(path.join(roll.root, dir, objectFile(o.ref.object)))) objects.set(o.ref.object, bytes);
    } else {
      const sealed = await sealItem(final.vaultId, o.item, final.chain.head.recipient, crypto);
      objects.set(sealed.hash, sealed.bytes);
      refs.push(sealed.ref);
    }
  }
  const bundle = read(final.snapshot.keys);
  if (bundle && !fs.existsSync(path.join(roll.root, dir, objectFile(final.snapshot.keys)))) objects.set(final.snapshot.keys, bundle);
  const theirsHash = await recordHash(theirs.snapshot, crypto);
  const snapshot = await signSnapshot(
    {
      v: 1,
      type: "snapshot",
      vault: final.vaultId,
      seq: Math.max(mine.snapshot.seq, theirs.snapshot.seq) + 1,
      parent: theirsHash,
      trust: final.chain.headHash,
      epoch: final.chain.head.epoch,
      keys: final.snapshot.keys,
      items: refs.sort((x, y) => (x.id < y.id ? -1 : 1)),
      created: nowIso(),
      signer: device.member.id,
    },
    device.seed,
    crypto,
  );
  const merged = { gitroll_vault: 1 as const, vault: final.vaultId, trust: final.chain.records, snapshot };
  // The result must pass the same checks any reader applies, and be newer than both sides.
  const check = await openState(enc.encode(JSON.stringify(merged)), crypto, { expectVault });
  checkFresh(check, mine.pin);
  checkFresh(check, theirs.pin);
  return { write: { state: merged, objects, unreferenced: [], vaultKey: await keyOf(final) }, conflicts };
}
