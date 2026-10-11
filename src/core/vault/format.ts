// The GitRoll Vault format, version 1: what a vault's files contain, how they
// are signed, and every check a reader makes before trusting them. Specified in
// docs/VAULT-FORMAT.md; this file and that one change together.
//
// Platform-free: the crypto primitives are injected (crypto.ts), and files are
// handed in as bytes. Encryption is age (../age/), signatures are Ed25519, and
// hashes are SHA-256, all from the platform. Nothing here is a new primitive:
// what is GitRoll's own is the layout, the canonical encoding and the rules.
//
//   .gitroll/vault/<name>/
//   ├── state.json            the signed trust chain and the signed snapshot
//   └── objects/<sha256>.age  the key bundle and one file per item, age-encrypted
//
// state.json is the only file ever replaced; objects are named by the SHA-256
// of their bytes and never change. A write adds objects, then replaces
// state.json in one atomic rename, then removes the objects nothing refers to.
// An interrupted write leaves either the old state or the new one, plus at
// worst some unreferenced objects.

import { X25519Identity, X25519Recipient, decrypt, encrypt, isRecipient } from "../age/format.ts";
import { base64, equalBytes, fromUtf8, unbase64, utf8 } from "../age/bytes.ts";
import { UserError } from "../util.ts";
import type { VaultCrypto } from "./crypto.ts";

export const VAULT_FORMAT = 1;
/** Every vault in a Roll lives under this folder, one subfolder per vault. */
export const VAULTS_DIR = ".gitroll/vault";
export const STATE_FILE = "state.json";
export const OBJECTS_DIR = "objects";
export const vaultDir = (name: string): string => `${VAULTS_DIR}/${name}`;
export const objectFile = (hash: string): string => `${OBJECTS_DIR}/${hash}.age`;
export const OBJECT_FILE = /^objects\/([0-9a-f]{64})\.age$/;
/** A vault's name: its folder under .gitroll/vault/. Not secret, so keep it generic ("personal", "work"). */
export const VAULT_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

// Limits a reader enforces before doing any work, so a hostile repository
// can't make it allocate or compute without bound.
export const LIMITS = {
  stateBytes: 4 * 1024 * 1024,
  objectBytes: 8 * 1024 * 1024,
  trustRecords: 4096,
  members: 64,
  items: 20000,
  fields: 200,
  fieldName: 64,
  fieldValue: 64 * 1024,
  title: 1024,
  notes: 1024 * 1024,
} as const;

const SIGNATURE_CONTEXT = {
  trust: "gitroll-vault/v1 trust\n",
  snapshot: "gitroll-vault/v1 snapshot\n",
} as const;

export type VaultErrorCode = "VAULT_TAMPERED" | "VAULT_UNSUPPORTED" | "VAULT_ROLLBACK" | "VAULT_LOCKED" | "VAULT_FORBIDDEN" | "VAULT_INVALID";

/**
 * Something about a vault is wrong in a way the reader must not paper over.
 * Messages never include secret values: they name files, ids and checks.
 */
export class VaultError extends UserError {
  code: VaultErrorCode;
  constructor(code: VaultErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}
const tampered = (message: string): never => {
  throw new VaultError("VAULT_TAMPERED", message);
};

// ── Encoding ───────────────────────────────────────────────────────────────

/**
 * The canonical JSON of a value: RFC 8785 (JCS) restricted to what this format
 * uses — objects, arrays, strings, safe integers, booleans and null. Keys are
 * sorted by UTF-16 code units, there is no whitespace, and strings are escaped
 * as JSON.stringify escapes them, which is what JCS specifies.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new VaultError("VAULT_INVALID", "Only safe integers can be signed.");
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new VaultError("VAULT_INVALID", "Only plain objects can be signed.");
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  throw new VaultError("VAULT_INVALID", `A ${typeof value} can't be signed.`);
}

export const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
export function unhex(text: string): Uint8Array | null {
  if (!/^(?:[0-9a-f]{2})*$/.test(text)) return null;
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}
export const sha256Hex = async (data: Uint8Array, crypto: VaultCrypto): Promise<string> => hex(await crypto.sha256(data));
/** The hash a record is known by: SHA-256 of its canonical JSON, signature included. */
export const recordHash = (record: object, crypto: VaultCrypto): Promise<string> => sha256Hex(utf8(canonicalJson(record)), crypto);

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
/** A new random id: 128 bits as 26 characters of lowercase RFC 4648 base32. */
export async function newId(crypto: VaultCrypto): Promise<string> {
  const bytes = await crypto.randomBytes(16);
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const b of bytes) {
    buffer = (buffer << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32[(buffer >> bits) & 31];
    }
  }
  if (bits) out += BASE32[(buffer << (5 - bits)) & 31];
  return out;
}
export const ID = /^[a-z2-7]{26}$/;
const HASH = /^[0-9a-f]{64}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

