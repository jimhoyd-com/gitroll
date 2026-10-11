// The vault format's security checks, at the core level: every way a hostile
// repository writer could try to substitute, swap, forge, roll back or
// smuggle data is refused. Synthetic keys and secrets only.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ScryptIdentity, ScryptRecipient, X25519Identity, decrypt, encrypt } from "../src/core/age/format.ts";
import { utf8 } from "../src/core/age/bytes.ts";
import {
  VaultError,
  canonicalJson,
  checkFresh,
  memberFor,
  newId,
  openKeyBundle,
  openState,
  recordHash,
  sealKeyBundle,
  sha256Hex,
  signSnapshot,
  signTrust,
  verifyChain,
} from "../src/core/vault/format.ts";
import type { Member, VaultStateFile, VerifiedState } from "../src/core/vault/format.ts";
import { encodeItem, findItem, openItem, parseItem, redactItem, searchItems, sealItem } from "../src/core/vault/items.ts";
import type { VaultItem } from "../src/core/vault/items.ts";
import { changeMembers, createVault, writeItems } from "../src/core/vault/ops.ts";
import type { Signer, VaultWrite } from "../src/core/vault/ops.ts";
import { nodeVaultCrypto as crypto } from "../src/node/vault/crypto.ts";
import { tmp } from "./helpers.ts";

const enc = (o: unknown) => utf8(JSON.stringify(o));
const code = (c: string) => (e: unknown) => e instanceof VaultError && e.code === c;

interface Party {
  member: Member;
  signer: Signer;
  age: X25519Identity;
}
async function party(role: "device" | "recovery" = "device"): Promise<Party> {
  const id = await newId(crypto);
  const age = await X25519Identity.generate(crypto);
  const seed = await crypto.randomBytes(32);
  return { member: await memberFor(id, role, age, seed, crypto), signer: { id, seed }, age };
}

/** A vault in memory: state.json plus objects. */
class Mem {
  state!: VaultStateFile;
  objects = new Map<string, Uint8Array>();
  apply(w: VaultWrite) {
    for (const [h, b] of w.objects) this.objects.set(h, b);
    for (const h of w.unreferenced) this.objects.delete(h);
    this.state = w.state;
  }
  bytes() {
    return enc(this.state);
  }
  open(opts = {}) {
    return openState(this.bytes(), crypto, opts);
  }
}

async function fixture() {
  const device = await party();
  const recovery = await party("recovery");
  const mem = new Mem();
  const made = await createVault(device.member, recovery.member, device.signer, crypto);
  mem.apply(made);
  const item = (title: string, password: string, id?: string): VaultItem => ({
    id: id ?? "",
    rev: 1,
    kind: "login",
    title,
    fields: [{ name: "username", value: "synthetic-user", secret: false }, { name: "password", value: password, secret: true }],
    notes: "",
    created: "2026-10-11T00:00:00Z",
    updated: "2026-10-11T00:00:00Z",
    ext: {},
  });
  const a = item("Bank", "synthetic-password-1", await newId(crypto));
  const b = item("Mail", "synthetic-password-2", await newId(crypto));
  mem.apply(await writeItems(await mem.open(), made.vaultKey, { put: [a, b] }, device.signer, crypto));
  return { device, recovery, mem, vaultKey: made.vaultKey, vaultId: made.vaultId, a, b, item };
}

async function readAll(state: VerifiedState, mem: Mem, key: X25519Identity) {
  return Promise.all(state.snapshot.items.map((r) => openItem(state, r, mem.objects.get(r.object) ?? null, key, crypto)));
}

test("canonical JSON is RFC 8785 for the values the format uses", () => {
  assert.equal(canonicalJson({ b: [1, "x", null, true], a: { d: "é\n\"", c: 0 } }), '{"a":{"c":0,"d":"é\\n\\""},"b":[1,"x",null,true]}');
  assert.throws(() => canonicalJson({ x: 1.5 }), code("VAULT_INVALID"));
  assert.throws(() => canonicalJson({ x: 2 ** 60 }), code("VAULT_INVALID"));
});

