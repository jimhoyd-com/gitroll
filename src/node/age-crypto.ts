// Node's built-in crypto behind the age format's crypto interface. No dependencies.

import crypto from "node:crypto";
import type { AgeCrypto } from "../core/age/crypto.ts";

// DER prefixes that wrap a raw 32-byte X25519 key (RFC 8410), so raw keys can
// become KeyObjects on every Node version this supports.
const PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

const privateKey = (scalar: Uint8Array) => crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, scalar]), format: "der", type: "pkcs8" });
const publicKey = (point: Uint8Array) => crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, point]), format: "der", type: "spki" });
const bytes = (b: Buffer | ArrayBuffer): Uint8Array => new Uint8Array(b instanceof ArrayBuffer ? b : b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

export const nodeAgeCrypto: AgeCrypto = {
  randomBytes: (length) => bytes(crypto.randomBytes(length)),
  x25519: (scalar, point) => bytes(crypto.diffieHellman({ privateKey: privateKey(scalar), publicKey: publicKey(point) })),
  x25519Base: (scalar) => {
    const der = crypto.createPublicKey(privateKey(scalar)).export({ format: "der", type: "spki" });
    return bytes(der.subarray(der.length - 32));
  },
  hkdf: (ikm, salt, info, length) => bytes(crypto.hkdfSync("sha256", ikm, salt, info, length)),
  hmacSha256: (key, data) => bytes(crypto.createHmac("sha256", key).update(data).digest()),
  seal: (key, nonce, plaintext) => {
    const cipher = crypto.createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
    return bytes(Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]));
  },
  open: (key, nonce, sealed) => {
    if (sealed.length < 16) return null;
    const decipher = crypto.createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
    decipher.setAuthTag(sealed.subarray(sealed.length - 16));
    try {
      return bytes(Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]));
    } catch {
      return null;
    }
  },
  scrypt: (password, salt, logN, length) => {
    const N = 2 ** logN;
    return bytes(crypto.scryptSync(password, salt, length, { N, r: 8, p: 1, maxmem: 128 * N * 8 + 64 * 1024 * 1024 }));
  },
};