// ── Shapes ─────────────────────────────────────────────────────────────────

export type MemberRole = "device" | "recovery";
export interface Member {
  id: string;
  role: MemberRole;
  /** The member's age X25519 recipient: the key bundle is encrypted to it. */
  age: string;
  /** The member's Ed25519 public key, base64: what it signs with. */
  sign: string;
}

export interface TrustBody {
  v: 1;
  type: "trust";
  seq: number;
  /** The previous record's hash, or null for the first. */
  prev: string | null;
  /** Increases by one exactly when the vault key changes. */
  epoch: number;
  /** The vault key's age recipient for this epoch: every item is encrypted to it. */
  recipient: string;
  members: Member[];
  created: string;
  /** The member who signed. Must be a member before and after this record. */
  signer: string;
}
export interface TrustRecord extends TrustBody {
  sig: string;
}

export interface ItemRef {
  id: string;
  rev: number;
  object: string;
}
export interface SnapshotBody {
  v: 1;
  type: "snapshot";
  vault: string;
  seq: number;
  parent: string | null;
  /** The hash of the trust record this snapshot was written under: always the chain's last. */
  trust: string;
  epoch: number;
  /** The object holding this epoch's key bundle. */
  keys: string;
  /** Every item, sorted by id. */
  items: ItemRef[];
  created: string;
  signer: string;
}
export interface Snapshot extends SnapshotBody {
  sig: string;
}

/** state.json. */
export interface VaultStateFile {
  gitroll_vault: 1;
  vault: string;
  trust: TrustRecord[];
  snapshot: Snapshot;
}

export interface KeyBundle {
  v: 1;
  type: "keys";
  vault: string;
  epoch: number;
  /** The vault key: an age X25519 identity. */
  identity: string;
}

/** What a reader remembers about a vault, outside the repository, to notice a rollback. */
export interface Pin {
  trust: { seq: number; hash: string };
  snapshot: { seq: number; hash: string };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
function exactKeys(v: unknown, keys: string[], what: string): Record<string, unknown> {
  if (!isObject(v)) tampered(`${what} isn't an object.`);
  const o = v as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !keys.includes(k));
  if (extra.length) throw new VaultError("VAULT_UNSUPPORTED", `${what} has fields this version of GitRoll doesn't know (${extra.slice(0, 5).join(", ")}). Upgrade GitRoll to open this vault.`);
  for (const k of keys) if (!(k in o)) tampered(`${what} is missing ${k}.`);
  return o;
}
const isInt = (v: unknown, min = 0): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= min;
function signKey(text: unknown, what: string): Uint8Array {
  const key = typeof text === "string" ? unbase64(text) : null;
  if (!key || key.length !== 32) tampered(`${what} has a malformed signing key.`);
  return key as Uint8Array;
}

function checkVersion(o: Record<string, unknown>, field: string, what: string): void {
  if (o[field] !== 1) throw new VaultError("VAULT_UNSUPPORTED", `${what} is version ${String(o[field])}; this GitRoll reads version 1. Upgrade GitRoll to open this vault.`);
}

