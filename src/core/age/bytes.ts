// Byte helpers for the age format. Platform-free: plain Uint8Array throughout.

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export const utf8 = (text: string): Uint8Array => encoder.encode(text);
export const fromUtf8 = (bytes: Uint8Array): string => decoder.decode(bytes);

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Constant-time comparison of two byte strings of the same length. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const LOOKUP = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET.charCodeAt(i)] = i;

/** Standard base64 (RFC 4648 §4). `pad: false` is the unpadded form age uses in headers. */
export function base64(bytes: Uint8Array, pad = true): string {
  let out = "";
  let i = 0;
  for (; i + 3 <= bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + ALPHABET[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63] + (pad ? "==" : "");
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + (pad ? "=" : "");
  }
  return out;
}

/**
 * Strict base64 decoding: only canonical encodings are accepted, as the age
 * spec requires (unused bits must be zero, padding exactly as `pad` says).
 * Returns null for anything else.
 */
export function unbase64(text: string, pad = true): Uint8Array | null {
  let s = text;
  if (pad) {
    if (s.length % 4 !== 0) return null;
    if (s.endsWith("==")) s = s.slice(0, -2);
    else if (s.endsWith("=")) s = s.slice(0, -1);
  } else if (s.length % 4 === 1) return null;
  if (s.includes("=")) return null;
  if (s.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let at = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const v = c < 128 ? LOOKUP[c] : -1;
    if (v < 0) return null;
    buffer = ((buffer << 6) | v) & 0x3fff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (buffer >> bits) & 0xff;
    }
  }
  // Leftover bits must be zero, or two encodings would mean the same bytes.
  if (bits && (buffer & ((1 << bits) - 1)) !== 0) return null;
  return out;
}
