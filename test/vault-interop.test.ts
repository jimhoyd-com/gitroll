// Moving items into and out of a vault: KeePass (KDBX 4), 1Password (1PUX) and
// SOPS. The KeePass fixtures were written by pykeepass, not GitRoll, so reading
// them tests interoperability; exports are read back by pykeepass and sops
// when those are installed. Synthetic secrets only.

import "./helpers.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { duplicateKey, fieldName, keepassDrafts, keepassXml, onePasswordDrafts } from "../src/core/vault/interop.ts";
import type { VaultItem } from "../src/core/vault/items.ts";
import { XmlError, parseXml } from "../src/core/vault/xml.ts";
import { readKdbx, writeKdbx } from "../src/node/vault/kdbx.ts";
import { readZipEntry } from "../src/node/vault/zip.ts";
import { git, tmp } from "./helpers.ts";

const cli = fileURLToPath(new URL("../src/node/cli.ts", import.meta.url));
const fixtures = fileURLToPath(new URL("./fixtures/vault-import/", import.meta.url));
const fixture = (name: string) => new Uint8Array(fs.readFileSync(path.join(fixtures, name)));
const KDBX_PASSWORD = "synthetic-kdbx-password";
const FAST_KDF = { memory: 1024 * 1024, passes: 1, parallelism: 1 };
const hasPykeepass = !spawnSync("python3", ["-c", "import pykeepass"]).status;
const hasSops = !spawnSync("sops", ["--version"]).error;

test("the XML reader refuses DOCTYPEs and entity tricks, and reads what KeePass writes", () => {
  const el = parseXml(`<?xml version="1.0" encoding="utf-8"?>\n<!-- c --><A x="1 &amp; 2"><B>&lt;&#65;&#x42;&gt;</B><C><![CDATA[<raw & text>]]></C><D/></A>`);
  assert.equal(el.attrs.x, "1 & 2");
  assert.equal(el.children[0].text, "<AB>");
  assert.equal(el.children[1].text, "<raw & text>");
  for (const bad of [
    `<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><a>&x;</a>`,
    `<a>&x;</a>`,
    `<a>& </a>`,
    `<a><b></a>`,
    `<a></a><b></b>`,
    `<a x="1" x="2"></a>`,
    `<a>&#0;</a>`,
    `<a>`,
  ])
    assert.throws(() => parseXml(bad), XmlError, bad);
});

test("field names from other formats become vault field names, unique within the item", () => {
  const taken = new Set<string>();
  assert.equal(fieldName("Recovery code", taken), "Recovery_code");
  assert.equal(fieldName("Recovery code", taken), "Recovery_code_2");
  assert.equal(fieldName("2FA backup", taken), "field_2FA_backup");
  assert.equal(fieldName("Clé privée", taken), "Cle_privee");
  assert.equal(fieldName("!!!", taken), "field");
});

for (const name of ["keepass-argon2d-aes.kdbx", "keepass-aeskdf-chacha20.kdbx"]) {
  test(`reads a KeePass database written by another implementation: ${name}`, () => {
    const { root } = readKdbx(fixture(name), KDBX_PASSWORD);
    const r = keepassDrafts(root);
    assert.equal(r.found, 4);
    assert.deepEqual(r.skipped, [{ reason: "in KeePass's recycle bin", count: 1 }]);
    const mail = r.drafts.find((d) => d.title === "Example Mail")!;
    assert.deepEqual(
      mail.fields.map((f) => [f.name, f.value, f.secret]),
      [
        ["username", "ada@example.com", false],
        ["password", "synthetic-mail-password-2", true],
        ["url", "https://mail.example.com", false],
        ["Recovery_code", "SYNTH-1111-2222", true],
        ["Account_number", "4417", false],
        ["otp", "otpauth://totp/Example:ada?secret=JBSWY3DPEHPK3PXP&issuer=Example", true],
      ],
    );
    assert.equal(mail.notes, "Synthetic notes\nline two");
    assert.deepEqual(mail.ext.keepass, { uuid: (mail.ext.keepass as { uuid: string }).uuid, group: "Root/Email", tags: ["work", "mail"] });
    assert.equal(mail.kind, "login");
    assert.equal(r.drafts.find((d) => d.title === "Just a note")!.kind, "note");
    assert.equal(r.drafts.find((d) => d.title === "Wi-Fi & <home>")!.fields[0].value, "synthetic-wifi-pass");
    const losses = Object.fromEntries(r.losses.map((l) => [l.what, l.count]));
    assert.equal(losses["attachments (vault items don't hold files)"], 1);
    assert.equal(losses["older versions from an entry's history"], 1);
  });
}

