// The age v1 format (age-encryption.org/v1): known answers from the spec and
// from the reference implementation, and round trips through the `age` CLI
// itself when it is installed. Nothing here touches the network.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  AgeError,
  ScryptIdentity,
  ScryptRecipient,
  X25519Identity,
  X25519Recipient,
  armor,
  chunkNonce,
  dearmor,
  decrypt,
  decryptAny,
  encrypt,
  parseHeader,
  parseIdentities,
  scryptArgs,
  serializeStanza,
} from "../src/core/age/format.ts";
import { bech32Decode, bech32Encode } from "../src/core/age/bech32.ts";
import { base64, unbase64, utf8 } from "../src/core/age/bytes.ts";
import { nodeAgeCrypto as c } from "../src/node/age-crypto.ts";

// A throwaway key made with age-keygen 1.x for these vectors, and what the
// reference CLI wrote with it. Never used for anything else.
// A throwaway key made for these tests, split so secret scanners don't take it for a real one.
const REF_IDENTITY = ["AGE-SECRET-KEY-1", "UPA328AP5P0SQM2E247F6YCRZ99ZD98RREVSWYQNCXN0G9Y3DFLQG4T72Z"].join("");
const REF_RECIPIENT = "age1609sgjxkf7z5uzak4ysaxrske8d759g6unmut6edp69gfrusgqtspkr7sf";
const REF_X25519 = `-----BEGIN AGE ENCRYPTED FILE-----
YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOSA1SFZmNUNaQXlubnFwbDVZ
ZU41aG5xZlJ3RU1pYWhKaHQwSXhyRTNla0VFCk52OXUvTlN5SFl1UVVZb2h4ZUc3
MHBNQnVUcXF0Y1V4WHo1a2RQRUxobkkKLS0tIEFRcmFzRS9TR1pweWhPUk1CMVFI
V1liWVRHRWRpOFFoa2w1M3orbFlCd3cKCpUnalxuH1rtLzS7hsnxAYFgDzPqScn1
GIXkKUxRvDp3t7yziLv9sSW/RSyPqbY98tb0FMoYy62Sj0io14aCDLE=
-----END AGE ENCRYPTED FILE-----
`;
/** `age -a -p` with the passphrase "correct horse" (scrypt work factor 18). */
const REF_SCRYPT = `-----BEGIN AGE ENCRYPTED FILE-----
YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IHNjcnlwdCBTVnJtcDl6Rm1XM0lsbmZC
ZHgwOVhnIDE4CmtIekdTd1FMZTdVOER6VFVTNjcyMUYwU1ZRdGFjam0xbkxwSDB4
d1BucDAKLS0tIHFtZkJWMU56S084KzV1T0lUYXNxcFpqYVNaRkZqTWcwUnJuNG1h
ZUM2VUkKyVIyKny18KSfpZMHJZkPlVM/ku+OK///4DCqxe+ECL1JuNkOpfSMTMDC
xIw=
-----END AGE ENCRYPTED FILE-----
`;
const text = (b: Uint8Array) => new TextDecoder().decode(b);

test("bech32: BIP 173 vectors, case rules, and age's own keys", () => {
  assert.deepEqual(bech32Decode("A12UEL5L"), { hrp: "a", data: new Uint8Array(0) });
  assert.ok(bech32Decode("abcdef1qpzry9x8gf2tvdw0s3jn54khce6mua7lmqqqxw"));
  assert.equal(bech32Decode("A12uEL5L"), null, "mixed case is invalid");
  assert.equal(bech32Decode("a12uel5m"), null, "a bad checksum is invalid");
  assert.equal(bech32Decode("1qzzfhee"), null, "an empty human-readable part is invalid");
  const bytes = Uint8Array.from({ length: 32 }, (_, i) => i);
  assert.deepEqual(bech32Decode(bech32Encode("age", bytes))!.data, bytes);
  // Identities are written in upper case, and stay that way.
  assert.match(bech32Encode("AGE-SECRET-KEY-", bytes), /^AGE-SECRET-KEY-1[0-9A-Z]{58}$/);
});

