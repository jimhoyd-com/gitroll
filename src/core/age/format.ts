// The age file format, version 1 (https://age-encryption.org/v1, C2SP age).
//
// A file is a text header — the version line, one stanza per recipient, and a
// MAC — followed by a 16-byte nonce and the payload in 64 KiB ChaCha20-Poly1305
// chunks. Anything written here can be read by the reference `age` CLI and
// anything it writes can be read here; nothing in this file is GitRoll's own.
//
// Supported recipient types: X25519 (age1…) and scrypt (a passphrase).

import { bech32Decode, bech32Encode } from "./bech32.ts";
import { base64, concat, equalBytes, fromUtf8, unbase64, utf8 } from "./bytes.ts";
import type { AgeCrypto } from "./crypto.ts";

export const AGE_INTRO = "age-encryption.org/v1";
export const ARMOR_BEGIN = "-----BEGIN AGE ENCRYPTED FILE-----";
export const ARMOR_END = "-----END AGE ENCRYPTED FILE-----";
/** Plaintext bytes per payload chunk. */
export const CHUNK_SIZE = 64 * 1024;
const TAG_SIZE = 16;
const FILE_KEY_SIZE = 16;
const NONCE_SIZE = 16;
const COLUMNS = 64;
const X25519_LABEL = "age-encryption.org/v1/X25519";
const SCRYPT_LABEL = "age-encryption.org/v1/scrypt";
/** The scrypt work factor `age` uses when it encrypts with a passphrase. */
export const DEFAULT_SCRYPT_LOG_N = 18;
/**
 * The largest scrypt work factor a reader accepts by default. A file can name
 * any work factor, so a reader must cap it or one file could ask for unbounded
 * time and memory. 2^20 needs 1 GiB of memory.
 */
export const MAX_SCRYPT_LOG_N = 20;

/** The file is malformed, was tampered with, or no key can open it. */
export class AgeError extends Error {}

export interface Stanza {
  type: string;
  args: string[];
  body: Uint8Array;
}

export interface Header {
  stanzas: Stanza[];
  mac: Uint8Array;
  /** The header bytes the MAC covers: everything up to and including "---". */
  macInput: Uint8Array;
  /** Length of the whole header, including the MAC line's newline. */
  length: number;
}

export interface Recipient {
  wrap(fileKey: Uint8Array, crypto: AgeCrypto): Promise<Stanza[]>;
}

export interface Identity {
  /** The file key, or null when none of these stanzas is for this identity. Throws for a malformed stanza. */
  unwrap(stanzas: Stanza[], crypto: AgeCrypto): Promise<Uint8Array | null>;
}

const ZERO_NONCE = new Uint8Array(12);
const isVchar = (s: string) => s.length > 0 && /^[\x21-\x7e]+$/.test(s);

// ── Header ─────────────────────────────────────────────────────────────────

/** One stanza as it is written: "-> type args…", then the body in base64 wrapped at 64 columns. */
export function serializeStanza(stanza: Stanza): string {
  if (!isVchar(stanza.type) || !stanza.args.every(isVchar)) throw new AgeError("A stanza's type and arguments must be printable ASCII without spaces.");
  const b64 = base64(stanza.body, false);
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += COLUMNS) lines.push(b64.slice(i, i + COLUMNS));
  // The body ends at the first line shorter than 64 columns, so a body that
  // fills its last line exactly is followed by an empty one.
  if (b64.length % COLUMNS === 0) lines.push("");
  return `-> ${[stanza.type, ...stanza.args].join(" ")}\n${lines.map((l) => `${l}\n`).join("")}`;
}