test("a new vault opens, and items round-trip through encryption and the signed snapshot", async () => {
  const f = await fixture();
  const state = await f.mem.open({ expectVault: f.vaultId });
  assert.equal(state.vaultId, f.vaultId);
  assert.equal(state.chain.head.members.length, 2);
  const key = await openKeyBundle(state, f.mem.objects.get(state.snapshot.keys)!, f.device.age, crypto);
  const items = await readAll(state, f.mem, key);
  assert.deepEqual(items.map((i) => i.title).sort(), ["Bank", "Mail"]);
  assert.equal(findItem(items, "bank").fields[1].value, "synthetic-password-1");
  // The recovery key opens the key bundle too.
  await openKeyBundle(state, f.mem.objects.get(state.snapshot.keys)!, f.recovery.age, crypto);
  // Nothing in state.json or any object is plaintext.
  const everything = Buffer.concat([Buffer.from(f.mem.bytes()), ...[...f.mem.objects.values()].map((b) => Buffer.from(b))]).toString("latin1");
  for (const secret of ["synthetic-password-1", "Bank", "synthetic-user", "Mail"]) assert.ok(!everything.includes(secret), `${secret} leaked`);
});

test("listings and search never carry secret values", async () => {
  const f = await fixture();
  const state = await f.mem.open();
  const items = await readAll(state, f.mem, f.vaultKey);
  const shown = JSON.stringify(items.map(redactItem));
  assert.ok(!shown.includes("synthetic-password"));
  assert.ok(shown.includes("synthetic-user"));
  assert.equal(searchItems(items, "synthetic-password-1").length, 0, "search must not match secret values");
  assert.equal(searchItems(items, "bank").length, 1);
});

test("a changed snapshot fails its signature; one signed by a stranger is refused", async () => {
  const f = await fixture();
  const forged = structuredClone(f.mem.state);
  forged.snapshot.items[0].rev = 7;
  await assert.rejects(openState(enc(forged), crypto), code("VAULT_TAMPERED"));
  const stranger = await party();
  const { sig: _s, ...body } = f.mem.state.snapshot;
  const resigned = structuredClone(f.mem.state);
  resigned.snapshot = await signSnapshot({ ...body, signer: stranger.member.id }, stranger.signer.seed, crypto);
  await assert.rejects(openState(enc(resigned), crypto), code("VAULT_FORBIDDEN"));
});

test("recipient substitution: an object anyone could encrypt to the vault's public key is refused", async () => {
  const f = await fixture();
  const state = await f.mem.open();
  // The vault recipient is public, so an attacker can make a well-formed item for it…
  const evil = await sealItem(f.vaultId, { ...f.a, fields: [{ name: "password", value: "attacker", secret: true }] }, state.chain.head.recipient, crypto);
  // …but putting it where the real one was changes its hash: refused.
  const ref = state.snapshot.items.find((r) => r.id === f.a.id)!;
  await assert.rejects(openItem(state, ref, evil.bytes, f.vaultKey, crypto), code("VAULT_TAMPERED"));
});

test("a cross-item swap or a stale revision is caught inside the ciphertext, even under a valid signature", async () => {
  const f = await fixture();
  const state = await f.mem.open();
  const [r0, r1] = state.snapshot.items;
  // A member's buggy (or malicious) client signs a snapshot pointing one id at the other item's object.
  const { sig: _s, ...body } = state.snapshot;
  const swapped = structuredClone(f.mem.state);
  swapped.snapshot = await signSnapshot({ ...body, items: [{ ...r0, object: r1.object }, { ...r1, object: r0.object }] }, f.device.signer.seed, crypto);
  const s2 = await openState(enc(swapped), crypto);
  await assert.rejects(openItem(s2, s2.snapshot.items[0], f.mem.objects.get(s2.snapshot.items[0].object)!, f.vaultKey, crypto), /holds a different item/);
  // An old revision presented as the current one.
  const old = f.mem.objects.get(r0.object)!;
  const edited = await writeItems(state, f.vaultKey, { put: [{ ...findItem(await readAll(state, f.mem, f.vaultKey), r0.id), rev: 2 }] }, f.device.signer, crypto);
  f.mem.apply(edited);
  const s3 = await f.mem.open();
  const ref = s3.snapshot.items.find((r) => r.id === r0.id)!;
  const { sig: _t, ...b3 } = s3.snapshot;
  const rolled = structuredClone(f.mem.state);
  rolled.snapshot = await signSnapshot({ ...b3, items: b3.items.map((r) => (r.id === r0.id ? { ...r, object: r0.object } : r)) }, f.device.signer.seed, crypto);
  const s4 = await openState(enc(rolled), crypto);
  await assert.rejects(openItem(s4, s4.snapshot.items.find((r) => r.id === r0.id)!, old, f.vaultKey, crypto), /at revision 1, but the snapshot lists 2/);
  assert.equal(ref.rev, 2);
});

