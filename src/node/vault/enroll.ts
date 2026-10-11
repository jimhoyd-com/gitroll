// Adding a device to a vault, in three steps, none of which trusts the
// repository to say who the members are:
//
//   1. On the new device:     gitroll vault device-request
//      prints a request: the device's two public keys, and a short code.
//   2. On a member device:    gitroll vault device-add personal <request>
//      shows the same short code to compare, adds the device in a new signed
//      trust record, re-wraps the vault key to it, and prints a checkpoint.
//   3. On the new device, after syncing the Roll:
//                             gitroll vault device-join personal <checkpoint>
//      verifies the vault against the checkpoint (vault id, trust record and
//      snapshot hashes) and remembers it as the first state it accepted.
//
// The request and checkpoint are public: they carry keys and hashes, not
// secrets. What matters is that each reaches the other device intact, which is
// why the short code is compared by a person.

import { base64, fromUtf8, utf8 } from "../../core/age/bytes.ts";
import { isRecipient } from "../../core/age/format.ts";
import { ID, VaultError, canonicalJson, hex } from "../../core/vault/format.ts";
import type { Member, Pin, VerifiedState } from "../../core/vault/format.ts";
import { nodeVaultCrypto } from "./crypto.ts";

const REQUEST = "gitroll-vault-device:";
const CHECKPOINT = "gitroll-vault-checkpoint:";
const HASH = /^[0-9a-f]{64}$/;

const b64url = (text: string) => base64(utf8(text)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function unb64url(text: string): unknown {
  try {
    const std = text.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(std + "=".repeat((4 - (std.length % 4)) % 4));
    return JSON.parse(fromUtf8(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  } catch {
    return null;
  }
}

/** Four groups of four characters to read aloud and compare on both screens. */
export async function shortCode(text: string): Promise<string> {
  const h = hex(await nodeVaultCrypto.sha256(utf8(text))).slice(0, 16).toUpperCase();
  return h.match(/.{4}/g)!.join("-");
}

export function encodeRequest(member: Member): string {
  return REQUEST + b64url(canonicalJson({ v: 1, id: member.id, age: member.age, sign: member.sign }));
}

export function decodeRequest(text: string): Member {
  const t = text.trim();
  const o = t.startsWith(REQUEST) ? (unb64url(t.slice(REQUEST.length)) as Record<string, unknown> | null) : null;
  if (!o || o.v !== 1 || typeof o.id !== "string" || !ID.test(o.id) || typeof o.age !== "string" || !isRecipient(o.age) || typeof o.sign !== "string") {
    throw new VaultError("VAULT_INVALID", "That isn't a device request. On the new device, run: gitroll vault device-request");
  }
  return { id: o.id, role: "device", age: o.age, sign: o.sign };
}

export interface Checkpoint {
  name: string;
  vault: string;
  pin: Pin;
}

export function checkpointFor(name: string, state: VerifiedState): string {
  return CHECKPOINT + b64url(canonicalJson({ v: 1, name, vault: state.vaultId, trust: state.pin.trust, snapshot: state.pin.snapshot }));
}

export function decodeCheckpoint(text: string): Checkpoint {
  const t = text.trim();
  const o = t.startsWith(CHECKPOINT) ? (unb64url(t.slice(CHECKPOINT.length)) as Record<string, any> | null) : null;
  const point = (p: any) => p && Number.isSafeInteger(p.seq) && p.seq >= 0 && typeof p.hash === "string" && HASH.test(p.hash);
  if (!o || o.v !== 1 || typeof o.name !== "string" || typeof o.vault !== "string" || !HASH.test(o.vault) || !point(o.trust) || !point(o.snapshot)) {
    throw new VaultError("VAULT_INVALID", "That isn't a vault checkpoint. The device that added this one printed it.");
  }
  return { name: o.name, vault: o.vault, pin: { trust: { seq: o.trust.seq, hash: o.trust.hash }, snapshot: { seq: o.snapshot.seq, hash: o.snapshot.hash } } };
}