/** Reads the header at the start of a binary age file. Throws AgeError when it is malformed. */
export function parseHeader(bytes: Uint8Array): Header {
  let at = 0;
  const line = (): string => {
    const nl = bytes.indexOf(0x0a, at);
    if (nl < 0) throw new AgeError("The age header ends too early.");
    const raw = bytes.subarray(at, nl);
    for (const b of raw) if (b < 0x20 || b > 0x7e) throw new AgeError("The age header contains a character it may not.");
    at = nl + 1;
    return fromUtf8(raw);
  };
  if (line() !== AGE_INTRO) throw new AgeError(`This isn't an age file (it should start with "${AGE_INTRO}").`);
  const stanzas: Stanza[] = [];
  for (;;) {
    const start = at;
    const text = line();
    if (text.startsWith("---")) {
      if (!text.startsWith("--- ")) throw new AgeError("The age header's MAC line is malformed.");
      const mac = unbase64(text.slice(4), false);
      if (!mac || mac.length !== 32) throw new AgeError("The age header's MAC is malformed.");
      return { stanzas, mac, macInput: bytes.slice(0, start + 3), length: at };
    }
    if (!text.startsWith("-> ")) throw new AgeError("The age header contains a line that is neither a stanza nor the MAC.");
    const words = text.slice(3).split(" ");
    if (!words.every(isVchar)) throw new AgeError("An age stanza has an empty or invalid argument.");
    const chunks: Uint8Array[] = [];
    for (;;) {
      const b64 = line();
      if (b64.length > COLUMNS) throw new AgeError("An age stanza body line is longer than 64 columns.");
      const decoded = unbase64(b64, false);
      if (!decoded) throw new AgeError("An age stanza body isn't canonical base64.");
      chunks.push(decoded);
      if (b64.length < COLUMNS) break;
    }
    stanzas.push({ type: words[0], args: words.slice(1), body: concat(...chunks) });
  }
}

function headerText(stanzas: Stanza[]): string {
  return `${AGE_INTRO}\n${stanzas.map(serializeStanza).join("")}---`;
}

async function headerMac(crypto: AgeCrypto, fileKey: Uint8Array, macInput: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.hkdf(fileKey, new Uint8Array(0), utf8("header"), 32);
  return crypto.hmacSha256(key, macInput);
}

// ── Payload ────────────────────────────────────────────────────────────────

/** The 12-byte ChaCha20-Poly1305 nonce of payload chunk `counter`: an 11-byte big-endian counter and the last-chunk flag. */
export function chunkNonce(counter: number, last: boolean): Uint8Array {
  const nonce = new Uint8Array(12);
  let n = counter;
  for (let i = 10; i >= 0 && n > 0; i--) {
    nonce[i] = n % 256;
    n = Math.floor(n / 256);
  }
  nonce[11] = last ? 1 : 0;
  return nonce;
}

// ── Encrypt and decrypt ────────────────────────────────────────────────────

/** Encrypts to one or more recipients. Returns a binary age file. */
export async function encrypt(plaintext: Uint8Array, recipients: Recipient[], crypto: AgeCrypto): Promise<Uint8Array> {
  if (!recipients.length) throw new AgeError("Encrypting needs at least one recipient.");
  if (recipients.length > 1 && recipients.some((r) => r instanceof ScryptRecipient)) throw new AgeError("A passphrase can't be combined with other recipients.");
  const fileKey = await crypto.randomBytes(FILE_KEY_SIZE);
  const stanzas: Stanza[] = [];
  for (const r of recipients) stanzas.push(...(await r.wrap(fileKey, crypto)));
  const macInput = utf8(headerText(stanzas));
  const mac = await headerMac(crypto, fileKey, macInput);
  const nonce = await crypto.randomBytes(NONCE_SIZE);
  const payloadKey = await crypto.hkdf(fileKey, nonce, utf8("payload"), 32);
  const parts: Uint8Array[] = [macInput, utf8(` ${base64(mac, false)}\n`), nonce];
  const count = Math.max(1, Math.ceil(plaintext.length / CHUNK_SIZE));
  for (let i = 0; i < count; i++) {
    const chunk = plaintext.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    parts.push(await crypto.seal(payloadKey, chunkNonce(i, i === count - 1), chunk));
  }
  return concat(...parts);
}