test("a wrong password, a changed byte, KDBX 3 and an expensive key derivation are refused before anything is read", () => {
  const good = fixture("keepass-argon2d-aes.kdbx");
  assert.throws(() => readKdbx(good, "wrong"), /Wrong password/);
  // A flipped byte in the encrypted body fails that block's HMAC.
  const body = good.slice();
  body[body.length - 40] ^= 1;
  assert.throws(() => readKdbx(body, KDBX_PASSWORD), /damaged or was altered/);
  // A flipped byte in the header fails its checksum.
  const head = good.slice();
  head[40] ^= 1;
  assert.throws(() => readKdbx(head, KDBX_PASSWORD), /damaged/);
  const v3 = good.slice();
  v3[10] = 3;
  assert.throws(() => readKdbx(v3, KDBX_PASSWORD), /KDBX 3/);
  assert.throws(() => readKdbx(new Uint8Array(100), KDBX_PASSWORD), /isn't a KeePass database/);
  // Key derivation settings that would take this computer's memory or hours are refused, not attempted.
  assert.throws(() => writeKdbx(() => "<KeePassFile/>", "x", { memory: 4 * 1024 * 1024 * 1024, passes: 1, parallelism: 1 }), /outside what GitRoll will run/);
  assert.throws(() => writeKdbx(() => "<KeePassFile/>", "x", { memory: 1024 * 1024, passes: 100_000, parallelism: 1 }), /outside what GitRoll will run/);
});

function item(over: Partial<VaultItem> & { title: string }): VaultItem {
  return { id: "a".repeat(26), rev: 1, kind: "login", fields: [], notes: "", created: "2026-01-02T03:04:05Z", updated: "2026-01-02T03:04:05Z", ext: {}, ...over };
}

test("a KeePass export reads back the same items, with secrets protected and groups kept", () => {
  const items = [
    item({ title: "Bank <main>", fields: [{ name: "username", value: "ada", secret: false }, { name: "password", value: "synthetic-bank-pw", secret: true }, { name: "url", value: "https://bank.example", secret: false }, { name: "pin", value: "0000", secret: true }, { name: "Title", value: "clash", secret: false }], notes: "multi\nline & <notes>", ext: { keepass: { uuid: "00112233445566778899aabbccddeeff", group: "Old/Finance", tags: ["money"] } } }),
    item({ title: "Deploy token", kind: "secret", fields: [{ name: "value", value: "synthetic-token", secret: true }], ext: { onepassword: { uuid: "x" } } }),
  ];
  let losses: { what: string; count: number }[] = [];
  const bytes = writeKdbx((protect) => {
    const x = keepassXml("personal", items, "2026-10-11T00:00:00Z", protect, () => new Uint8Array(crypto.randomBytes(16)));
    losses = x.losses;
    return x.xml;
  }, "export-password", FAST_KDF);
  assert.equal(losses.length, 1, "data only another manager's importer kept is reported as not exported");
  const back = keepassDrafts(readKdbx(bytes, "export-password").root);
  const bank = back.drafts.find((d) => d.title === "Bank <main>")!;
  assert.deepEqual(bank.fields.map((f) => [f.name, f.value, f.secret]), [["username", "ada", false], ["password", "synthetic-bank-pw", true], ["url", "https://bank.example", false], ["pin", "0000", true], ["Title_field", "clash", false]]);
  assert.equal(bank.notes, "multi\nline & <notes>");
  assert.equal(bank.created, "2026-01-02T03:04:05Z");
  assert.deepEqual(bank.ext.keepass, { uuid: "00112233445566778899aabbccddeeff", group: "personal/Finance", tags: ["money"] });
  assert.equal(back.drafts.find((d) => d.title === "Deploy token")!.fields[0].value, "synthetic-token");
  // Nothing secret is in the file as plain text.
  const raw = Buffer.from(bytes).toString("latin1");
  for (const s of ["synthetic-bank-pw", "synthetic-token", "Bank"]) assert.ok(!raw.includes(s));
});

test("pykeepass opens a GitRoll KeePass export", { skip: hasPykeepass ? false : "pykeepass isn't installed" }, () => {
  const file = path.join(tmp(), "out.kdbx");
  fs.writeFileSync(file, writeKdbx((protect) => keepassXml("personal", [item({ title: "Bank", fields: [{ name: "username", value: "ada", secret: false }, { name: "password", value: "synthetic-bank-pw", secret: true }, { name: "pin", value: "0000", secret: true }] })], "2026-10-11T00:00:00Z", protect, () => new Uint8Array(crypto.randomBytes(16))).xml, "export-password", FAST_KDF));
  const py = spawnSync("python3", ["-c", "import sys,json;from pykeepass import PyKeePass;db=PyKeePass(sys.argv[1],password='export-password');e=db.entries[0];print(json.dumps([e.title,e.username,e.password,e.custom_properties,db.encryption_algorithm,db.kdf_algorithm]))", file], { encoding: "utf8" });
  assert.equal(py.status, 0, py.stderr);
  assert.deepEqual(JSON.parse(py.stdout), ["Bank", "ada", "synthetic-bank-pw", { pin: "0000" }, "chacha20", "argon2id"]);
});

test("1Password: items map to vault items, and what can't come along is counted", () => {
  const data = readZipEntry(fixture("synthetic-1password.1pux"), "export.data", 1024 * 1024)!;
  const r = onePasswordDrafts(JSON.parse(Buffer.from(data).toString("utf8")));
  assert.equal(r.found, 5);
  assert.deepEqual(r.skipped, [{ reason: "archived in 1Password", count: 1 }, { reason: "documents (vault items don't hold files)", count: 1 }]);
  const login = r.drafts.find((d) => d.title === "Example Login")!;
  assert.equal(login.kind, "login");
  assert.deepEqual(
    login.fields.map((f) => [f.name, f.value, f.secret]),
    [
      ["username", "ada@example.com", false],
      ["password", "synthetic-1p-password", true],
      ["url", "https://login.example.com", false],
      ["admin", "https://admin.example.com", false],
      ["one-time_password", "otpauth://totp/Example?secret=JBSWY3DPEHPK3PXP", true],
      ["recovery_key", "SYNTH-RECOVERY", true],
      ["member_since", "2020-09-13", false],
    ],
  );
  assert.equal(login.created, "2023-11-14T22:13:20Z");
  assert.deepEqual((login.ext.onepassword as { unmapped: unknown[] }).unmapped, [{ section: "Security", title: "weird", value: { futureType: { x: 1 } } }]);
  const card = r.drafts.find((d) => d.title === "Synthetic Visa")!;
  assert.equal(card.kind, "card");
  assert.deepEqual(card.fields.map((f) => [f.name, f.secret]), [["cardholder_name", false], ["number", true], ["verification_number", true], ["expiry_date", false], ["address", false]]);
  assert.equal(card.fields.find((f) => f.name === "expiry_date")!.value, "2029-12");
  const ssh = r.drafts.find((d) => d.title === "Deploy SSH key")!;
  assert.deepEqual(ssh.fields.map((f) => [f.name, f.secret]), [["private_key", true], ["public_key", false]]);
  const losses = Object.fromEntries(r.losses.map((l) => [l.what, l.count]));
  assert.equal(losses["attachments (vault items don't hold files)"], 1);
  assert.equal(losses["earlier passwords from an item's history"], 1);
  assert.equal(Object.keys(losses).some((k) => k.includes("futureType")), true);
});

test("the zip reader refuses what it shouldn't read", () => {
  const one = fixture("synthetic-1password.1pux");
  assert.equal(readZipEntry(one, "missing", 1024), null);
  assert.throws(() => readZipEntry(one, "export.data", 100), /larger than GitRoll reads/);
  assert.throws(() => readZipEntry(new Uint8Array(200), "export.data", 1024), /isn't a zip archive/);
  // A changed byte in compressed data fails decompression or the CRC.
  const at = Buffer.from(one).indexOf(Buffer.from("export.data")) + 20;
  const broken = one.slice();
  broken[at] ^= 0xff;
  assert.throws(() => readZipEntry(broken, "export.data", 1024 * 1024));
  // A bomb: an entry that says it is small but expands far past the limit.
  assert.throws(() => readZipEntry(zipOf("export.data", zlib.deflateRawSync(Buffer.alloc(64 * 1024 * 1024)), 100), "export.data", 1024 * 1024), /doesn't decompress, or is larger/);
});

/** A one-entry zip whose directory says the entry is `declared` bytes. */
function zipOf(name: string, deflated: Buffer, declared: number): Uint8Array {
  const n = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(deflated.length, 18);
  local.writeUInt32LE(declared, 22);
  local.writeUInt16LE(n.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(deflated.length, 20);
  central.writeUInt32LE(declared, 24);
  central.writeUInt16LE(n.length, 28);
  central.writeUInt32LE(0, 42);
  const cdOffset = 30 + n.length + deflated.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + n.length, 12);
  end.writeUInt32LE(cdOffset, 16);
  return new Uint8Array(Buffer.concat([local, n, deflated, central, n, end]));
}

test("duplicates are found by title, username and URL, never by a secret", () => {
  const a = { title: "Bank ", fields: [{ name: "username", value: "Ada" }, { name: "url", value: "https://bank.example/" }, { name: "password" }] };
  const b = { title: "bank", fields: [{ name: "username", value: "ada", secret: false }, { name: "url", value: "https://bank.example", secret: false }, { name: "password", value: "x", secret: true }] };
  assert.equal(duplicateKey(a), duplicateKey(b));
  assert.notEqual(duplicateKey(a), duplicateKey({ ...b, title: "Other" }));
});

// ── Through the command line ─────────────────────────────────────────────

const runtimes: { env: NodeJS.ProcessEnv }[] = [];
after(() => {
  for (const d of runtimes) spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", cli, "vault", "lock"], { env: { ...process.env, ...d.env } });
});

function device() {
  const home = tmp();
  const env: NodeJS.ProcessEnv = { GITROLL_HOME: path.join(home, "settings"), GITROLL_VAULT_RUNTIME: fs.mkdtempSync("/tmp/grv-"), GITROLL_VAULT_KDF_LOG_N: "10", HOME: path.join(home, "home") };
  fs.mkdirSync(env.HOME!, { recursive: true });
  runtimes.push({ env });
  const run = (args: string[], input = "") => {
    const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", cli, ...args], { encoding: "utf8", cwd: home, env: { ...process.env, ...env }, input, timeout: 120_000 });
    assert.ifError(r.error);
    return r;
  };
  const json = (args: string[], input = "") => {
    const r = run([...args, "--json"], input);
    assert.equal(r.status, 0, `${args.join(" ")}\n${r.stdout}${r.stderr}`);
    return JSON.parse(r.stdout);
  };
  return { home, env, run, json };
}

test("import and export through the CLI: dry run, duplicates, loss report, nothing secret in the Roll", { timeout: 180_000 }, () => {
  const d = device();
  const roll = path.join(tmp(), "roll");
  d.json(["init", "--dir", roll]);
  d.json(["vault", "init", "personal", "-C", roll, "--stdin", "--kit", path.join(d.env.HOME!, "kit.txt")], "synthetic unlock passphrase\n");
  const kdbx = path.join(fixtures, "keepass-argon2d-aes.kdbx");

  // A dry run while locked: counts, no duplicate check, nothing written.
  const before = git(roll, "rev-parse", "HEAD").trim();
  const dry = d.json(["vault", "import", "personal", kdbx, "--dry-run", "--stdin"], `${KDBX_PASSWORD}\n`);
  assert.deepEqual([dry.found, dry.import, dry.duplicates, dry.dryRun], [4, 3, null, true]);
  assert.equal(git(roll, "rev-parse", "HEAD").trim(), before);

  // Importing needs the vault unlocked.
  const locked = d.run(["vault", "import", "personal", kdbx, "--stdin", "--json"], `${KDBX_PASSWORD}\n`);
  assert.equal(JSON.parse(locked.stderr).error.code, "VAULT_LOCKED");
  d.json(["vault", "unlock", "personal", "--stdin", "--timeout", "5m"], "synthetic unlock passphrase\n");
  const wrong = d.run(["vault", "import", "personal", kdbx, "--stdin", "--json"], "wrong\n");
  assert.match(JSON.parse(wrong.stderr).error.message, /Wrong password/);

  const done = d.json(["vault", "import", "personal", kdbx, "--stdin"], `${KDBX_PASSWORD}\n`);
  assert.equal(done.imported, 3);
  assert.equal(done.commits.length, 1);
  assert.match(git(roll, "log", "-1", "--format=%s"), /^vault: import 3 items into personal/);
  assert.equal(d.run(["vault", "reveal", "personal", "Example Mail", "--field", "Recovery_code"]).stdout, "SYNTH-1111-2222");

  // Again: everything is a duplicate, and skipped.
  const again = d.json(["vault", "import", "personal", path.join(fixtures, "keepass-aeskdf-chacha20.kdbx"), "--stdin"], `${KDBX_PASSWORD}\n`);
  assert.deepEqual([again.duplicates, again.imported], [3, 0]);

  // 1Password, with its report in plain words.
  const text = d.run(["vault", "import", "personal", path.join(fixtures, "synthetic-1password.1pux")]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /Imported 3 items of 5/);
  assert.match(text.stdout, /Left out: 1 archived in 1Password/);
  assert.match(text.stdout, /Not carried over: 1 × earlier passwords/);
  assert.match(text.stderr, /plain text\. Delete it now/);
  assert.equal(d.run(["vault", "reveal", "personal", "Synthetic Visa", "--field", "number"]).stdout, "4111111111111111");

  // Export to KeePass: asks first, refuses inside a Git repository, then writes a file that reads back.
  const out = path.join(d.env.HOME!, "export.kdbx");
  assert.equal(d.run(["vault", "export", "personal", "--format", "keepass", "--out", out, "--stdin", "--json"], "pw\npw\n").status, 1, "needs --yes without a terminal");
  assert.equal(d.run(["vault", "export", "personal", "--format", "keepass", "--out", path.join(roll, "x.kdbx"), "--yes", "--stdin", "--json"], "pw\npw\n").status, 1);
  const exported = d.json(["vault", "export", "personal", "--format", "keepass", "--out", out, "--yes", "--stdin"], "synthetic export password\nsynthetic export password\n");
  assert.equal(exported.items, 6);
  const back = keepassDrafts(readKdbx(new Uint8Array(fs.readFileSync(out)), "synthetic export password").root);
  assert.equal(back.drafts.find((x) => x.title === "Example Login")!.fields.find((f) => f.name === "password")!.value, "synthetic-1p-password");
  assert.equal(fs.statSync(out).mode & 0o077, 0);

  // Nothing secret in the Roll or its history.
  const history = git(roll, "log", "--all", "-p", "--binary");
  for (const s of ["synthetic-mail-password", "SYNTH-1111-2222", "synthetic-1p-password", "4111111111111111", "Example Mail"]) assert.ok(!history.includes(s), `${s} reached the Roll`);
});

test("SOPS: an item exports to a sops file and a sops file imports as an item", { skip: hasSops ? false : "sops isn't installed", timeout: 120_000 }, () => {
  const d = device();
  const roll = path.join(tmp(), "roll");
  d.json(["init", "--dir", roll]);
  d.json(["vault", "init", "personal", "-C", roll, "--stdin", "--kit", path.join(d.env.HOME!, "kit.txt")], "synthetic unlock passphrase\n");
  d.json(["vault", "unlock", "personal", "--stdin", "--timeout", "5m"], "synthetic unlock passphrase\n");
  d.json(["vault", "add", "personal", "--kind", "secret", "--title", "App staging", "--stdin"], JSON.stringify({ fields: { API_TOKEN: "synthetic-api-token", DB_PASSWORD: "synthetic-db-pw" } }));
  const keyFile = path.join(d.env.HOME!, "sops-age.txt");
  const kg = spawnSync("age-keygen", ["-o", keyFile], { encoding: "utf8" });
  if (kg.error) return;
  const recipient = /age1[0-9a-z]+/.exec(fs.readFileSync(keyFile, "utf8"))![0];
  const sopsFile = path.join(roll, "app.sops.yaml");
  d.json(["vault", "export", "personal", "App staging", "--format", "sops", "--out", sopsFile, "--recipient", recipient]);
  const enc = fs.readFileSync(sopsFile, "utf8");
  assert.match(enc, /API_TOKEN: ENC\[AES256_GCM/);
  assert.ok(!enc.includes("synthetic-api-token"));
  const dec = spawnSync("sops", ["--decrypt", "--output-type", "json", sopsFile], { encoding: "utf8", env: { ...process.env, SOPS_AGE_KEY_FILE: keyFile } });
  assert.deepEqual(JSON.parse(dec.stdout), { API_TOKEN: "synthetic-api-token", DB_PASSWORD: "synthetic-db-pw" });
  // And back in, as a new item named after the file.
  d.env.SOPS_AGE_KEY_FILE = keyFile;
  const imp = d.json(["vault", "import", "personal", sopsFile, "--title", "App staging (from sops)"]);
  assert.equal(imp.imported, 1);
  assert.equal(d.run(["vault", "reveal", "personal", "App staging (from sops)", "--field", "DB_PASSWORD"]).stdout, "synthetic-db-pw");
  // Exporting over an existing file is refused.
  assert.equal(d.run(["vault", "export", "personal", "App staging", "--format", "sops", "--out", sopsFile, "--recipient", recipient, "--json"]).status, 1);
});