function checkMembers(value: unknown, what: string): Member[] {
  if (!Array.isArray(value) || !value.length || value.length > LIMITS.members) tampered(`${what} must list 1–${LIMITS.members} members.`);
  const members = (value as unknown[]).map((m, i) => {
    const o = exactKeys(m, ["id", "role", "age", "sign"], `${what}, member ${i + 1}`);
    if (typeof o.id !== "string" || !ID.test(o.id)) tampered(`${what}, member ${i + 1} has a malformed id.`);
    if (o.role !== "device" && o.role !== "recovery") throw new VaultError("VAULT_UNSUPPORTED", `${what} has a member role this GitRoll doesn't know.`);
    if (typeof o.age !== "string" || !isRecipient(o.age)) tampered(`${what}, member ${o.id} has a malformed age recipient.`);
    signKey(o.sign, `${what}, member ${o.id}`);
    return o as unknown as Member;
  });
  for (const field of ["id", "age", "sign"] as const) {
    if (new Set(members.map((m) => m[field])).size !== members.length) tampered(`${what} lists the same member ${field} twice.`);
  }
  if (!members.some((m) => m.role === "device")) tampered(`${what} has no device that can use the vault.`);
  if (!members.some((m) => m.role === "recovery")) tampered(`${what} has no recovery key.`);
  return members;
}

function checkTrustShape(value: unknown, index: number): TrustRecord {
  const what = `Trust record ${index}`;
  if (isObject(value)) checkVersion(value, "v", what);
  const o = exactKeys(value, ["v", "type", "seq", "prev", "epoch", "recipient", "members", "created", "signer", "sig"], what);
  if (o.type !== "trust") tampered(`${what} isn't a trust record.`);
  if (!isInt(o.seq)) tampered(`${what} has a malformed sequence number.`);
  if (o.prev !== null && (typeof o.prev !== "string" || !HASH.test(o.prev))) tampered(`${what} has a malformed link to the previous record.`);
  if (!isInt(o.epoch, 1)) tampered(`${what} has a malformed key epoch.`);
  if (typeof o.recipient !== "string" || !isRecipient(o.recipient)) tampered(`${what} has a malformed vault recipient.`);
  checkMembers(o.members, what);
  if (typeof o.created !== "string" || !TIME.test(o.created)) tampered(`${what} has a malformed time.`);
  if (typeof o.signer !== "string" || !ID.test(o.signer)) tampered(`${what} has a malformed signer.`);
  if (typeof o.sig !== "string") tampered(`${what} has no signature.`);
  return o as unknown as TrustRecord;
}

function checkSnapshotShape(value: unknown): Snapshot {
  if (isObject(value)) checkVersion(value, "v", "The snapshot");
  const o = exactKeys(value, ["v", "type", "vault", "seq", "parent", "trust", "epoch", "keys", "items", "created", "signer", "sig"], "The snapshot");
  if (o.type !== "snapshot") tampered("The snapshot isn't a snapshot.");
  if (typeof o.vault !== "string" || !HASH.test(o.vault)) tampered("The snapshot names a malformed vault id.");
  if (!isInt(o.seq)) tampered("The snapshot has a malformed sequence number.");
  if (o.parent !== null && (typeof o.parent !== "string" || !HASH.test(o.parent))) tampered("The snapshot has a malformed parent.");
  if (typeof o.trust !== "string" || !HASH.test(o.trust)) tampered("The snapshot has a malformed trust link.");
  if (!isInt(o.epoch, 1)) tampered("The snapshot has a malformed key epoch.");
  if (typeof o.keys !== "string" || !HASH.test(o.keys)) tampered("The snapshot has a malformed key bundle reference.");
  if (!Array.isArray(o.items) || o.items.length > LIMITS.items) tampered("The snapshot's item list is malformed or too long.");
  let last = "";
  for (const [i, item] of (o.items as unknown[]).entries()) {
    const r = exactKeys(item, ["id", "rev", "object"], `Snapshot item ${i + 1}`);
    if (typeof r.id !== "string" || !ID.test(r.id)) tampered(`Snapshot item ${i + 1} has a malformed id.`);
    if ((r.id as string) <= last) tampered(r.id === last ? `The snapshot lists item ${r.id} twice.` : "The snapshot's items aren't in order.");
    last = r.id as string;
    if (!isInt(r.rev, 1)) tampered(`Snapshot item ${r.id} has a malformed revision.`);
    if (typeof r.object !== "string" || !HASH.test(r.object)) tampered(`Snapshot item ${r.id} has a malformed object reference.`);
    if (r.object === o.keys) tampered(`Snapshot item ${r.id} points at the key bundle.`);
  }
  if (new Set((o.items as ItemRef[]).map((i) => i.object)).size !== (o.items as ItemRef[]).length) tampered("Two snapshot items point at the same object.");
  if (typeof o.created !== "string" || !TIME.test(o.created)) tampered("The snapshot has a malformed time.");
  if (typeof o.signer !== "string" || !ID.test(o.signer)) tampered("The snapshot has a malformed signer.");
  if (typeof o.sig !== "string") tampered("The snapshot has no signature.");
  return o as unknown as Snapshot;
}

