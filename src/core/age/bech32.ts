// Bech32 (BIP 173), as age uses it for recipients (age1…) and identities
// (AGE-SECRET-KEY-1…). age lifts BIP 173's 90-character limit, and uses the
// original bech32 checksum constant (1), not bech32m.

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GENERATOR[i];
  }
  return chk >>> 0;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

function convertBits(data: ArrayLike<number>, from: number, to: number, pad: boolean): number[] | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const max = (1 << to) - 1;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v < 0 || v >> from) return null;
    acc = ((acc << from) | v) & 0xffff;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & max);
    }
  }
  if (pad) {
    if (bits) out.push((acc << (to - bits)) & max);
  } else if (bits >= from || ((acc << (to - bits)) & max)) {
    return null;
  }
  return out;
}

/** Encodes bytes under a human-readable part. The case of `hrp` is kept: age identities are upper case. */
export function bech32Encode(hrp: string, data: Uint8Array): string {
  const lower = hrp.toLowerCase();
  const words = convertBits(data, 8, 5, true)!;
  const mod = polymod([...hrpExpand(lower), ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >> (5 * (5 - i))) & 31);
  const out = `${lower}1${[...words, ...checksum].map((w) => CHARSET[w]).join("")}`;
  return hrp === hrp.toUpperCase() && hrp !== lower ? out.toUpperCase() : out;
}

/** Decodes a bech32 string, or returns null if it isn't valid (bad checksum, mixed case, bad padding). */
export function bech32Decode(text: string): { hrp: string; data: Uint8Array } | null {
  if (text !== text.toLowerCase() && text !== text.toUpperCase()) return null;
  const s = text.toLowerCase();
  const sep = s.lastIndexOf("1");
  if (sep < 1 || sep + 7 > s.length) return null;
  const hrp = s.slice(0, sep);
  for (let i = 0; i < hrp.length; i++) {
    const c = hrp.charCodeAt(i);
    if (c < 33 || c > 126) return null;
  }
  const words: number[] = [];
  for (const ch of s.slice(sep + 1)) {
    const v = CHARSET.indexOf(ch);
    if (v < 0) return null;
    words.push(v);
  }
  if (polymod([...hrpExpand(hrp), ...words]) !== 1) return null;
  const bytes = convertBits(words.slice(0, -6), 5, 8, false);
  if (!bytes) return null;
  return { hrp, data: Uint8Array.from(bytes) };
}