/** Decrypts a binary age file with whichever of the identities it was encrypted to. */
export async function decrypt(file: Uint8Array, identities: Identity[], crypto: AgeCrypto): Promise<Uint8Array> {
  const header = parseHeader(file);
  if (header.stanzas.some((s) => s.type === "scrypt") && header.stanzas.length !== 1) {
    throw new AgeError("A passphrase-encrypted age file must have exactly one recipient.");
  }
  let fileKey: Uint8Array | null = null;
  for (const identity of identities) {
    fileKey = await identity.unwrap(header.stanzas, crypto);
    if (fileKey) break;
  }
  if (!fileKey) throw new AgeError("None of your keys can open this. It was sealed for someone else's key.");
  if (!equalBytes(await headerMac(crypto, fileKey, header.macInput), header.mac)) {
    throw new AgeError("The age header doesn't match its MAC: the file was changed or damaged.");
  }
  const payload = file.subarray(header.length);
  if (payload.length < NONCE_SIZE) throw new AgeError("The age file ends before its payload.");
  const payloadKey = await crypto.hkdf(fileKey, payload.subarray(0, NONCE_SIZE), utf8("payload"), 32);
  const out: Uint8Array[] = [];
  const size = CHUNK_SIZE + TAG_SIZE;
  let at = NONCE_SIZE;
  let counter = 0;
  if (at === payload.length) throw new AgeError("The age file has no payload: it was cut short.");
  while (at < payload.length) {
    const chunk = payload.subarray(at, at + size);
    if (chunk.length < TAG_SIZE) throw new AgeError("The age payload ends in the middle of a chunk.");
    const last = at + chunk.length === payload.length;
    const plain = await crypto.open(payloadKey, chunkNonce(counter, last), chunk);
    if (!plain) {
      throw new AgeError(last ? "The age payload doesn't decrypt: the file was changed, damaged or cut short." : "An age payload chunk doesn't decrypt: the file was changed or damaged.");
    }
    if (last && plain.length === 0 && counter > 0) throw new AgeError("The age payload's last chunk is empty, which isn't allowed.");
    out.push(plain);
    at += chunk.length;
    counter++;
  }
  return concat(...out);
}

// ── X25519 ─────────────────────────────────────────────────────────────────

const isZero = (b: Uint8Array) => b.every((x) => x === 0);

export class X25519Recipient implements Recipient {
  readonly publicKey: Uint8Array;
  constructor(publicKey: Uint8Array) {
    if (publicKey.length !== 32) throw new AgeError("An X25519 public key is 32 bytes.");
    this.publicKey = publicKey;
  }

  /** Parses an age1… recipient. */
  static parse(text: string): X25519Recipient {
    const decoded = bech32Decode(text.trim());
    if (!decoded || decoded.hrp !== "age" || text.trim() !== text.trim().toLowerCase() || decoded.data.length !== 32) {
      throw new AgeError(`Not an age recipient: ${text.trim().slice(0, 80)} (an age recipient looks like age1… and is 62 characters long)`);
    }
    return new X25519Recipient(decoded.data);
  }

  toString(): string {
    return bech32Encode("age", this.publicKey);
  }

  async wrap(fileKey: Uint8Array, crypto: AgeCrypto): Promise<Stanza[]> {
    const ephemeral = await crypto.randomBytes(32);
    const share = await crypto.x25519Base(ephemeral);
    const shared = await crypto.x25519(ephemeral, this.publicKey);
    if (isZero(shared)) throw new AgeError("That recipient's public key is invalid.");
    const key = await crypto.hkdf(shared, concat(share, this.publicKey), utf8(X25519_LABEL), 32);
    return [{ type: "X25519", args: [base64(share, false)], body: await crypto.seal(key, ZERO_NONCE, fileKey) }];
  }
}

export class X25519Identity implements Identity {
  readonly secretKey: Uint8Array;
  #publicKey: Uint8Array | null = null;
  constructor(secretKey: Uint8Array) {
    if (secretKey.length !== 32) throw new AgeError("An X25519 secret key is 32 bytes.");
    this.secretKey = secretKey;
  }

