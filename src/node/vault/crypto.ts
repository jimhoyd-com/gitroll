// Node's built-in crypto behind the vault's crypto interface: age's primitives
// (../age-crypto.ts) plus SHA-256 and Ed25519. No dependencies.

import crypto from "node:crypto";
import { nodeAgeCrypto } from "../age-crypto.ts";
import type { VaultCrypto } from "../../core/vault/crypto.ts";

// DER prefixes that wrap a raw 32-byte Ed25519 key (RFC 8410).
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const privateKey = (seed: Uint8Array) => {
  if (seed.length !== 32) throw new Error("An Ed25519 seed is 32 bytes.");
  return crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
};
const bytes = (b: Buffer): Uint8Array => new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

export const nodeVaultCrypto: VaultCrypto = {
  ...nodeAgeCrypto,
  sha256: (data) => bytes(crypto.createHash("sha256").update(data).digest()),
  ed25519Public: (seed) => {
    const der = crypto.createPublicKey(privateKey(seed)).export({ format: "der", type: "spki" });
    return bytes(der.subarray(der.length - 32));
  },
  ed25519Sign: (seed, message) => bytes(crypto.sign(null, message, privateKey(seed))),
  ed25519Verify: (publicKey, message, signature) => {
    if (publicKey.length !== 32 || signature.length !== 64) return false;
    try {
      const key = crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, publicKey]), format: "der", type: "spki" });
      return crypto.verify(null, message, key, signature);
    } catch {
      return false;
    }
  },
};
