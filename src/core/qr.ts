// QR codes (ISO/IEC 18004), small enough to write out here rather than depend on.
//
// What `gitroll label` needs and no more: byte mode (the text as UTF-8), error
// correction level M (about 15% of the code can be damaged), versions 1 to 10
// (21×21 to 57×57 modules, up to 213 bytes), and the mask chosen by the
// standard's penalty rules. Output is a matrix of modules, drawn as terminal
// block characters or as SVG.

export interface QrCode {
  version: number;
  /** Modules per side: 17 + 4 × version. */
  size: number;
  mask: number;
  /** modules[y][x]: true is dark. */
  modules: boolean[][];
}

// Level M, versions 1–10: [error correction codewords per block, blocks in group 1, data codewords in each, blocks in group 2, data codewords in each].
const BLOCKS: [number, number, number, number, number][] = [
  [10, 1, 16, 0, 0],
  [16, 1, 28, 0, 0],
  [26, 1, 44, 0, 0],
  [18, 2, 32, 0, 0],
  [24, 2, 43, 0, 0],
  [16, 4, 27, 0, 0],
  [18, 4, 31, 0, 0],
  [22, 2, 38, 2, 39],
  [22, 3, 36, 2, 37],
  [26, 4, 43, 1, 44],
];

const ALIGNMENT: number[][] = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

export const MAX_VERSION = BLOCKS.length;

/** Data codewords a version holds at level M. */
export function dataCapacity(version: number): number {
  const [, b1, d1, b2, d2] = BLOCKS[version - 1];
  return b1 * d1 + b2 * d2;
}

/** The most bytes a version holds in byte mode at level M. */
export function byteCapacity(version: number): number {
  return Math.floor((dataCapacity(version) * 8 - 4 - (version < 10 ? 8 : 16)) / 8);
}

// ── Reed–Solomon over GF(256), polynomial x^8 + x^4 + x^3 + x^2 + 1 ────────

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

const mul = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** The generator polynomial of a degree, highest power first (its leading 1 left out). */
function generator(degree: number): number[] {
  let g = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= mul(g[j], EXP[i]);
    }
    g = next;
  }
  return g.slice(1);
}

/** The error correction codewords for a block of data codewords. */
export function reedSolomon(data: number[], degree: number): number[] {
  const g = generator(degree);
  const rem = new Array<number>(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem.shift()!;
    rem.push(0);
    for (let i = 0; i < degree; i++) rem[i] ^= mul(g[i], factor);
  }
  return rem;
}

// ── Format and version information ─────────────────────────────────────────