// ── Signing ────────────────────────────────────────────────────────────────

const unsigned = <T extends { sig: string }>(r: T): Omit<T, "sig"> => {
  const { sig: _sig, ...body } = r;
  return body;
};
const signedMessage = (context: keyof typeof SIGNATURE_CONTEXT, body: object) => utf8(SIGNATURE_CONTEXT[context] + canonicalJson(body));

export async function signTrust(body: TrustBody, seed: Uint8Array, crypto: VaultCrypto): Promise<TrustRecord> {
  return { ...body, sig: base64(await crypto.ed25519Sign(seed, signedMessage("trust", body))) };
}
export async function signSnapshot(body: SnapshotBody, seed: Uint8Array, crypto: VaultCrypto): Promise<Snapshot> {
  return { ...body, sig: base64(await crypto.ed25519Sign(seed, signedMessage("snapshot", body))) };
}
async function verifySig(context: keyof typeof SIGNATURE_CONTEXT, record: { sig: string }, publicKey: string, crypto: VaultCrypto): Promise<boolean> {
  const sig = unbase64(record.sig);
  if (!sig || sig.length !== 64) return false;
  return crypto.ed25519Verify(signKey(publicKey, "A member"), signedMessage(context, unsigned(record)), sig);
}

// ── Verifying ──────────────────────────────────────────────────────────────

export interface Chain {
  /** The vault id: the hash of the first trust record. */
  vaultId: string;
  records: TrustRecord[];
  /** hashes[i] is the hash of records[i]. */
  hashes: string[];
  head: TrustRecord;
  headHash: string;
}

/**
 * Checks a trust chain from its first record. Each record must link to the one
 * before, carry the next sequence number, and be signed by a member of the
 * record before it (the first by one of its own members). Removing a member
 * must change the vault key: re-wrapping the same key is not revocation.
 */
export async function verifyChain(value: unknown, crypto: VaultCrypto): Promise<Chain> {
  if (!Array.isArray(value) || !value.length) tampered("The vault has no trust records.");
  if ((value as unknown[]).length > LIMITS.trustRecords) tampered("The vault's trust chain is too long.");
  const records = (value as unknown[]).map(checkTrustShape);
  const hashes: string[] = [];
  for (const [i, r] of records.entries()) {
    const prev = i ? records[i - 1] : null;
    if (r.seq !== i) tampered(`Trust record ${i} has sequence number ${r.seq}.`);
    if (r.prev !== (prev ? hashes[i - 1] : null)) tampered(`Trust record ${i} doesn't link to the record before it.`);
    const authority = prev ?? r;
    const signer = authority.members.find((m) => m.id === r.signer);
    if (!signer) throw new VaultError("VAULT_FORBIDDEN", `Trust record ${i} was signed by ${r.signer}, who wasn't a member.`);
    if (!r.members.some((m) => m.id === r.signer)) tampered(`Trust record ${i}'s signer removed itself.`);
    if (!(await verifySig("trust", r, signer.sign, crypto))) tampered(`Trust record ${i}'s signature doesn't verify.`);
    if (prev) {
      for (const m of r.members) {
        const before = prev.members.find((p) => p.id === m.id);
        if (before && (before.age !== m.age || before.sign !== m.sign || before.role !== m.role)) tampered(`Trust record ${i} changes member ${m.id}'s keys; a new key is a new member.`);
      }
      const removed = prev.members.some((p) => !r.members.some((m) => m.id === p.id));
      const rotated = r.epoch === prev.epoch + 1;
      if (!rotated && r.epoch !== prev.epoch) tampered(`Trust record ${i} skips a key epoch.`);
      if (rotated === (r.recipient === prev.recipient)) tampered(`Trust record ${i} changes the vault key without a new epoch, or the epoch without a new key.`);
      if (removed && !rotated) tampered(`Trust record ${i} removes a member without changing the vault key.`);
    } else if (r.epoch !== 1) tampered("The first trust record must start at key epoch 1.");
    hashes.push(await recordHash(r, crypto));
  }
  return { vaultId: hashes[0], records, hashes, head: records[records.length - 1], headHash: hashes[hashes.length - 1] };
}