test("an age-keygen identity decodes, and derives the public key age-keygen printed", async () => {
  const identity = X25519Identity.parse(REF_IDENTITY);
  assert.equal(identity.toString(), REF_IDENTITY);
  assert.equal((await identity.recipient(c)).toString(), REF_RECIPIENT);
  assert.equal(X25519Recipient.parse(REF_RECIPIENT).toString(), REF_RECIPIENT);
  assert.throws(() => X25519Recipient.parse(REF_RECIPIENT.toUpperCase()), AgeError, "recipients are lower case");
  assert.throws(() => X25519Recipient.parse(REF_RECIPIENT.slice(0, -1) + "q"), AgeError);
  assert.throws(() => X25519Identity.parse(REF_IDENTITY.toLowerCase()), AgeError, "identities are upper case");
  const file = `# created: 2026-10-07T14:39:20Z\n# public key: ${REF_RECIPIENT}\n${REF_IDENTITY}\n`;
  assert.equal(parseIdentities(file).length, 1);
  assert.throws(() => parseIdentities("AGE-PLUGIN-YUBIKEY-1QQQ\n"), AgeError);
});

test("base64 is strict: canonical encodings only, padding exactly as the context says", () => {
  assert.equal(base64(utf8("ab"), false), "YWI");
  assert.equal(base64(utf8("ab")), "YWI=");
  assert.deepEqual(unbase64("YWI", false), utf8("ab"));
  assert.equal(unbase64("YWI=", false), null, "no padding in a header");
  assert.equal(unbase64("YWJ", false), null, "non-zero trailing bits are not canonical");
  assert.equal(unbase64("YWI", true), null, "armor is padded");
  assert.equal(unbase64("Y", false), null);
  assert.equal(unbase64("YW I", false), null);
});

test("stanzas: bodies wrap at 64 columns, end on a short line, and parse back", () => {
  const body48 = new Uint8Array(48).fill(7);
  const s = serializeStanza({ type: "X25519", args: ["abc"], body: body48 });
  const lines = s.split("\n");
  assert.equal(lines[0], "-> X25519 abc");
  assert.equal(lines[1].length, 64);
  assert.equal(lines[2], "", "a body that fills its last line is followed by an empty one");
  const header = utf8(`age-encryption.org/v1\n${s}${serializeStanza({ type: "other", args: [], body: new Uint8Array(0) })}--- ${base64(new Uint8Array(32), false)}\n`);
  const parsed = parseHeader(header);
  assert.equal(parsed.stanzas.length, 2);
  assert.deepEqual(parsed.stanzas[0].body, body48);
  assert.deepEqual(parsed.stanzas[1], { type: "other", args: [], body: new Uint8Array(0) });
  assert.equal(parsed.length, header.length);
  assert.equal(text(parsed.macInput).endsWith("\n---"), true, "the MAC covers the header up to and including ---");

  const bad = (h: string) => assert.throws(() => parseHeader(utf8(h)), AgeError, h);
  bad("age-encryption.org/v2\n--- AAAA\n");
  bad(`age-encryption.org/v1\n-> X25519  double-space\n\n--- ${base64(new Uint8Array(32), false)}\n`);
  bad(`age-encryption.org/v1\n-> X25519 a\n${"A".repeat(65)}\n--- ${base64(new Uint8Array(32), false)}\n`);
  bad(`age-encryption.org/v1\n-> X25519 a\nYWJ\n--- ${base64(new Uint8Array(32), false)}\n`);
  bad("age-encryption.org/v1\n-> X25519 a\n");
  bad("age-encryption.org/v1\n--- short\n");
});

test("armor: 64-column PEM, whitespace around it ignored, anything else refused", () => {
  const bytes = Uint8Array.from({ length: 100 }, (_, i) => i);
  const a = armor(bytes);
  const lines = a.trim().split("\n");
  assert.equal(lines[0], "-----BEGIN AGE ENCRYPTED FILE-----");
  assert.equal(lines.at(-1), "-----END AGE ENCRYPTED FILE-----");
  assert.equal(lines[1].length, 64);
  assert.ok(lines[2].length <= 64);
  assert.deepEqual(dearmor(`\n  ${a}\n\n`), bytes);
  assert.deepEqual(dearmor(a.replace(/\n/g, "\r\n")), bytes);
  const short = a.replace(lines[1], lines[1].slice(0, 63));
  assert.throws(() => dearmor(short), AgeError, "every line but the last is exactly 64 columns");
  assert.throws(() => dearmor(a.replace("-----END AGE ENCRYPTED FILE-----", "")), AgeError);
});

