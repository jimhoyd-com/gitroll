// KeePass's KDBX 4 container: reading one to import its entries, and writing
// one to export a vault. The format is KeePass's own (keepass.info/help/kb/
// kdbx_4.html); the primitives are Node's (AES-256-CBC, ChaCha20, SHA-256,
// SHA-512, HMAC, gzip) and the audited @noble/hashes for Argon2, which Node 20
// and 22 lack. What the XML inside means is src/core/vault/interop.ts.
//
// Read: the header's SHA-256 and HMAC, then every block's HMAC, are checked
// before anything is decrypted, so a wrong password or a damaged file is
// reported as such and never half-read. KDBX 3, Twofish, Salsa20 inner streams
// and key files are refused with a way forward rather than guessed at.

import crypto from "node:crypto";
import zlib from "node:zlib";
import { argon2d, argon2id } from "@noble/hashes/argon2.js";
import { parseXml } from "../../core/vault/xml.ts";
import type { XmlElement } from "../../core/vault/xml.ts";
import { UserError } from "../../core/util.ts";

const SIG1 = 0x9aa2d903;
const SIG2 = 0xb54bfb67;
const CIPHER = { aes256: "31c1f2e6bf714350be5805216afc5aff", chacha20: "d6038a2b8b6f4cb5a524339a31dbb59a", twofish: "ad68f29f576f4bb9a36ad47af965346c" };
const KDF = { aes: "c9d9f39a628a4460bf740d08c18a4fea", argon2d: "ef636ddf8c29444b91f7a9a403e30a0c", argon2id: "9e298b1956db4773b23dfc3ec6f0a1e6" };
/** Bounds on what a file may ask this computer to do before its password is even checked. */
const MAX = { argonMemory: 1024 * 1024 * 1024, argonPasses: 1000, aesRounds: 200_000_000, plain: 512 * 1024 * 1024, block: 64 * 1024 * 1024 };

const sha256 = (...parts: Uint8Array[]) => crypto.createHash("sha256").update(Buffer.concat(parts)).digest();
const sha512 = (...parts: Uint8Array[]) => crypto.createHash("sha512").update(Buffer.concat(parts)).digest();
const hmac = (key: Uint8Array, ...parts: Uint8Array[]) => crypto.createHmac("sha256", key).update(Buffer.concat(parts)).digest();
const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const bad = (message: string): never => {
  throw new UserError(message);
};

// ── VariantDictionary (KDF parameters) ───────────────────────────────────

type Variant = number | bigint | boolean | string | Buffer;
function readVariants(b: Buffer): Map<string, Variant> {
  const out = new Map<string, Variant>();
  if (b.length < 2 || b[1] !== 1) bad("This KeePass file's key settings are in a version GitRoll doesn't read.");
  let i = 2;
  for (;;) {
    if (i >= b.length) bad("This KeePass file's key settings are damaged.");
    const type = b[i++];
    if (type === 0) break;
    const nameLen = b.readUInt32LE(i);
    const name = b.subarray(i + 4, i + 4 + nameLen).toString("utf8");
    i += 4 + nameLen;
    const len = b.readUInt32LE(i);
    const v = b.subarray(i + 4, i + 4 + len);
    if (v.length !== len) bad("This KeePass file's key settings are damaged.");
    i += 4 + len;
    out.set(name, type === 0x04 ? v.readUInt32LE() : type === 0x05 ? v.readBigUInt64LE() : type === 0x08 ? v[0] !== 0 : type === 0x0c ? v.readInt32LE() : type === 0x0d ? v.readBigInt64LE() : type === 0x18 ? v.toString("utf8") : Buffer.from(v));
  }
  return out;
}