export async function verifySnapshot(value: unknown, chain: Chain, crypto: VaultCrypto): Promise<{ snapshot: Snapshot; hash: string }> {
  const snapshot = checkSnapshotShape(value);
  if (snapshot.vault !== chain.vaultId) tampered("The snapshot belongs to a different vault.");
  if (snapshot.trust !== chain.headHash) tampered("The snapshot wasn't written under the latest trust record.");
  if (snapshot.epoch !== chain.head.epoch) tampered("The snapshot's key epoch doesn't match the trust record's.");
  if ((snapshot.seq === 0) !== (snapshot.parent === null)) tampered("The snapshot's sequence number and parent disagree.");
  const signer = chain.head.members.find((m) => m.id === snapshot.signer);
  if (!signer) throw new VaultError("VAULT_FORBIDDEN", `The snapshot was signed by ${snapshot.signer}, who isn't a member.`);
  if (!(await verifySig("snapshot", snapshot, signer.sign, crypto))) tampered("The snapshot's signature doesn't verify.");
  return { snapshot, hash: await recordHash(snapshot, crypto) };
}

export interface VerifiedState {
  vaultId: string;
  chain: Chain;
  snapshot: Snapshot;
  snapshotHash: string;
  /** The pin to remember once this state is accepted. */
  pin: Pin;
}

/**
 * Parses and authenticates state.json. With `expectVault`, refuses a state for
 * any other vault; with `pin`, refuses one older than what was last accepted,
 * or one that forks from it.
 */
export async function openState(bytes: Uint8Array, crypto: VaultCrypto, opts: { expectVault?: string; pin?: Pin | null } = {}): Promise<VerifiedState> {
  if (bytes.length > LIMITS.stateBytes) tampered("state.json is too large.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromUtf8(bytes));
  } catch {
    tampered("state.json isn't valid JSON.");
  }
  if (isObject(parsed)) checkVersion(parsed, "gitroll_vault", "This vault");
  const file = exactKeys(parsed, ["gitroll_vault", "vault", "trust", "snapshot"], "state.json");
  const chain = await verifyChain(file.trust, crypto);
  if (file.vault !== chain.vaultId) tampered("state.json names a vault id that doesn't match its first trust record.");
  if (opts.expectVault && chain.vaultId !== opts.expectVault) tampered("This is a different vault from the one this device enrolled in (the vault id doesn't match).");
  const { snapshot, hash } = await verifySnapshot(file.snapshot, chain, crypto);
  const state: VerifiedState = {
    vaultId: chain.vaultId,
    chain,
    snapshot,
    snapshotHash: hash,
    pin: { trust: { seq: chain.head.seq, hash: chain.headHash }, snapshot: { seq: snapshot.seq, hash } },
  };
  if (opts.pin) checkFresh(state, opts.pin);
  return state;
}