test("an item from another vault is refused", async () => {
  const f = await fixture();
  const g = await fixture();
  const gs = await g.mem.open();
  const fs_ = await f.mem.open();
  // g's item, encrypted to f's vault key, but carrying g's vault id inside.
  const foreign = await sealItem(gs.vaultId, { ...g.a, id: f.a.id }, fs_.chain.head.recipient, crypto);
  const { sig: _s, ...body } = fs_.snapshot;
  const st = structuredClone(f.mem.state);
  st.snapshot = await signSnapshot({ ...body, items: body.items.map((r) => (r.id === f.a.id ? { ...r, object: foreign.hash } : r)) }, f.device.signer.seed, crypto);
  const s = await openState(enc(st), crypto);
  await assert.rejects(openItem(s, s.snapshot.items.find((r) => r.id === f.a.id)!, foreign.bytes, f.vaultKey, crypto), /belongs to another vault/);
  await assert.rejects(openState(enc(g.mem.state), crypto, { expectVault: f.vaultId }), code("VAULT_TAMPERED"));
});

test("missing objects, duplicate ids, unsorted items and malformed ciphertext are refused", async () => {
  const f = await fixture();
  const state = await f.mem.open();
  await assert.rejects(openItem(state, state.snapshot.items[0], null, f.vaultKey, crypto), /missing/);
  const dup = structuredClone(f.mem.state);
  dup.snapshot.items = [dup.snapshot.items[0], dup.snapshot.items[0]];
  await assert.rejects(openState(enc(dup), crypto), /twice/);
  const unsorted = structuredClone(f.mem.state);
  unsorted.snapshot.items.reverse();
  await assert.rejects(openState(enc(unsorted), crypto), /order/);
  // Truncated ciphertext under a valid signature: the hash is right, decryption fails cleanly.
  const cut = f.mem.objects.get(state.snapshot.items[0].object)!.slice(0, -5);
  const h = await sha256Hex(cut, crypto);
  const { sig: _s, ...body } = state.snapshot;
  const st = structuredClone(f.mem.state);
  st.snapshot = await signSnapshot({ ...body, items: body.items.map((r, i) => (i === 0 ? { ...r, object: h } : r)) }, f.device.signer.seed, crypto);
  const s = await openState(enc(st), crypto);
  await assert.rejects(openItem(s, s.snapshot.items[0], cut, f.vaultKey, crypto), code("VAULT_TAMPERED"));
});

test("unknown versions and unknown fields are refused as unsupported, not guessed at", async () => {
  const f = await fixture();
  await assert.rejects(openState(enc({ ...f.mem.state, gitroll_vault: 2 }), crypto), code("VAULT_UNSUPPORTED"));
  await assert.rejects(openState(enc({ ...f.mem.state, extra: true }), crypto), code("VAULT_UNSUPPORTED"));
  const v2 = structuredClone(f.mem.state) as unknown as { snapshot: Record<string, unknown> };
  v2.snapshot.v = 2;
  await assert.rejects(openState(enc(v2), crypto), code("VAULT_UNSUPPORTED"));
  assert.throws(() => parseItem("---\ngitroll_vault: 2\ntype: item\n---\n"), code("VAULT_UNSUPPORTED"));
  // YAML aliases (billion laughs) are refused.
  assert.throws(() => parseItem(`---\ngitroll_vault: 1\ntype: item\na: &a [x, x]\nb: [*a, *a]\n---\n`));
  await assert.rejects(openState(utf8("{".repeat(10)), crypto), code("VAULT_TAMPERED"));
  await assert.rejects(openState(new Uint8Array(5 * 1024 * 1024), crypto), /too large/);
});