function writeVariants(entries: [string, number, Buffer][]): Buffer {
  const parts: Buffer[] = [Buffer.from([0x00, 0x01])];
  for (const [name, type, value] of entries) parts.push(Buffer.from([type]), u32(Buffer.byteLength(name)), Buffer.from(name), u32(value.length), value);
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

// ── Keys ─────────────────────────────────────────────────────────────────

function transformKey(composite: Buffer, kdf: Map<string, Variant>): Buffer {
  const uuid = kdf.get("$UUID");
  const id = Buffer.isBuffer(uuid) ? uuid.toString("hex") : "";
  const salt = kdf.get("S");
  if (!Buffer.isBuffer(salt)) return bad("This KeePass file's key settings have no salt.");
  if (id === KDF.aes) {
    const rounds = kdf.get("R");
    if (typeof rounds !== "bigint" || rounds > BigInt(MAX.aesRounds)) return bad("This KeePass file asks for more AES-KDF rounds than GitRoll will run.");
    const cipher = crypto.createCipheriv("aes-256-ecb", salt, null).setAutoPadding(false);
    let key: Buffer = composite;
    for (let r = 0n; r < rounds; r++) key = cipher.update(key);
    return sha256(key);
  }
  if (id === KDF.argon2d || id === KDF.argon2id) {
    const [m, t, p, v] = [kdf.get("M"), kdf.get("I"), kdf.get("P"), kdf.get("V")];
    if (typeof m !== "bigint" || typeof t !== "bigint" || typeof p !== "number" || typeof v !== "number") return bad("This KeePass file's Argon2 settings are incomplete.");
    if (m > BigInt(MAX.argonMemory) || t > BigInt(MAX.argonPasses) || p < 1 || p > 64 || m < 8n * 1024n) return bad("This KeePass file's Argon2 settings are outside what GitRoll will run (at most 1 GiB and 1000 passes).");
    const secret = kdf.get("K");
    const assoc = kdf.get("A");
    const opts = {
      t: Number(t),
      m: Number(m / 1024n),
      p,
      version: v,
      dkLen: 32,
      maxmem: MAX.argonMemory + 1024 * 1024,
      ...(Buffer.isBuffer(secret) && secret.length ? { key: secret } : {}),
      ...(Buffer.isBuffer(assoc) && assoc.length ? { personalization: assoc } : {}),
    };
    return Buffer.from((id === KDF.argon2d ? argon2d : argon2id)(composite, salt, opts));
  }
  return bad("This KeePass file uses a key derivation GitRoll doesn't know.");
}

const blockKey = (base: Buffer, index: bigint) => sha512(u64(index), base);

// ── Reading ──────────────────────────────────────────────────────────────

export interface KdbxContents {
  root: XmlElement;
  /** How many attachments the inner header holds (they aren't imported). */
  binaries: number;
}

export function readKdbx(file: Uint8Array, password: string): KdbxContents {
  const b = Buffer.from(file.buffer, file.byteOffset, file.byteLength);
  if (b.length < 12 || b.readUInt32LE(0) !== SIG1 || b.readUInt32LE(4) !== SIG2) bad("That isn't a KeePass database (.kdbx).");
  const major = b.readUInt16LE(10);
  if (major < 4) bad("That KeePass database is KDBX 3. Open it in KeePassXC or KeePass and save it as KDBX 4 (in KeePassXC: Database › Database Security › Encryption Settings), then import that.");
  if (major > 4) bad(`That KeePass database is KDBX ${major}, newer than GitRoll reads.`);
  const fields = new Map<number, Buffer>();
  let i = 12;
  for (;;) {
    if (i + 5 > b.length) bad("That KeePass database is damaged (its header is cut short).");
    const id = b[i];
    const size = b.readUInt32LE(i + 1);
    const data = b.subarray(i + 5, i + 5 + size);
    i += 5 + size;
    if (id === 0) break;
    fields.set(id, Buffer.from(data));
  }
  const header = b.subarray(0, i);
  if (!sha256(header).equals(b.subarray(i, i + 32))) bad("That KeePass database is damaged (its header doesn't match its checksum).");
  const headerMac = b.subarray(i + 32, i + 64);
  i += 64;

  const cipherId = fields.get(2)?.toString("hex");
  if (cipherId === CIPHER.twofish) bad("That KeePass database is encrypted with Twofish. Change it to AES-256 or ChaCha20 in KeePassXC or KeePass, save, and import again.");
  if (cipherId !== CIPHER.aes256 && cipherId !== CIPHER.chacha20) bad("That KeePass database uses a cipher GitRoll doesn't know.");
  const seed = fields.get(4);
  const iv = fields.get(7);
  const kdfBytes = fields.get(11);
  if (!seed || seed.length !== 32 || !iv || !kdfBytes) bad("That KeePass database's header is incomplete.");

  const composite = sha256(sha256(Buffer.from(password, "utf8")));
  const transformed = transformKey(composite, readVariants(kdfBytes!));
  const cipherKey = sha256(seed!, transformed);
  const macBase = sha512(seed!, transformed, Buffer.from([1]));
  if (!crypto.timingSafeEqual(hmac(blockKey(macBase, 0xffffffffffffffffn), header), headerMac)) bad("Wrong password for that KeePass database (or it needs a key file, which GitRoll doesn't read yet).");

  const blocks: Buffer[] = [];
  let total = 0;
  for (let index = 0n; ; index++) {
    if (i + 36 > b.length) bad("That KeePass database is damaged (it ends early).");
    const mac = b.subarray(i, i + 32);
    const size = b.readUInt32LE(i + 32);
    if (size > MAX.block) bad("That KeePass database has a block larger than GitRoll reads.");
    const data = b.subarray(i + 36, i + 36 + size);
    if (data.length !== size) bad("That KeePass database is damaged (it ends early).");
    if (!crypto.timingSafeEqual(hmac(blockKey(macBase, index), u64(index), u32(size), data), mac)) bad("That KeePass database is damaged or was altered (a block fails its check).");
    i += 36 + size;
    if (size === 0) break;
    total += size;
    if (total > MAX.plain) bad("That KeePass database is larger than GitRoll imports.");
    blocks.push(data);
  }
  const encrypted = Buffer.concat(blocks);
  let plain: Buffer;
  try {
    if (cipherId === CIPHER.aes256) {
      const d = crypto.createDecipheriv("aes-256-cbc", cipherKey, iv!);
      plain = Buffer.concat([d.update(encrypted), d.final()]);
    } else {
      const d = crypto.createDecipheriv("chacha20", cipherKey, Buffer.concat([Buffer.alloc(4), iv!]));
      plain = Buffer.concat([d.update(encrypted), d.final()]);
    }
  } catch {
    return bad("That KeePass database doesn't decrypt, though its checks passed. It may be damaged.");
  }
  const compression = fields.get(3)?.readUInt32LE() ?? 0;
  if (compression === 1) {
    try {
      plain = zlib.gunzipSync(plain, { maxOutputLength: MAX.plain });
    } catch {
      return bad("That KeePass database's contents don't decompress, or are larger than GitRoll imports.");
    }
  } else if (compression !== 0) bad("That KeePass database uses a compression GitRoll doesn't know.");

  // The inner header: the protected-value stream, and attachments.
  let j = 0;
  let streamId = 0;
  let streamKey: Buffer | null = null;
  let binaries = 0;
  for (;;) {
    if (j + 5 > plain.length) bad("That KeePass database's contents are damaged.");
    const id = plain[j];
    const size = plain.readUInt32LE(j + 1);
    const data = plain.subarray(j + 5, j + 5 + size);
    j += 5 + size;
    if (id === 0) break;
    if (id === 1) streamId = data.readUInt32LE();
    else if (id === 2) streamKey = Buffer.from(data);
    else if (id === 3) binaries++;
  }
  if (streamId !== 3 || !streamKey) bad("That KeePass database protects its values with a stream cipher GitRoll doesn't read (only ChaCha20, KDBX 4's default).");
  let root: XmlElement;
  try {
    root = parseXml(plain.subarray(j).toString("utf8"));
  } catch (e) {
    return bad(`That KeePass database's contents aren't valid: ${(e as Error).message}`);
  }
  // Protected values are one ChaCha20 stream, in document order.
  const h = sha512(streamKey!);
  const stream = crypto.createDecipheriv("chacha20", h.subarray(0, 32), Buffer.concat([Buffer.alloc(4), h.subarray(32, 44)]));
  const visit = (el: XmlElement) => {
    if (el.name === "Value" && el.attrs.Protected === "True") {
      const ct = Buffer.from(el.text.trim(), "base64");
      el.text = stream.update(ct).toString("utf8");
    }
    for (const c of el.children) visit(c);
  };
  visit(root);
  return { root, binaries };
}

// ── Writing ──────────────────────────────────────────────────────────────

/** Argon2id at 64 MiB: about a second here, and what KeePassXC users expect. */
export const EXPORT_KDF = { memory: 64 * 1024 * 1024, passes: 2, parallelism: 2 };

/**
 * A KDBX 4 file: ChaCha20, gzip, Argon2id. `xmlFor` builds the XML and must
 * call `protect` for each protected value in document order.
 */
export function writeKdbx(xmlFor: (protect: (plain: string) => string) => string, password: string, kdf = EXPORT_KDF): Uint8Array {
  const seed = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const salt = crypto.randomBytes(32);
  const kdfParams = writeVariants([
    ["$UUID", 0x42, Buffer.from(KDF.argon2id, "hex")],
    ["S", 0x42, salt],
    ["P", 0x04, u32(kdf.parallelism)],
    ["M", 0x05, u64(BigInt(kdf.memory))],
    ["I", 0x05, u64(BigInt(kdf.passes))],
    ["V", 0x04, u32(0x13)],
  ]);
  const field = (id: number, data: Buffer) => Buffer.concat([Buffer.from([id]), u32(data.length), data]);
  const header = Buffer.concat([
    u32(SIG1),
    u32(SIG2),
    Buffer.from([0x00, 0x00, 0x04, 0x00]),
    field(2, Buffer.from(CIPHER.chacha20, "hex")),
    field(3, u32(1)),
    field(4, seed),
    field(7, iv),
    field(11, kdfParams),
    field(0, Buffer.from("\r\n\r\n")),
  ]);
  const composite = sha256(sha256(Buffer.from(password, "utf8")));
  const transformed = transformKey(composite, readVariants(kdfParams));
  const cipherKey = sha256(seed, transformed);
  const macBase = sha512(seed, transformed, Buffer.from([1]));

  const streamKey = crypto.randomBytes(64);
  const h = sha512(streamKey);
  const stream = crypto.createCipheriv("chacha20", h.subarray(0, 32), Buffer.concat([Buffer.alloc(4), h.subarray(32, 44)]));
  const xml = xmlFor((plain) => stream.update(Buffer.from(plain, "utf8")).toString("base64"));
  const inner = Buffer.concat([field(1, u32(3)), field(2, streamKey), field(0, Buffer.alloc(0)), Buffer.from(xml, "utf8")]);
  const c = crypto.createCipheriv("chacha20", cipherKey, Buffer.concat([Buffer.alloc(4), iv]));
  const encrypted = Buffer.concat([c.update(zlib.gzipSync(inner)), c.final()]);

  const out: Buffer[] = [header, sha256(header), hmac(blockKey(macBase, 0xffffffffffffffffn), header)];
  const BLOCK = 1024 * 1024;
  let index = 0n;
  for (let at = 0; at < encrypted.length; at += BLOCK, index++) {
    const data = encrypted.subarray(at, at + BLOCK);
    out.push(hmac(blockKey(macBase, index), u64(index), u32(data.length), data), u32(data.length), data);
  }
  out.push(hmac(blockKey(macBase, index), u64(index), u32(0)), u32(0));
  return new Uint8Array(Buffer.concat(out));
}
