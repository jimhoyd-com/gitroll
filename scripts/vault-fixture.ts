// Writes test/fixtures/vault/: a small vault of synthetic items, with its
// recovery kit, so a test can check that today's GitRoll still opens what an
// earlier one wrote. Run it only to make a new fixture for a new format version:
//   node scripts/vault-fixture.ts
// Every key and value in it is synthetic and published on purpose.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { X25519Identity } from "../src/core/age/format.ts";
import { memberFor, newId, objectFile, openState } from "../src/core/vault/format.ts";
import type { VaultItem } from "../src/core/vault/items.ts";
import { createVault, writeItems } from "../src/core/vault/ops.ts";
import { nodeVaultCrypto as crypto } from "../src/node/vault/crypto.ts";
import { kitText } from "../src/node/vault/recovery.ts";

const dir = fileURLToPath(new URL("../test/fixtures/vault/", import.meta.url));
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(path.join(dir, "objects"), { recursive: true });

const deviceAge = await X25519Identity.generate(crypto);
const deviceSeed = await crypto.randomBytes(32);
const deviceId = await newId(crypto);
const recoveryAge = await X25519Identity.generate(crypto);
const recoverySeed = await crypto.randomBytes(32);
const recoveryId = await newId(crypto);
const device = await memberFor(deviceId, "device", deviceAge, deviceSeed, crypto);
const recovery = await memberFor(recoveryId, "recovery", recoveryAge, recoverySeed, crypto);
const made = await createVault(device, recovery, { id: deviceId, seed: deviceSeed }, crypto);
const objects = new Map(made.objects);
const state0 = await openState(new TextEncoder().encode(JSON.stringify(made.state)), crypto);
const at = "2026-10-11T00:00:00Z";
const item = async (kind: string, title: string, fields: [string, string, boolean][], notes = ""): Promise<VaultItem> => ({
  id: await newId(crypto), rev: 1, kind, title, fields: fields.map(([name, value, secret]) => ({ name, value, secret })), notes, created: at, updated: at, ext: {},
});
const items = [
  await item("login", "Example login", [["username", "synthetic-user", false], ["password", "synthetic-password-do-not-use", true], ["url", "https://example.invalid", false]]),
  await item("secret", "Example API token", [["value", "synthetic-token-0000", true], ["env", "EXAMPLE_TOKEN", false]]),
  await item("note", "Example note", [], "Synthetic notes, with a line\n---\nthat looks like front matter.\n"),
];
const write = await writeItems(state0, made.vaultKey, { put: items }, { id: deviceId, seed: deviceSeed }, crypto);
for (const [h, b] of write.objects) objects.set(h, b);
fs.writeFileSync(path.join(dir, "state.json"), `${JSON.stringify(write.state, null, 2)}\n`);
for (const h of [write.state.snapshot.keys, ...write.state.snapshot.items.map((i) => i.object)]) fs.writeFileSync(path.join(dir, objectFile(h)), objects.get(h)!);
fs.writeFileSync(path.join(dir, "recovery-kit.txt"), kitText({ name: "fixture", vault: made.vaultId, member: recoveryId, age: recoveryAge, seed: recoverySeed }));
fs.writeFileSync(path.join(dir, "README.md"), "A synthetic GitRoll vault (format version 1) made by scripts/vault-fixture.ts. Every key and value here is synthetic and public on purpose; test/vault.test.ts checks it still opens.\n");
console.log(`Wrote ${dir}`);
