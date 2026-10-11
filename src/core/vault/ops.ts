// Changes to a vault, as pure functions from an authenticated state to the
// next one: the new state.json and the objects it needs. The caller writes the
// objects first, then state.json, then removes what nothing refers to any more
// (see format.ts). Every change is signed by a member.

import { X25519Identity } from "../age/format.ts";
import type { VaultCrypto } from "./crypto.ts";
import { VaultError, nowIso, recordHash, referencedObjects, sealKeyBundle, sha256Hex, signSnapshot, signTrust, verifyChain } from "./format.ts";
import type { ItemRef, Member, Snapshot, TrustBody, TrustRecord, VaultStateFile, VerifiedState } from "./format.ts";
import { sealItem } from "./items.ts";
import type { VaultItem } from "./items.ts";

export interface Signer {
  /** The member id it signs as. */
  id: string;
  /** Its Ed25519 seed. */
  seed: Uint8Array;
}

export interface VaultWrite {
  state: VaultStateFile;
  /** New objects by hash. */
  objects: Map<string, Uint8Array>;
  /** Objects the new state no longer refers to. */
  unreferenced: string[];
  /** The vault key after this change (a new one after a rotation). */
  vaultKey: X25519Identity;
}

async function snapshotFor(vaultId: string, trust: TrustRecord[], previous: { snapshot: Snapshot; hash: string } | null, keys: string, items: ItemRef[], signer: Signer, crypto: VaultCrypto): Promise<Snapshot> {
  const head = trust[trust.length - 1];
  return signSnapshot(
    {
      v: 1,
      type: "snapshot",
      vault: vaultId,
      seq: previous ? previous.snapshot.seq + 1 : 0,
      parent: previous ? previous.hash : null,
      trust: await recordHash(head, crypto),
      epoch: head.epoch,
      keys,
      items: [...items].sort((a, b) => (a.id < b.id ? -1 : 1)),
      created: nowIso(),
      signer: signer.id,
    },
    signer.seed,
    crypto,
  );
}

const unreferenced = (before: Snapshot | null, after: Snapshot): string[] => {
  if (!before) return [];
  const keep = new Set(referencedObjects(after));
  return referencedObjects(before).filter((h) => !keep.has(h));
};

/**
 * A new vault: a fresh vault key, a first trust record listing this device and
 * the recovery key, the key bundle encrypted to both, and an empty snapshot.
 */
export async function createVault(device: Member, recovery: Member, signer: Signer, crypto: VaultCrypto): Promise<VaultWrite & { vaultId: string }> {
  if (signer.id !== device.id) throw new VaultError("VAULT_INVALID", "A new vault is signed by the device creating it.");
  const vaultKey = await X25519Identity.generate(crypto);
  const genesis = await signTrust(
    { v: 1, type: "trust", seq: 0, prev: null, epoch: 1, recipient: (await vaultKey.recipient(crypto)).toString(), members: [device, recovery], created: nowIso(), signer: signer.id },
    signer.seed,
    crypto,
  );
  const vaultId = await recordHash(genesis, crypto);
  const bundle = await sealKeyBundle({ v: 1, type: "keys", vault: vaultId, epoch: 1, identity: vaultKey.toString() }, genesis.members, crypto);
  const keys = await sha256Hex(bundle, crypto);
  const snapshot = await snapshotFor(vaultId, [genesis], null, keys, [], signer, crypto);
  return { vaultId, vaultKey, state: { gitroll_vault: 1, vault: vaultId, trust: [genesis], snapshot }, objects: new Map([[keys, bundle]]), unreferenced: [] };
}

