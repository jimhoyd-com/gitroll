// The handful of primitives the age format needs, injected by the platform.
//
// The format code in this folder never touches a crypto library directly. Node
// backs this interface with its built-in `crypto` module (src/node/age-crypto.ts);
// a browser can back it with WebCrypto and a small audited library for the
// pieces WebCrypto lacks (ChaCha20-Poly1305, scrypt). Every method may return
// a value or a promise of one, so either kind of backend fits.

type Maybe<T> = T | Promise<T>;

export interface AgeCrypto {
  /** Cryptographically secure random bytes. */
  randomBytes(length: number): Maybe<Uint8Array>;
  /** X25519(scalar, point) (RFC 7748). May throw, or return all zeros, for a low-order point. */
  x25519(scalar: Uint8Array, point: Uint8Array): Maybe<Uint8Array>;
  /** X25519(scalar, 9): the public key for a secret scalar. */
  x25519Base(scalar: Uint8Array): Maybe<Uint8Array>;
  /** HKDF-SHA-256 (RFC 5869). */
  hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Maybe<Uint8Array>;
  /** HMAC-SHA-256. */
  hmacSha256(key: Uint8Array, data: Uint8Array): Maybe<Uint8Array>;
  /** ChaCha20-Poly1305 (RFC 8439) with no associated data: ciphertext followed by the 16-byte tag. */
  seal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array): Maybe<Uint8Array>;
  /** The reverse of `seal`; null when the tag doesn't verify. */
  open(key: Uint8Array, nonce: Uint8Array, sealed: Uint8Array): Maybe<Uint8Array | null>;
  /** scrypt with N = 2^logN, r = 8, p = 1. */
  scrypt(password: Uint8Array, salt: Uint8Array, logN: number, length: number): Maybe<Uint8Array>;
}
