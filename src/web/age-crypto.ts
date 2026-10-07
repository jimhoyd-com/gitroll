// The age format's crypto primitives in a browser (see src/core/age/crypto.ts).
//
// WebCrypto does what it can: random bytes, HKDF, HMAC, and X25519 where the
// browser has it. What WebCrypto lacks comes from the audited @noble libraries:
// ChaCha20-Poly1305 always, scrypt for passphrase files, and X25519 in a
// browser that doesn't offer it yet.
//
// Only the browser bundle imports this file, so the @noble packages never reach
// the command line's bundle (dist/gitroll.mjs), which has no runtime
// dependencies. Like React, they are development dependencies here and are
// bundled into the web app.

import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 as nobleX25519 } from "@noble/curves/ed25519.js";
import { scryptAsync } from "@noble/hashes/scrypt.js";
import type { AgeCrypto } from "../core/age/crypto.ts";

// RFC 8410 DER prefix that wraps a raw 32-byte X25519 private key, because
// WebCrypto imports X25519 private keys only as PKCS #8 or JWK.
const PKCS8_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20]);
// The X25519 base point, u = 9.
const BASE_POINT = (() => {
  const b = new Uint8Array(32);
  b[0] = 9;
  return b;
})();

/** A copy in an ArrayBuffer of its own: what WebCrypto's typed signatures want. */
const buf = (b: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(b);

export interface BrowserAgeCryptoOptions {
  /** The WebCrypto to use; the global one by default. */
  crypto?: Crypto;
  /** "auto" (the default) uses WebCrypto's X25519 when the browser has it and @noble/curves otherwise. */
  x25519?: "auto" | "webcrypto" | "noble";
}

async function webX25519(subtle: SubtleCrypto, scalar: Uint8Array, point: Uint8Array): Promise<Uint8Array> {
  const pkcs8 = new Uint8Array(PKCS8_PREFIX.length + 32);
  pkcs8.set(PKCS8_PREFIX);
  pkcs8.set(scalar, PKCS8_PREFIX.length);
  const priv = await subtle.importKey("pkcs8", pkcs8, { name: "X25519" }, false, ["deriveBits"]);
  const pub = await subtle.importKey("raw", buf(point), { name: "X25519" }, false, []);
  // Throws for a low-order point, which the interface allows.
  return new Uint8Array(await subtle.deriveBits({ name: "X25519", public: pub } as EcdhKeyDeriveParams, priv, 256));
}

/** True when this WebCrypto computes X25519 correctly (checked once, against a known answer). */
async function hasWebX25519(subtle: SubtleCrypto): Promise<boolean> {
  try {
    const scalar = new Uint8Array(32).fill(7);
    const got = await webX25519(subtle, scalar, BASE_POINT);
    const want = nobleX25519.getPublicKey(scalar);
    return got.length === 32 && got.every((b, i) => b === want[i]);
  } catch {
    return false;
  }
}

/** age's crypto for a browser (or any runtime with WebCrypto). */
export function browserAgeCrypto(options: BrowserAgeCryptoOptions = {}): AgeCrypto {
  const webcrypto = options.crypto ?? globalThis.crypto;
  const subtle = webcrypto.subtle;
  const mode = options.x25519 ?? "auto";
  let useWeb: Promise<boolean> | null = mode === "auto" ? null : Promise.resolve(mode === "webcrypto");
  const web = () => (useWeb ??= hasWebX25519(subtle));

  const x25519 = async (scalar: Uint8Array, point: Uint8Array) =>
    (await web()) ? webX25519(subtle, scalar, point) : nobleX25519.getSharedSecret(scalar, point);

  return {
    randomBytes(length) {
      const out = new Uint8Array(length);
      // getRandomValues fills at most 64 KiB per call.
      for (let at = 0; at < length; at += 65536) webcrypto.getRandomValues(out.subarray(at, Math.min(length, at + 65536)));
      return out;
    },
    x25519,
    x25519Base: (scalar) => x25519(scalar, BASE_POINT),
    async hkdf(ikm, salt, info, length) {
      const key = await subtle.importKey("raw", buf(ikm), "HKDF", false, ["deriveBits"]);
      return new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: buf(salt), info: buf(info) }, key, length * 8));
    },
    async hmacSha256(key, data) {
      const k = await subtle.importKey("raw", buf(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      return new Uint8Array(await subtle.sign("HMAC", k, buf(data)));
    },
    seal: (key, nonce, plaintext) => chacha20poly1305(key, nonce).encrypt(plaintext),
    open(key, nonce, sealed) {
      if (sealed.length < 16) return null;
      try {
        return chacha20poly1305(key, nonce).decrypt(sealed);
      } catch {
        return null;
      }
    },
    scrypt: (password, salt, logN, length) => scryptAsync(password, salt, { N: 2 ** logN, r: 8, p: 1, dkLen: length, maxmem: 128 * 2 ** logN * 8 + 64 * 1024 * 1024 }),
  };
}