/** Adds or replaces items and removes others, as one new snapshot. */
export async function writeItems(state: VerifiedState, vaultKey: X25519Identity, change: { put?: VaultItem[]; remove?: string[] }, signer: Signer, crypto: VaultCrypto): Promise<VaultWrite> {
  const items = new Map(state.snapshot.items.map((r) => [r.id, r]));
  const objects = new Map<string, Uint8Array>();
  for (const id of change.remove ?? []) {
    if (!items.delete(id)) throw new VaultError("VAULT_INVALID", `There's no item ${id} to remove.`);
  }
  for (const item of change.put ?? []) {
    const sealed = await sealItem(state.vaultId, item, state.chain.head.recipient, crypto);
    objects.set(sealed.hash, sealed.bytes);
    items.set(item.id, sealed.ref);
  }
  const snapshot = await snapshotFor(state.vaultId, state.chain.records, { snapshot: state.snapshot, hash: state.snapshotHash }, state.snapshot.keys, [...items.values()], signer, crypto);
  return { state: { gitroll_vault: 1, vault: state.vaultId, trust: state.chain.records, snapshot }, objects, unreferenced: unreferenced(state.snapshot, snapshot), vaultKey };
}

/**
 * Changes who is a member. Adding members re-wraps the same vault key to the
 * new list. Removing any member — or `rotate` — makes a new vault key, a new
 * key epoch, and re-encrypts every item to it, because a removed member still
 * holds the old key. `items` must be every item, already opened.
 */
export async function changeMembers(
  state: VerifiedState,
  vaultKey: X25519Identity,
  items: VaultItem[],
  change: { add?: Member[]; remove?: string[]; rotate?: boolean },
  signer: Signer,
  crypto: VaultCrypto,
): Promise<VaultWrite> {
  const head = state.chain.head;
  let members = head.members.filter((m) => !(change.remove ?? []).includes(m.id));
  if ((change.remove ?? []).some((id) => !head.members.some((m) => m.id === id))) throw new VaultError("VAULT_INVALID", "That isn't a member of this vault.");
  if ((change.remove ?? []).includes(signer.id)) throw new VaultError("VAULT_INVALID", "A device can't remove itself. Remove it from another device, or with the recovery key.");
  for (const m of change.add ?? []) {
    if (members.some((x) => x.id === m.id || x.age === m.age || x.sign === m.sign)) throw new VaultError("VAULT_INVALID", "That device is already a member.");
    members = [...members, m];
  }
  const rotate = !!change.rotate || (change.remove ?? []).length > 0;
  if (rotate && items.length !== state.snapshot.items.length) throw new VaultError("VAULT_INVALID", "Rotating the vault key needs every item opened.");
  const key = rotate ? await X25519Identity.generate(crypto) : vaultKey;
  const body: TrustBody = {
    v: 1,
    type: "trust",
    seq: head.seq + 1,
    prev: state.chain.headHash,
    epoch: rotate ? head.epoch + 1 : head.epoch,
    recipient: rotate ? (await key.recipient(crypto)).toString() : head.recipient,
    members,
    created: nowIso(),
    signer: signer.id,
  };
  const record = await signTrust(body, signer.seed, crypto);
  const trust = [...state.chain.records, record];
  await verifyChain(trust, crypto); // the same rules a reader applies, before anything is written
  const objects = new Map<string, Uint8Array>();
  const bundle = await sealKeyBundle({ v: 1, type: "keys", vault: state.vaultId, epoch: body.epoch, identity: key.toString() }, members, crypto);
  const keys = await sha256Hex(bundle, crypto);
  objects.set(keys, bundle);
  let refs = state.snapshot.items;
  if (rotate) {
    refs = [];
    for (const item of items) {
      const sealed = await sealItem(state.vaultId, item, body.recipient, crypto);
      objects.set(sealed.hash, sealed.bytes);
      refs.push(sealed.ref);
    }
  }
  const snapshot = await snapshotFor(state.vaultId, trust, { snapshot: state.snapshot, hash: state.snapshotHash }, keys, refs, signer, crypto);
  return { state: { gitroll_vault: 1, vault: state.vaultId, trust, snapshot }, objects, unreferenced: unreferenced(state.snapshot, snapshot), vaultKey: key };
}