  /** Parses an AGE-SECRET-KEY-1… identity. */
  static parse(text: string): X25519Identity {
    const t = text.trim();
    const decoded = bech32Decode(t);
    if (!decoded || decoded.hrp !== "age-secret-key-" || t !== t.toUpperCase() || decoded.data.length !== 32) {
      throw new AgeError("Not an age identity (an age identity looks like AGE-SECRET-KEY-1…).");
    }
    return new X25519Identity(decoded.data);
  }

  /** Generates a new identity. */
  static async generate(crypto: AgeCrypto): Promise<X25519Identity> {
    return new X25519Identity(await crypto.randomBytes(32));
  }

  toString(): string {
    return bech32Encode("AGE-SECRET-KEY-", this.secretKey);
  }

  async recipient(crypto: AgeCrypto): Promise<X25519Recipient> {
    this.#publicKey ??= await crypto.x25519Base(this.secretKey);
    return new X25519Recipient(this.#publicKey);
  }

  async unwrap(stanzas: Stanza[], crypto: AgeCrypto): Promise<Uint8Array | null> {
    const ours = (await this.recipient(crypto)).publicKey;
    for (const s of stanzas) {
      if (s.type !== "X25519") continue;
      if (s.args.length !== 1) throw new AgeError("An X25519 stanza must have exactly one argument.");
      const share = unbase64(s.args[0], false);
      if (!share || share.length !== 32) throw new AgeError("An X25519 stanza's share is malformed.");
      if (s.body.length !== FILE_KEY_SIZE + TAG_SIZE) throw new AgeError("An X25519 stanza's body is the wrong size.");
      let shared: Uint8Array;
      try {
        shared = await crypto.x25519(this.secretKey, share);
      } catch {
        throw new AgeError("An X25519 stanza's share is a low-order point.");
      }
      if (isZero(shared)) throw new AgeError("An X25519 stanza's share is a low-order point.");
      const key = await crypto.hkdf(shared, concat(share, ours), utf8(X25519_LABEL), 32);
      const fileKey = await crypto.open(key, ZERO_NONCE, s.body);
      if (fileKey) return fileKey;
    }
    return null;
  }
}

// ── scrypt (passphrase) ────────────────────────────────────────────────────

export class ScryptRecipient implements Recipient {
  readonly #passphrase: Uint8Array;
  readonly logN: number;
  constructor(passphrase: string, logN = DEFAULT_SCRYPT_LOG_N) {
    if (!passphrase) throw new AgeError("A passphrase can't be empty.");
    if (!Number.isInteger(logN) || logN < 1 || logN > 30) throw new AgeError("The scrypt work factor must be between 1 and 30.");
    this.#passphrase = utf8(passphrase);
    this.logN = logN;
  }

  async wrap(fileKey: Uint8Array, crypto: AgeCrypto): Promise<Stanza[]> {
    const salt = await crypto.randomBytes(16);
    const key = await crypto.scrypt(this.#passphrase, concat(utf8(SCRYPT_LABEL), salt), this.logN, 32);
    return [{ type: "scrypt", args: [base64(salt, false), String(this.logN)], body: await crypto.seal(key, ZERO_NONCE, fileKey) }];
  }
}

export class ScryptIdentity implements Identity {
  readonly #passphrase: Uint8Array;
  readonly maxLogN: number;
  constructor(passphrase: string, maxLogN = MAX_SCRYPT_LOG_N) {
    this.#passphrase = utf8(passphrase);
    this.maxLogN = maxLogN;
  }