/** The 15 format bits for level M and a mask: BCH(15,5) with generator 0x537, masked with 0x5412. */
export function formatBits(mask: number): number {
  const data = (0b00 << 3) | mask; // level M is 00
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** The 18 version bits (versions 7 and up): BCH(18,6) with generator 0x1F25. */
export function versionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

const bit = (x: number, i: number): boolean => ((x >>> i) & 1) !== 0;

// ── Encoding ───────────────────────────────────────────────────────────────

function utf8(text: string): number[] {
  return [...new TextEncoder().encode(text)];
}

/** The data codewords: mode, length, bytes, terminator and padding. */
export function dataCodewords(bytes: number[], version: number): number[] {
  const capacity = dataCapacity(version);
  const bits: number[] = [];
  const put = (value: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  if (bits.length > capacity * 8) throw new Error("too long for this version");
  put(0, Math.min(4, capacity * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; out.length < capacity; pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

/** Data and error correction codewords, split into blocks and interleaved as the symbol holds them. */
export function interleave(data: number[], version: number): number[] {
  const [ec, b1, d1, b2, d2] = BLOCKS[version - 1];
  const blocks: number[][] = [];
  let at = 0;
  for (let i = 0; i < b1 + b2; i++) {
    const n = i < b1 ? d1 : d2;
    blocks.push(data.slice(at, at + n));
    at += n;
  }
  const out: number[] = [];
  const longest = Math.max(d1, d2);
  for (let i = 0; i < longest; i++) for (const b of blocks) if (i < b.length) out.push(b[i]);
  const ecc = blocks.map((b) => reedSolomon(b, ec));
  for (let i = 0; i < ec; i++) for (const e of ecc) out.push(e[i]);
  return out;
}

class Matrix {
  size: number;
  modules: boolean[][];
  reserved: boolean[][];
  version: number;
  constructor(version: number) {
    this.version = version;
    this.size = 17 + 4 * version;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.reserved = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }
  set(x: number, y: number, dark: boolean) {
    this.modules[y][x] = dark;
    this.reserved[y][x] = true;
  }
  functionPatterns() {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    for (const [cx, cy] of [[3, 3], [n - 4, 3], [3, n - 4]]) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= n || y >= n) continue;
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          this.set(x, y, d !== 2 && d !== 4);
        }
      }
    }
    const at = ALIGNMENT[this.version - 1];
    const last = at.length - 1;
    for (let i = 0; i < at.length; i++) {
      for (let j = 0; j < at.length; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.set(at[i] + dx, at[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
    this.format(0); // reserves the format areas; written for real once a mask is chosen
    if (this.version >= 7) {
      const v = versionBits(this.version);
      for (let i = 0; i < 18; i++) {
        const a = n - 11 + (i % 3);
        const b = Math.floor(i / 3);
        this.set(a, b, bit(v, i));
        this.set(b, a, bit(v, i));
      }
    }
  }
  format(mask: number) {
    const n = this.size;
    const f = formatBits(mask);
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(f, i));
    this.set(8, 7, bit(f, 6));
    this.set(8, 8, bit(f, 7));
    this.set(7, 8, bit(f, 8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(f, i));
    for (let i = 0; i < 8; i++) this.set(n - 1 - i, 8, bit(f, i));
    for (let i = 8; i < 15; i++) this.set(8, n - 15 + i, bit(f, i));
    this.set(8, n - 8, true); // the dark module
  }
  place(codewords: number[]) {
    const n = this.size;
    let i = 0;
    for (let right = n - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      const upward = ((right + 1) & 2) === 0;
      for (let v = 0; v < n; v++) {
        const y = upward ? n - 1 - v : v;
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          if (this.reserved[y][x]) continue;
          if (i < codewords.length * 8) this.modules[y][x] = bit(codewords[i >>> 3], 7 - (i & 7));
          i++;
        }
      }
    }
  }
  mask(mask: number) {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (!this.reserved[y][x] && MASKS[mask](x, y)) this.modules[y][x] = !this.modules[y][x];
      }
    }
  }
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** The standard's penalty score for a finished symbol: lower is easier to read. */
export function penalty(m: boolean[][]): number {
  const n = m.length;
  let score = 0;
  const lines: boolean[][] = [...m, ...m[0].map((_, x) => m.map((row) => row[x]))];
  for (const line of lines) {
    // N1: five or more of one colour in a row.
    let run = 1;
    for (let i = 1; i <= n; i++) {
      if (i < n && line[i] === line[i - 1]) run++;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    // N3: 1:1:3:1:1 finder-like patterns with four light modules on one side (outside the symbol is light).
    const padded = [false, false, false, false, ...line, false, false, false, false];
    for (let i = 0; i + 11 <= padded.length; i++) {
      const w = padded.slice(i, i + 11).map((d) => (d ? 1 : 0)).join("");
      if (w === "10111010000" || w === "00001011101") score += 40;
    }
  }
  // N2: 2×2 blocks of one colour.
  for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) if (m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) score += 3;
  // N4: how far the dark proportion is from half, in steps of 5%.
  const dark = m.reduce((a, row) => a + row.filter(Boolean).length, 0);
  score += 10 * Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5);
  return score;
}

/**
 * Encodes text as a QR code: byte mode, level M, the smallest version from 1 to
 * 10 that holds it, and the mask with the lowest penalty (or the one given).
 */
export function encodeQr(text: string, opts: { version?: number; mask?: number } = {}): QrCode {
  const bytes = utf8(text);
  let version = opts.version ?? 0;
  if (!version) {
    for (let v = 1; v <= MAX_VERSION; v++) {
      if (bytes.length <= byteCapacity(v)) {
        version = v;
        break;
      }
    }
  }
  if (!version || version > MAX_VERSION || bytes.length > byteCapacity(version)) {
    throw new Error(`That is ${bytes.length} bytes; a QR code here holds at most ${byteCapacity(opts.version ?? MAX_VERSION)}.`);
  }
  const codewords = interleave(dataCodewords(bytes, version), version);
  let best: QrCode | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    if (opts.mask !== undefined && mask !== opts.mask) continue;
    const m = new Matrix(version);
    m.functionPatterns();
    m.place(codewords);
    m.mask(mask);
    m.format(mask);
    const score = opts.mask === undefined ? penalty(m.modules) : 0;
    if (score < bestScore) {
      bestScore = score;
      best = { version, size: m.size, mask, modules: m.modules };
    }
  }
  return best!;
}

/** Drawn with block characters, two rows of modules per line, with the four-module quiet zone. Dark modules are the ink. */
export function qrToText(qr: QrCode, quiet = 4): string {
  const n = qr.size + quiet * 2;
  const dark = (x: number, y: number) => x >= quiet && y >= quiet && x < qr.size + quiet && y < qr.size + quiet && qr.modules[y - quiet][x - quiet];
  const lines: string[] = [];
  for (let y = 0; y < n; y += 2) {
    let line = "";
    for (let x = 0; x < n; x++) {
      const top = dark(x, y);
      const bottom = y + 1 < n && dark(x, y + 1);
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(line);
  }
  return lines.join("\n");
}

/** An SVG image: a white square and one path of dark modules, with the quiet zone. */
export function qrToSvg(qr: QrCode, opts: { quiet?: number; scale?: number; title?: string } = {}): string {
  const quiet = opts.quiet ?? 4;
  const n = qr.size + quiet * 2;
  const px = n * (opts.scale ?? 8);
  let d = "";
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (!qr.modules[y][x]) continue;
      let run = 1;
      while (x + run < qr.size && qr.modules[y][x + run]) run++;
      d += `M${x + quiet} ${y + quiet}h${run}v1h-${run}z`;
      x += run - 1;
    }
  }
  const title = opts.title ? `<title>${opts.title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</title>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${px}" height="${px}" shape-rendering="crispEdges">${title}<rect width="${n}" height="${n}" fill="#fff"/><path fill="#000" d="${d}"/></svg>\n`;
}