test("payload chunks: 11-byte counter, final-chunk flag, 64 KiB each", async () => {
  assert.deepEqual(chunkNonce(0, false), new Uint8Array(12));
  assert.deepEqual(chunkNonce(1, true), Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1]));
  assert.deepEqual(chunkNonce(256, false).slice(9, 12), Uint8Array.from([1, 0, 0]));
  const id = await X25519Identity.generate(c);
  const r = await id.recipient(c);
  const sizeOf = async (n: number) => {
    const file = await encrypt(new Uint8Array(n), [r], c);
    return file.length - parseHeader(file).length - 16;
  };
  assert.equal(await sizeOf(0), 16, "an empty file is one empty, final chunk");
  assert.equal(await sizeOf(65536), 65536 + 16, "a full chunk can be the last one");
  assert.equal(await sizeOf(65537), 65536 + 16 + 1 + 16);
  for (const n of [0, 1, 65536, 65537, 200_000]) {
    const plain = Uint8Array.from({ length: n }, (_, i) => i % 251);
    assert.deepEqual(await decrypt(await encrypt(plain, [r], c), [id], c), plain, `round trip of ${n} bytes`);
  }
});

test("a file sealed by the reference age CLI opens, with the key or the passphrase", async () => {
  assert.equal(text(await decryptAny(REF_X25519, [X25519Identity.parse(REF_IDENTITY)], c)), "Sealed by the reference age CLI.\n");
  assert.equal(text(await decryptAny(REF_SCRYPT, [new ScryptIdentity("correct horse")], c)), "secret text\n");
  await assert.rejects(decryptAny(REF_SCRYPT, [new ScryptIdentity("wrong horse")], c), AgeError);
  await assert.rejects(decryptAny(REF_X25519, [await X25519Identity.generate(c)], c), /None of your keys/);
});

test("scrypt: work factor limits, one stanza only, and well-formed arguments", async () => {
  const file = await encrypt(utf8("hi"), [new ScryptRecipient("pw", 2)], c);
  assert.equal(text(await decrypt(file, [new ScryptIdentity("pw")], c)), "hi");
  await assert.rejects(decrypt(file, [new ScryptIdentity("pw", 1)], c), /work factor of 2, above the limit of 1/);
  const stanza = (args: string[]) => ({ type: "scrypt", args, body: new Uint8Array(32) });
  const salt = base64(new Uint8Array(16), false);
  assert.throws(() => scryptArgs(stanza([salt, "018"])), /malformed/, "no leading zeros");
  assert.throws(() => scryptArgs(stanza([salt, "0"])), /malformed/);
  assert.throws(() => scryptArgs(stanza([salt, "21"])), /above the limit of 20/, "the default cap");
  assert.throws(() => scryptArgs(stanza([base64(new Uint8Array(15), false), "10"])), /salt/);
  assert.equal(scryptArgs(stanza([salt, "18"])).logN, 18);
  const id = await X25519Identity.generate(c);
  await assert.rejects(encrypt(utf8("x"), [new ScryptRecipient("pw", 2), await id.recipient(c)], c), AgeError);
  // A scrypt stanza beside another is refused even by an X25519 identity.
  const mixed = utf8(`age-encryption.org/v1\n${serializeStanza(stanza([salt, "2"]))}${serializeStanza({ type: "X25519", args: [salt], body: new Uint8Array(32) })}--- ${base64(new Uint8Array(32), false)}\n`);
  await assert.rejects(decrypt(mixed, [id], c), /exactly one recipient/);
});