  async unwrap(stanzas: Stanza[], crypto: AgeCrypto): Promise<Uint8Array | null> {
    const s = stanzas.find((x) => x.type === "scrypt");
    if (!s) return null;
    const { salt, logN } = scryptArgs(s, this.maxLogN);
    const key = await crypto.scrypt(this.#passphrase, concat(utf8(SCRYPT_LABEL), salt), logN, 32);
    return crypto.open(key, ZERO_NONCE, s.body);
  }
}

/** Checks an scrypt stanza's arguments, including the work-factor limit, before any work is done. */
export function scryptArgs(s: Stanza, maxLogN = MAX_SCRYPT_LOG_N): { salt: Uint8Array; logN: number } {
  if (s.args.length !== 2) throw new AgeError("An scrypt stanza must have exactly two arguments.");
  const salt = unbase64(s.args[0], false);
  if (!salt || salt.length !== 16) throw new AgeError("An scrypt stanza's salt is malformed.");
  if (!/^[1-9][0-9]*$/.test(s.args[1])) throw new AgeError("An scrypt stanza's work factor is malformed.");
  const logN = Number(s.args[1]);
  if (logN > maxLogN) throw new AgeError(`This passphrase file asks for an scrypt work factor of ${logN}, above the limit of ${maxLogN}.`);
  if (s.body.length !== FILE_KEY_SIZE + TAG_SIZE) throw new AgeError("An scrypt stanza's body is the wrong size.");
  return { salt, logN };
}

// ── Armor ──────────────────────────────────────────────────────────────────

/** ASCII armor: strict PEM with 64-column base64 lines, as `age --armor` writes it. */
export function armor(file: Uint8Array): string {
  const b64 = base64(file, true);
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += COLUMNS) lines.push(b64.slice(i, i + COLUMNS));
  return `${ARMOR_BEGIN}\n${lines.join("\n")}${lines.length ? "\n" : ""}${ARMOR_END}\n`;
}

/** Reads armored text back to a binary age file. Leading and trailing whitespace is ignored; CRLF line ends are accepted. */
export function dearmor(text: string): Uint8Array {
  const lines = text.trim().split(/\r?\n/);
  if (lines[0] !== ARMOR_BEGIN) throw new AgeError("Armored age text must start with " + ARMOR_BEGIN);
  if (lines.length < 3 || lines[lines.length - 1] !== ARMOR_END) throw new AgeError("Armored age text must end with " + ARMOR_END);
  const body = lines.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const last = i === body.length - 1;
    if (body[i].length > COLUMNS || (!last && body[i].length !== COLUMNS) || !body[i].length) {
      throw new AgeError("Armored age text must be wrapped at exactly 64 columns.");
    }
  }
  const bytes = unbase64(body.join(""), true);
  if (!bytes) throw new AgeError("Armored age text isn't canonical base64.");
  return bytes;
}

export const isArmored = (text: string): boolean => text.trimStart().startsWith(ARMOR_BEGIN);

/** Decrypts either form: binary, or armored. */
export async function decryptAny(file: Uint8Array | string, identities: Identity[], crypto: AgeCrypto): Promise<Uint8Array> {
  if (typeof file === "string") return decrypt(dearmor(file), identities, crypto);
  const head = fromUtf8Lossy(file.subarray(0, 64));
  return decrypt(isArmored(head) ? dearmor(fromUtf8(file)) : file, identities, crypto);
}

function fromUtf8Lossy(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => (b < 0x80 ? String.fromCharCode(b) : "?")).join("");
}

// ── Key files ──────────────────────────────────────────────────────────────

/**
 * Reads an identity file in the format `age-keygen` writes: one
 * AGE-SECRET-KEY-1… per line, with blank lines and # comments ignored.
 */
export function parseIdentities(text: string): X25519Identity[] {
  const out: X25519Identity[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (!line.startsWith("AGE-SECRET-KEY-1")) throw new AgeError("The identity file has a line GitRoll can't use (only AGE-SECRET-KEY-1… lines are supported).");
    out.push(X25519Identity.parse(line));
  }
  return out;
}

/** True when the text is a well-formed age1… X25519 recipient. */
export function isRecipient(text: string): boolean {
  try {
    X25519Recipient.parse(text);
    return true;
  } catch {
    return false;
  }
}