test("trust chain: tampering, outsiders, and removal without a new key are refused", async () => {
  const f = await fixture();
  const state = await f.mem.open();
  const changed = structuredClone(f.mem.state);
  changed.trust[0].members[0].sign = changed.trust[0].members[1].sign;
  await assert.rejects(openState(enc(changed), crypto));
  // A record signed by someone who isn't a member.
  const outsider = await party();
  const bad = await signTrust({ ...state.chain.head, seq: 1, prev: state.chain.headHash, members: [...state.chain.head.members, outsider.member], signer: outsider.member.id, created: "2026-10-11T00:00:00Z" } as never, outsider.signer.seed, crypto);
  await assert.rejects(verifyChain([...state.chain.records, bad], crypto), code("VAULT_FORBIDDEN"));
  // A member removing another without changing the vault key (re-wrapping isn't revocation).
  const second = await party();
  const added = await changeMembers(state, f.vaultKey, await readAll(state, f.mem, f.vaultKey), { add: [second.member] }, f.device.signer, crypto);
  f.mem.apply(added);
  const s2 = await f.mem.open();
  const { sig: _s, ...head } = s2.chain.head;
  const sneaky = await signTrust({ ...head, seq: 2, prev: s2.chain.headHash, members: head.members.filter((m) => m.id !== second.member.id), signer: f.device.member.id }, f.device.signer.seed, crypto);
  await assert.rejects(verifyChain([...s2.chain.records, sneaky], crypto), /without changing the vault key/);
  // Skipping an epoch.
  const skip = await signTrust({ ...head, seq: 2, prev: s2.chain.headHash, epoch: 3, recipient: (await (await X25519Identity.generate(crypto)).recipient(crypto)).toString(), signer: f.device.member.id }, f.device.signer.seed, crypto);
  await assert.rejects(verifyChain([...s2.chain.records, skip], crypto), /skips/);
});

test("removing a device rotates the key: the removed device can't open the vault or sign for it", async () => {
  const f = await fixture();
  const second = await party();
  let state = await f.mem.open();
  f.mem.apply(await changeMembers(state, f.vaultKey, await readAll(state, f.mem, f.vaultKey), { add: [second.member] }, f.device.signer, crypto));
  state = await f.mem.open();
  await openKeyBundle(state, f.mem.objects.get(state.snapshot.keys)!, second.age, crypto); // a member now
  const removed = await changeMembers(state, f.vaultKey, await readAll(state, f.mem, f.vaultKey), { remove: [second.member.id] }, f.device.signer, crypto);
  f.mem.apply(removed);
  state = await f.mem.open();
  assert.equal(state.chain.head.epoch, 2);
  assert.notEqual(removed.vaultKey.toString(), f.vaultKey.toString());
  await assert.rejects(openKeyBundle(state, f.mem.objects.get(state.snapshot.keys)!, second.age, crypto), code("VAULT_FORBIDDEN"));
  // Every item is re-encrypted: the old vault key opens none of them.
  for (const r of state.snapshot.items) await assert.rejects(openItem(state, r, f.mem.objects.get(r.object)!, f.vaultKey, crypto));
  assert.equal((await readAll(state, f.mem, removed.vaultKey)).length, 2);
  // The removed device's signature no longer counts.
  const { sig: _s, ...body } = state.snapshot;
  const forged = structuredClone(f.mem.state);
  forged.snapshot = await signSnapshot({ ...body, seq: body.seq + 1, signer: second.member.id }, second.signer.seed, crypto);
  await assert.rejects(openState(enc(forged), crypto), code("VAULT_FORBIDDEN"));
});

test("a substituted key bundle is refused even under a valid signature", async () => {
  const f = await fixture();
  const state = await f.mem.open();
  // The members' recipients are public: anyone can wrap a vault key of their own choosing to them.
  const theirs = await X25519Identity.generate(crypto);
  const bundle = await sealKeyBundle({ v: 1, type: "keys", vault: f.vaultId, epoch: 1, identity: theirs.toString() }, state.chain.head.members, crypto);
  const h = await sha256Hex(bundle, crypto);
  const { sig: _s, ...body } = state.snapshot;
  const st = structuredClone(f.mem.state);
  st.snapshot = await signSnapshot({ ...body, keys: h }, f.device.signer.seed, crypto);
  const s = await openState(enc(st), crypto);
  await assert.rejects(openKeyBundle(s, bundle, f.device.age, crypto), /other than the one the trust chain names/);
});

test("rollback and forks are refused against the last accepted state", async () => {
  const f = await fixture();
  const older = await f.mem.open();
  const olderBytes = f.mem.bytes();
  const items = await readAll(older, f.mem, f.vaultKey);
  f.mem.apply(await writeItems(older, f.vaultKey, { put: [{ ...items[0], rev: 2 }] }, f.device.signer, crypto));
  const newer = await f.mem.open();
  await assert.rejects(openState(olderBytes, crypto, { pin: newer.pin }), code("VAULT_ROLLBACK"));
  // A different snapshot with the same number: a fork.
  const fork = await writeItems(older, f.vaultKey, { remove: [items[1].id] }, f.device.signer, crypto);
  await assert.rejects(openState(enc(fork.state), crypto, { pin: newer.pin }), code("VAULT_ROLLBACK"));
  // A shorter trust chain than the one accepted.
  const second = await party();
  const grown = await changeMembers(newer, f.vaultKey, await readAll(newer, f.mem, f.vaultKey), { add: [second.member] }, f.device.signer, crypto);
  const grownState = await openState(enc(grown.state), crypto);
  assert.throws(() => checkFresh(newer, grownState.pin), code("VAULT_ROLLBACK"));
  checkFresh(grownState, newer.pin); // moving forward is fine
});