/** Refuses a state older than the pin, or one that disagrees with it at the same point. */
export function checkFresh(state: VerifiedState, pin: Pin): void {
  const rollback = (message: string): never => {
    throw new VaultError("VAULT_ROLLBACK", `${message} Someone may have restored an old copy of the vault. Nothing was changed.`);
  };
  const atPin = state.chain.hashes[pin.trust.seq];
  if (atPin === undefined) rollback(`The vault's trust chain is shorter than the one this device last accepted (record ${pin.trust.seq}).`);
  if (atPin !== pin.trust.hash) rollback(`The vault's trust chain differs from the one this device last accepted at record ${pin.trust.seq}.`);
  if (state.snapshot.seq < pin.snapshot.seq) rollback(`The vault's snapshot (${state.snapshot.seq}) is older than the one this device last accepted (${pin.snapshot.seq}).`);
  if (state.snapshot.seq === pin.snapshot.seq && state.snapshotHash !== pin.snapshot.hash) rollback(`The vault's snapshot ${state.snapshot.seq} differs from the one this device accepted with the same number.`);
}

/** The objects a state refers to: its key bundle and every item. */
export const referencedObjects = (snapshot: Snapshot): string[] => [snapshot.keys, ...snapshot.items.map((i) => i.object)];

/** Checks that an object's bytes are the ones its name and the snapshot promise. */
export async function checkObject(hash: string, bytes: Uint8Array | null, crypto: VaultCrypto): Promise<Uint8Array> {
  if (!bytes) tampered(`Object ${hash.slice(0, 12)} is missing from the vault.`);
  if ((bytes as Uint8Array).length > LIMITS.objectBytes) tampered(`Object ${hash.slice(0, 12)} is too large.`);
  const actual = await crypto.sha256(bytes as Uint8Array);
  const expected = unhex(hash);
  if (!expected || !equalBytes(actual, expected)) tampered(`Object ${hash.slice(0, 12)} isn't the one the snapshot lists: it was changed or replaced.`);
  return bytes as Uint8Array;
}

// ── Key bundles ────────────────────────────────────────────────────────────

/** Encrypts the vault key to every member: the key bundle object. */
export async function sealKeyBundle(bundle: KeyBundle, members: Member[], crypto: VaultCrypto): Promise<Uint8Array> {
  return encrypt(utf8(canonicalJson(bundle)), members.map((m) => X25519Recipient.parse(m.age)), crypto);
}

/** Opens the key bundle with a member's identity and checks it is the vault key the trust chain names. */
export async function openKeyBundle(state: VerifiedState, bytes: Uint8Array | null, identity: X25519Identity, crypto: VaultCrypto): Promise<X25519Identity> {
  const object = await checkObject(state.snapshot.keys, bytes, crypto);
  let plain: Uint8Array;
  try {
    plain = await decrypt(object, [identity], crypto);
  } catch {
    throw new VaultError("VAULT_FORBIDDEN", "This key can't open the vault: it isn't one of the vault's members, or it was removed.");
  }
  let bundle: unknown;
  try {
    bundle = JSON.parse(fromUtf8(plain));
  } catch {
    tampered("The key bundle is malformed.");
  }
  if (isObject(bundle)) checkVersion(bundle, "v", "The key bundle");
  const b = exactKeys(bundle, ["v", "type", "vault", "epoch", "identity"], "The key bundle");
  if (b.type !== "keys" || b.vault !== state.vaultId || b.epoch !== state.chain.head.epoch) tampered("The key bundle belongs to another vault or key epoch.");
  let vaultKey: X25519Identity;
  try {
    vaultKey = X25519Identity.parse(String(b.identity));
  } catch {
    tampered("The key bundle's vault key is malformed.");
  }
  if ((await vaultKey!.recipient(crypto)).toString() !== state.chain.head.recipient) tampered("The key bundle holds a key other than the one the trust chain names.");
  return vaultKey!;
}

// ── Identities from bytes ──────────────────────────────────────────────────

/** A member's public half, from its secret keys. */
export async function memberFor(id: string, role: MemberRole, age: X25519Identity, signSeed: Uint8Array, crypto: VaultCrypto): Promise<Member> {
  return { id, role, age: (await age.recipient(crypto)).toString(), sign: base64(await crypto.ed25519Public(signSeed)) };
}

export const nowIso = (d = new Date()): string => d.toISOString().replace(/\.\d+Z$/, "Z");
