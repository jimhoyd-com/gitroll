// The primitives a vault needs beyond age's, injected by the platform like
// age's own (../age/crypto.ts). Node backs them with its built-in crypto
// (src/node/vault/crypto.ts). Nothing here implements a primitive.

import type { AgeCrypto } from "../age/crypto.ts";

type Maybe<T> = T | Promise<T>;

export interface VaultCrypto extends AgeCrypto {
  /** SHA-256. */
  sha256(data: Uint8Array): Maybe<Uint8Array>;
  /** The Ed25519 public key (32 bytes) for a 32-byte private seed (RFC 8032). */
  ed25519Public(seed: Uint8Array): Maybe<Uint8Array>;
  /** An Ed25519 signature (64 bytes) of `message`. */
  ed25519Sign(seed: Uint8Array, message: Uint8Array): Maybe<Uint8Array>;
  /** True only when `signature` is a valid Ed25519 signature of `message` by `publicKey`. Never throws. */
  ed25519Verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): Maybe<boolean>;
}
