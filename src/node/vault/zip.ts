// Reads one named file out of a zip archive (a 1Password .1pux export) without
// extracting anything to disk. Only stored and deflated entries, no zip64, no
// encryption; sizes and the compression ratio are bounded and the CRC is
// checked, so a hostile archive can't make it read past its end or expand
// without limit.

import zlib from "node:zlib";
import { UserError } from "../../core/util.ts";

const bad = (message: string): never => {
  throw new UserError(message);
};

let table: Int32Array | null = null;
function crc32(data: Uint8Array): number {
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < data.length; i++) c = table[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

export interface ZipEntry {
  name: string;
  method: number;
  compressed: number;
  size: number;
  crc: number;
  offset: number;
}

/** The archive's entries, from its central directory. */
export function zipEntries(file: Uint8Array): ZipEntry[] {
  const b = Buffer.from(file.buffer, file.byteOffset, file.byteLength);
  // The end-of-central-directory record is in the last 64 KiB + 22 bytes.
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--) {
    if (b.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) bad("That isn't a zip archive (a .1pux export is one).");
  const count = b.readUInt16LE(eocd + 10);
  const size = b.readUInt32LE(eocd + 12);
  let at = b.readUInt32LE(eocd + 16);
  if (count === 0xffff || at === 0xffffffff || at + size > eocd) bad("That archive is zip64 or damaged, which GitRoll doesn't read.");
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (at + 46 > eocd || b.readUInt32LE(at) !== 0x02014b50) bad("That archive's directory is damaged.");
    const flags = b.readUInt16LE(at + 8);
    const nameLen = b.readUInt16LE(at + 28);
    const extraLen = b.readUInt16LE(at + 30);
    const commentLen = b.readUInt16LE(at + 32);
    const name = b.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    if (flags & 1) bad("That archive is encrypted.");
    out.push({ name, method: b.readUInt16LE(at + 10), crc: b.readUInt32LE(at + 16), compressed: b.readUInt32LE(at + 20), size: b.readUInt32LE(at + 24), offset: b.readUInt32LE(at + 42) });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** One entry's bytes, by its exact name, or null when the archive has none. */
export function readZipEntry(file: Uint8Array, name: string, maxSize: number): Uint8Array | null {
  const entry = zipEntries(file).find((e) => e.name === name);
  if (!entry) return null;
  const b = Buffer.from(file.buffer, file.byteOffset, file.byteLength);
  if (entry.size > maxSize) bad(`${name} in that archive is larger than GitRoll reads (${Math.round(maxSize / 1024 / 1024)} MiB).`);
  if (entry.offset + 30 > b.length || b.readUInt32LE(entry.offset) !== 0x04034b50) bad("That archive is damaged.");
  const start = entry.offset + 30 + b.readUInt16LE(entry.offset + 26) + b.readUInt16LE(entry.offset + 28);
  const raw = b.subarray(start, start + entry.compressed);
  if (raw.length !== entry.compressed) bad("That archive is cut short.");
  let data: Buffer;
  if (entry.method === 0) data = Buffer.from(raw);
  else if (entry.method === 8) {
    try {
      data = zlib.inflateRawSync(raw, { maxOutputLength: maxSize });
    } catch {
      return bad(`${name} in that archive doesn't decompress, or is larger than GitRoll reads.`);
    }
  } else return bad("That archive uses a compression GitRoll doesn't read.");
  if (data.length !== entry.size || crc32(data) !== entry.crc) bad(`${name} in that archive is damaged (its checksum doesn't match).`);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