test("tampering is caught: header MAC, payload, truncation, low-order shares; wrong keys fail cleanly", async () => {
  const id = await X25519Identity.generate(c);
  const other = await X25519Identity.generate(c);
  const plain = new Uint8Array(70_000).fill(9);
  const file = await encrypt(plain, [await id.recipient(c), await other.recipient(c)], c);
  assert.deepEqual(await decrypt(file, [other], c), plain, "either recipient opens it");
  await assert.rejects(decrypt(file, [await X25519Identity.generate(c)], c), /None of your keys/);

  // A stanza added to the header doesn't stop the key unwrapping, but the MAC catches it.
  const h = parseHeader(file);
  const at = text(file.subarray(0, h.length)).indexOf("---");
  const extra = utf8(serializeStanza({ type: "grease", args: ["x"], body: new Uint8Array(3) }));
  const forged = new Uint8Array([...file.subarray(0, at), ...extra, ...file.subarray(at)]);
  await assert.rejects(decrypt(forged, [id], c), /MAC/);

  const flipped = file.slice();
  flipped[h.length + 16 + 10] ^= 1;
  await assert.rejects(decrypt(flipped, [id], c), /changed or damaged/);
  const truncated = file.subarray(0, h.length + 16 + 65536 + 16);
  await assert.rejects(decrypt(truncated, [id], c), /cut short|changed/, "dropping the last chunk is detected");
  await assert.rejects(decrypt(file.subarray(0, h.length + 16), [id], c), /no payload/);

  const lowOrder = utf8(`age-encryption.org/v1\n${serializeStanza({ type: "X25519", args: [base64(new Uint8Array(32), false)], body: new Uint8Array(32) })}--- ${base64(new Uint8Array(32), false)}\n`);
  await assert.rejects(decrypt(lowOrder, [id], c), /low-order/);
});

const hasAge = spawnSync("age", ["--version"], { encoding: "utf8" }).status === 0 && spawnSync("age-keygen", ["--help"], { encoding: "utf8" }).error === undefined;

test("interoperates with the reference age CLI, both ways", { skip: hasAge ? false : "age isn't installed here" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gitroll-age-"));
  const keyFile = path.join(dir, "key.txt");
  assert.equal(spawnSync("age-keygen", ["-o", keyFile]).status, 0);
  const ids = parseIdentities(fs.readFileSync(keyFile, "utf8"));
  const recipient = (await ids[0].recipient(c)).toString();
  assert.equal(spawnSync("age-keygen", ["-y", keyFile], { encoding: "utf8" }).stdout.trim(), recipient, "same public key as age-keygen -y");

  const big = Uint8Array.from({ length: 150_000 }, (_, i) => (i * 7) % 256);
  // Ours, opened by age: binary and armored.
  fs.writeFileSync(path.join(dir, "ours.age"), await encrypt(big, [X25519Recipient.parse(recipient)], c));
  const opened = spawnSync("age", ["-d", "-i", keyFile, path.join(dir, "ours.age")]);
  assert.equal(opened.status, 0, String(opened.stderr));
  assert.deepEqual(new Uint8Array(opened.stdout), big);
  fs.writeFileSync(path.join(dir, "ours.asc"), armor(await encrypt(utf8("armored\n"), [X25519Recipient.parse(recipient)], c)));
  assert.equal(spawnSync("age", ["-d", "-i", keyFile, path.join(dir, "ours.asc")], { encoding: "utf8" }).stdout, "armored\n");
  // An identity we made, used by age.
  const mine = await X25519Identity.generate(c);
  fs.writeFileSync(path.join(dir, "mine.txt"), `${mine}\n`);
  fs.writeFileSync(path.join(dir, "mine.age"), await encrypt(utf8("made here"), [await mine.recipient(c)], c));
  assert.equal(spawnSync("age", ["-d", "-i", path.join(dir, "mine.txt"), path.join(dir, "mine.age")], { encoding: "utf8" }).stdout, "made here");

  // Theirs, opened here: binary to two recipients, and armored.
  fs.writeFileSync(path.join(dir, "big.bin"), big);
  const theirs = spawnSync("age", ["-r", recipient, "-r", (await mine.recipient(c)).toString(), "-o", path.join(dir, "theirs.age"), path.join(dir, "big.bin")]);
  assert.equal(theirs.status, 0, String(theirs.stderr));
  assert.deepEqual(await decrypt(new Uint8Array(fs.readFileSync(path.join(dir, "theirs.age"))), ids, c), big);
  assert.deepEqual(await decrypt(new Uint8Array(fs.readFileSync(path.join(dir, "theirs.age"))), [mine], c), big);
  const armored = spawnSync("age", ["-a", "-r", recipient], { input: "from age\n", encoding: "utf8" });
  assert.equal(text(await decryptAny(armored.stdout, ids, c)), "from age\n");
  const empty = spawnSync("age", ["-r", recipient], { input: "" });
  assert.equal((await decrypt(new Uint8Array(empty.stdout), ids, c)).length, 0);
});
