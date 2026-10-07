// The QR encoder (ISO/IEC 18004): byte mode, level M, versions 1–10.

import assert from "node:assert/strict";
import { test } from "node:test";
import { byteCapacity, dataCodewords, encodeQr, formatBits, interleave, penalty, qrToSvg, qrToText, reedSolomon, versionBits } from "../src/core/qr.ts";

test("Reed–Solomon codewords match the standard's worked example (version 1-M, \"01234567\")", () => {
  // ISO/IEC 18004 Annex I: the 16 data codewords and the 10 error correction codewords it gives.
  const data = [0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11];
  assert.deepEqual(reedSolomon(data, 10), [0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55]);
});

test("format and version information are the standard's BCH codes", () => {
  assert.equal(formatBits(0).toString(2).padStart(15, "0"), "101010000010010", "M, mask 0 is the mask pattern itself");
  assert.equal(formatBits(5).toString(2).padStart(15, "0"), "100000011001110", "the standard's example: M, mask 101");
  assert.equal(versionBits(7).toString(2).padStart(18, "0"), "000111110010010100", "the standard's example: version 7");
  assert.equal(versionBits(10).toString(2).padStart(18, "0"), "001010010011010011");
});

test("byte mode: mode indicator, length, data, terminator and the 0xEC 0x11 padding", () => {
  const cw = dataCodewords([...new TextEncoder().encode("hi")], 1);
  assert.equal(cw.length, 16);
  // 0100 | 00000010 | 01101000 01101001 | 0000, then pad bytes.
  assert.deepEqual(cw.slice(0, 4), [0b01000000, 0b00100110, 0b10000110, 0b10010000]);
  assert.deepEqual(cw.slice(4, 8), [0xec, 0x11, 0xec, 0x11]);
  const ten = dataCodewords(new Array(10).fill(65), 10);
  assert.equal(ten[0], 0b01000000, "version 10 has a 16-bit length");
  assert.equal(ten[1], 0);
  assert.equal(ten[2], 0b10100100);
  assert.equal(interleave(dataCodewords([1, 2, 3], 5), 5).length, 134, "version 5 holds 134 codewords");
});

test("the smallest version that holds the text is chosen, up to version 10", () => {
  const caps = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213];
  assert.deepEqual(caps.map((_, i) => byteCapacity(i + 1)), caps);
  for (const [i, cap] of caps.entries()) {
    assert.equal(encodeQr("a".repeat(cap)).version, i + 1);
    if (i < 9) assert.equal(encodeQr("a".repeat(cap + 1)).version, i + 2);
  }
  assert.throws(() => encodeQr("a".repeat(214)), /214 bytes/);
  assert.equal(encodeQr("é".repeat(7)).version, 1, "bytes, not characters: 14 bytes of UTF-8");
  assert.equal(encodeQr("é".repeat(8)).version, 2);
});

// "gitroll", version 1-M, mask 2, as an independent encoder draws it.
const KNOWN = [
  "#######..#.#..#######",
  "#.....#..#....#.....#",
  "#.###.#.#..##.#.###.#",
  "#.###.#.#.....#.###.#",
  "#.###.#.#.#.#.#.###.#",
  "#.....#.#..#..#.....#",
  "#######.#.#.#.#######",
  "........##...........",
  "#.#####...##..#####..",
  ".###.#..#.######....#",
  "#######.....#.##.###.",
  "##..#...#..#####.####",
  ".#.#..##.#..#...##.#.",
  "........##..#..####.#",
  "#######..#.#.#....##.",
  "#.....#.##.....#.####",
  "#.###.#.##.#.#..##.#.",
  "#.###.#.#.#######.#..",
  "#.###.#.#...#.#......",
  "#.....#....####.###..",
  "#######.###.#...#..#.",
];
const draw = (m: boolean[][]) => m.map((r) => r.map((d) => (d ? "#" : ".")).join(""));

test("a short string comes out module for module as the known matrix", () => {
  const qr = encodeQr("gitroll", { mask: 2 });
  assert.equal(qr.version, 1);
  assert.equal(qr.size, 21);
  assert.deepEqual(draw(qr.modules), KNOWN);
});

/** Reads the 15 format bits back from both copies in a matrix. */
function readFormat(m: boolean[][]): [number, number] {
  const n = m.length;
  const b = (x: number, y: number) => (m[y][x] ? 1 : 0);
  let a = 0;
  let c = 0;
  const first = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
  first.forEach(([x, y], i) => (a |= b(x, y) << i));
  for (let i = 0; i < 8; i++) c |= b(n - 1 - i, 8) << i;
  for (let i = 8; i < 15; i++) c |= b(8, n - 15 + i) << i;
  return [a, c];
}

test("every version and mask lays out finders, timing, the dark module, format and version bits", () => {
  for (let version = 1; version <= 10; version++) {
    for (let mask = 0; mask < 8; mask++) {
      const qr = encodeQr(".gitroll/notes/x".slice(0, 1 + version), { version, mask });
      const m = qr.modules;
      const n = qr.size;
      assert.equal(n, 17 + 4 * version);
      for (const [ox, oy] of [[0, 0], [n - 7, 0], [0, n - 7]]) {
        for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
          const ring = Math.max(Math.abs(x - 3), Math.abs(y - 3));
          assert.equal(m[oy + y][ox + x], ring !== 2, `finder at ${ox},${oy}`);
        }
      }
      for (let i = 8; i < n - 8; i++) {
        assert.equal(m[6][i], i % 2 === 0, "horizontal timing");
        assert.equal(m[i][6], i % 2 === 0, "vertical timing");
      }
      assert.equal(m[n - 8][8], true, "the dark module");
      const [a, c] = readFormat(m);
      assert.equal(a, formatBits(mask));
      assert.equal(c, formatBits(mask));
      if (version >= 7) {
        let v1 = 0;
        let v2 = 0;
        for (let i = 0; i < 18; i++) {
          v1 |= (m[Math.floor(i / 3)][n - 11 + (i % 3)] ? 1 : 0) << i;
          v2 |= (m[n - 11 + (i % 3)][Math.floor(i / 3)] ? 1 : 0) << i;
        }
        assert.equal(v1, versionBits(version));
        assert.equal(v2, versionBits(version));
      }
    }
  }
});

test("the mask chosen is the one with the lowest penalty", () => {
  for (const text of ["gitroll", ".gitroll/notes/inventory/garage-heat-pump.md", "x".repeat(150)]) {
    const chosen = encodeQr(text);
    const scores = Array.from({ length: 8 }, (_, mask) => penalty(encodeQr(text, { mask }).modules));
    assert.equal(penalty(chosen.modules), Math.min(...scores));
    assert.equal(chosen.mask, scores.indexOf(Math.min(...scores)));
  }
});

test("drawn as block characters and as SVG, with a quiet zone", () => {
  const qr = encodeQr("gitroll", { mask: 2 });
  const lines = qrToText(qr).split("\n");
  assert.equal(lines.length, Math.ceil((21 + 8) / 2));
  assert.ok(lines.every((l) => [...l].length === 29));
  assert.equal(lines[0].trim(), "", "quiet zone");
  assert.equal([...lines[2]].slice(4, 11).join(""), "█▀▀▀▀▀█", "rows 4 and 5: the finder's top edge");
  const svg = qrToSvg(qr, { title: "A <b> & c" });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 29 29"/);
  assert.match(svg, /<title>A &lt;b&gt; &amp; c<\/title>/);
  assert.match(svg, /d="M4 4h7v1h-7z/);
});
