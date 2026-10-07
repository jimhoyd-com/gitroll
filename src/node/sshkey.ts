/**
 * Ed25519 SSH keys in OpenSSH's own formats, made with Node's built-in crypto.
 *
 * GitRoll signs an agent's commits with Git's SSH signing (`gpg.format ssh`),
 * which hands the key file to `ssh-keygen -Y sign`. ssh-keygen reads private
 * keys in the "openssh-key-v1" format (PROTOCOL.key in OpenSSH's source), and
 * Node can't write that format, so it is written here. It is small: a header,
 * the public key, and one unencrypted block holding the private key, all made
 * of SSH wire strings (a 4-byte big-endian length, then the bytes).
 *
 * Nothing here checks a signature. Verifying is Git's and ssh-keygen's job.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";

const MAGIC = Buffer.from("openssh-key-v1\0", "latin1");
const KEY_TYPE = "ssh-ed25519";
const BEGIN = "-----BEGIN OPENSSH PRIVATE KEY-----";
const END = "-----END OPENSSH PRIVATE KEY-----";

export interface Ed25519Key {
  /** The 32-byte public key. */
  publicKey: Buffer;
  /** The 32-byte private seed. */
  seed: Buffer;
  comment: string;
}

const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};
const sshString = (data: Buffer | string): Buffer => {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  return Buffer.concat([u32(bytes.length), bytes]);
};

/** A new Ed25519 key pair. */
export function generateEd25519(comment = ""): Ed25519Key {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = publicKey.export({ format: "jwk" });
  const priv = privateKey.export({ format: "jwk" });
  return { publicKey: Buffer.from(pub.x!, "base64url"), seed: Buffer.from(priv.d!, "base64url"), comment };
}

/** The public key as SSH writes it on the wire: string "ssh-ed25519", string key. */
function publicBlob(publicKey: Buffer): Buffer {
  return Buffer.concat([sshString(KEY_TYPE), sshString(publicKey)]);
}

/** One line, as in a .pub file or an allowed_signers entry: "ssh-ed25519 AAAA… comment". */
export function publicKeyLine(key: Pick<Ed25519Key, "publicKey" | "comment">): string {
  const line = `${KEY_TYPE} ${publicBlob(key.publicKey).toString("base64")}`;
  return key.comment ? `${line} ${key.comment}` : line;
}

/** The private key file, unencrypted, in OpenSSH's format. Keep it 0600. */
export function privateKeyFile(key: Ed25519Key, checkint: number = randomBytes(4).readUInt32BE()): string {
  // The two equal check numbers are how ssh-keygen tells a wrong passphrase
  // from a right one; unencrypted, they only have to match.
  let block = Buffer.concat([
    u32(checkint),
    u32(checkint),
    sshString(KEY_TYPE),
    sshString(key.publicKey),
    // OpenSSH stores the 64-byte form: the seed followed by the public key.
    sshString(Buffer.concat([key.seed, key.publicKey])),
    sshString(key.comment),
  ]);
  // Padded with 1, 2, 3, … to the cipher's block size, which is 8 for "none".
  const pad = (8 - (block.length % 8)) % 8;
  block = Buffer.concat([block, Buffer.from(Array.from({ length: pad }, (_, i) => i + 1))]);
  const body = Buffer.concat([
    MAGIC,
    sshString("none"), // cipher
    sshString("none"), // kdf
    sshString(""), // kdf options
    u32(1), // one key
    sshString(publicBlob(key.publicKey)),
    sshString(block),
  ]).toString("base64");
  return `${BEGIN}\n${body.match(/.{1,70}/g)!.join("\n")}\n${END}\n`;
}

class Reader {
  #at = 0;
  readonly buf: Buffer;
  constructor(buf: Buffer) {
    this.buf = buf;
  }
  u32(): number {
    if (this.#at + 4 > this.buf.length) throw new Error("truncated key");
    const n = this.buf.readUInt32BE(this.#at);
    this.#at += 4;
    return n;
  }
  bytes(): Buffer {
    const n = this.u32();
    if (this.#at + n > this.buf.length) throw new Error("truncated key");
    const out = this.buf.subarray(this.#at, this.#at + n);
    this.#at += n;
    return out;
  }
  text(): string {
    return this.bytes().toString("utf8");
  }
  rest(): Buffer {
    return this.buf.subarray(this.#at);
  }
}

/**
 * Reads an unencrypted Ed25519 key back out of an OpenSSH private key file,
 * checking every part of the structure, and that the private half really is
 * the private half of the public key it claims.
 */
export function parsePrivateKeyFile(text: string): Ed25519Key {
  const m = text.trim().match(new RegExp(`^${BEGIN}\\s+([A-Za-z0-9+/=\\s]+?)\\s+${END}$`));
  if (!m) throw new Error("not an OpenSSH private key");
  const buf = Buffer.from(m[1].replace(/\s+/g, ""), "base64");
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("not an openssh-key-v1 key");
  const r = new Reader(buf.subarray(MAGIC.length));
  if (r.text() !== "none" || r.text() !== "none" || r.bytes().length !== 0) throw new Error("encrypted keys aren't supported");
  if (r.u32() !== 1) throw new Error("expected exactly one key");
  const pub = new Reader(r.bytes());
  if (pub.text() !== KEY_TYPE) throw new Error("not an Ed25519 key");
  const publicKey = Buffer.from(pub.bytes());
  const block = new Reader(r.bytes());
  if (r.rest().length) throw new Error("trailing data after the key");
  if (block.u32() !== block.u32()) throw new Error("check numbers don't match");
  if (block.text() !== KEY_TYPE) throw new Error("not an Ed25519 key");
  if (!block.bytes().equals(publicKey)) throw new Error("public keys don't match");
  const secret = block.bytes();
  if (secret.length !== 64 || !secret.subarray(32).equals(publicKey)) throw new Error("malformed private key");
  const comment = block.text();
  const padding = block.rest();
  if (padding.length >= 8 || !padding.every((b, i) => b === i + 1)) throw new Error("bad padding");
  const seed = Buffer.from(secret.subarray(0, 32));
  // The seed must produce the public key it was stored with.
  const derived = createPublicKey(createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", d: seed.toString("base64url"), x: publicKey.toString("base64url") }, format: "jwk" }))
    .export({ format: "jwk" }).x;
  if (Buffer.from(derived!, "base64url").compare(publicKey) !== 0) throw new Error("private key doesn't match its public key");
  return { publicKey, seed, comment };
}

/** Reads "ssh-ed25519 AAAA… [comment]". */
export function parsePublicKeyLine(line: string): { publicKey: Buffer; comment: string } {
  const m = line.trim().match(/^ssh-ed25519\s+([A-Za-z0-9+/=]+)(?:\s+(.*))?$/);
  if (!m) throw new Error("not an ssh-ed25519 public key");
  const r = new Reader(Buffer.from(m[1], "base64"));
  if (r.text() !== KEY_TYPE) throw new Error("not an ssh-ed25519 public key");
  const publicKey = Buffer.from(r.bytes());
  if (publicKey.length !== 32 || r.rest().length) throw new Error("malformed ssh-ed25519 public key");
  return { publicKey, comment: m[2] ?? "" };
}