test("encrypted objects interoperate with the reference age tool", async (t) => {
  if (spawnSync("age", ["--version"]).error) return t.skip("age isn't installed");
  const f = await fixture();
  const state = await f.mem.open();
  const dir = tmp();
  const write = (name: string, data: string | Uint8Array) => {
    fs.writeFileSync(path.join(dir, name), data);
    return path.join(dir, name);
  };
  const bundle = spawnSync("age", ["-d", "-i", write("device.txt", `${f.device.age.toString()}\n`), write("keys.age", f.mem.objects.get(state.snapshot.keys)!)], { encoding: "utf8" });
  assert.equal(bundle.status, 0, bundle.stderr);
  const vaultKey = JSON.parse(bundle.stdout).identity as string;
  const item = spawnSync("age", ["-d", "-i", write("vault.txt", `${vaultKey}\n`), write("item.age", f.mem.objects.get(state.snapshot.items[0].object)!)], { encoding: "utf8" });
  assert.equal(item.status, 0, item.stderr);
  assert.match(item.stdout, /^---\ngitroll_vault: 1\ntype: item\n/);
  // And the other way: an item the reference tool encrypted opens here, once a signed snapshot lists it.
  const plain = write("plain.md", encodeItem(f.vaultId, { ...f.a, rev: 2 }));
  const made = spawnSync("age", ["-r", state.chain.head.recipient, "-o", path.join(dir, "made.age"), plain], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  const bytes = new Uint8Array(fs.readFileSync(path.join(dir, "made.age")));
  const { sig: _s, ...body } = state.snapshot;
  const st = structuredClone(f.mem.state);
  const h = await sha256Hex(bytes, crypto);
  st.snapshot = await signSnapshot({ ...body, items: body.items.map((r) => (r.id === f.a.id ? { ...r, rev: 2, object: h } : r)) }, f.device.signer.seed, crypto);
  const s = await openState(enc(st), crypto);
  assert.equal((await openItem(s, s.snapshot.items.find((r) => r.id === f.a.id)!, bytes, f.vaultKey, crypto)).fields[1].value, "synthetic-password-1");
});

test("a passphrase-protected file can't ask for unbounded scrypt work", async () => {
  // Made cheaply at work factor 10, then relabelled 21: the limit is checked before any work (or the MAC).
  const made = new TextDecoder("latin1").decode(await encrypt(utf8("x"), [new ScryptRecipient("synthetic passphrase", 10)], crypto));
  const file = Uint8Array.from(made.replace(/^(-> scrypt \S+) 10$/m, "$1 21"), (c) => c.charCodeAt(0));
  await assert.rejects(decrypt(file, [new ScryptIdentity("synthetic passphrase")], crypto), /work factor/);
});

test("the synthetic fixture vault still opens: the on-disk format hasn't drifted", async () => {
  const dir = new URL("./fixtures/vault/", import.meta.url);
  const state = fs.readFileSync(new URL("state.json", dir));
  const kit = fs.readFileSync(new URL("recovery-kit.txt", dir), "utf8");
  const s = await openState(new Uint8Array(state), crypto);
  const age = X25519Identity.parse(/^age-identity: (\S+)$/m.exec(kit)![1]);
  const read = (h: string) => new Uint8Array(fs.readFileSync(new URL(`objects/${h}.age`, dir)));
  const key = await openKeyBundle(s, read(s.snapshot.keys), age, crypto);
  const items = await Promise.all(s.snapshot.items.map((r) => openItem(s, r, read(r.object), key, crypto)));
  assert.deepEqual(items.map((i) => i.title).sort(), ["Example API token", "Example login", "Example note"]);
  assert.equal(findItem(items, "Example login").fields.find((f) => f.name === "password")!.value, "synthetic-password-do-not-use");
  assert.equal(await recordHash(s.chain.records[0], crypto), s.vaultId);
  // Not every byte matters to the hash — but every byte of the signed records does.
  const parsed = JSON.parse(state.toString());
  parsed.snapshot.created = "2030-01-01T00:00:00Z";
  await assert.rejects(openState(utf8(JSON.stringify(parsed)), crypto), code("VAULT_TAMPERED"));
});
