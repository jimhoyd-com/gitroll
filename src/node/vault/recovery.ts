// The recovery kit, and encrypted backups.
//
// A recovery kit is a text file holding the vault's recovery member: an age
// identity that the key bundle is always encrypted to, and an Ed25519 key that
// may sign trust records. It is made once, when the vault is created, and is
// meant to be printed or kept offline. With the kit and any copy of the vault
// (the Roll, a clone, or a backup file) a person can enroll a new device. A
// GitRoll account can't do this for them: nothing outside the kit and their
// devices can open the vault.
//
// A backup is one age file, encrypted to every member (devices and recovery),
// holding the vault's state.json and objects exactly as they are. It adds no
// trust of its own: restoring authenticates it like any other copy.

import fs from "node:fs";
import path from "node:path";
import { X25519Identity, X25519Recipient, decrypt, encrypt } from "../../core/age/format.ts";
import { base64, fromUtf8, unbase64, utf8 } from "../../core/age/bytes.ts";
import { ID, OBJECT_FILE, STATE_FILE, VaultError, canonicalJson, memberFor, openKeyBundle, openState, referencedObjects } from "../../core/vault/format.ts";
import type { Member, VerifiedState } from "../../core/vault/format.ts";
import { UserError } from "../../core/util.ts";
import { findGitRoot } from "../repo.ts";
import { nodeVaultCrypto as crypto } from "./crypto.ts";

const KIT_HEADER = "GitRoll Vault recovery kit, version 1";
const HASH = /^[0-9a-f]{64}$/;

export interface RecoveryKit {
  name: string;
  vault: string;
  member: string;
  age: X25519Identity;
  seed: Uint8Array;
}

export function kitText(kit: RecoveryKit): string {
  return [
    KIT_HEADER,
    "",
    "Keep this somewhere safe and offline: printed, or on a drive in a drawer.",
    "Anyone with this kit and a copy of the vault can open the vault. Without it,",
    "a vault whose devices are all lost can't be opened by anyone.",
    "",
    `vault-name: ${kit.name}`,
    `vault-id: ${kit.vault}`,
    `member-id: ${kit.member}`,
    `age-identity: ${kit.age.toString()}`,
    `signing-key: ${base64(kit.seed)}`,
    "",
    "To use it on a new computer, with the Roll cloned there (or a backup file):",
    `  gitroll vault recover ${kit.name} --kit <this file> [--from <backup file>]`,
    "",
  ].join("\n");
}

export function parseKit(text: string): RecoveryKit {
  if (!text.startsWith(KIT_HEADER)) throw new VaultError("VAULT_INVALID", "That isn't a GitRoll Vault recovery kit.");
  const get = (key: string): string => {
    const m = new RegExp(`^${key}: (\\S+)\\s*$`, "m").exec(text);
    if (!m) throw new VaultError("VAULT_INVALID", `The recovery kit is missing its ${key} line.`);
    return m[1];
  };
  const seed = unbase64(get("signing-key"));
  const vault = get("vault-id");
  const member = get("member-id");
  if (!seed || seed.length !== 32 || !HASH.test(vault) || !ID.test(member)) throw new VaultError("VAULT_INVALID", "The recovery kit is damaged.");
  let age: X25519Identity;
  try {
    age = X25519Identity.parse(get("age-identity"));
  } catch {
    throw new VaultError("VAULT_INVALID", "The recovery kit is damaged.");
  }
  return { name: get("vault-name"), vault, member, age, seed };
}

export async function kitMember(kit: RecoveryKit): Promise<Member> {
  return memberFor(kit.member, "recovery", kit.age, kit.seed, crypto);
}

/** Checks a kit against a vault: same vault, a current recovery member, and it opens the key bundle. */
export async function checkKit(kit: RecoveryKit, state: VerifiedState, keyBundle: Uint8Array | null): Promise<X25519Identity> {
  if (kit.vault !== state.vaultId) throw new VaultError("VAULT_FORBIDDEN", "That recovery kit is for a different vault.");
  const me = await kitMember(kit);
  const m = state.chain.head.members.find((x) => x.id === kit.member);
  if (!m || m.role !== "recovery" || m.age !== me.age || m.sign !== me.sign) throw new VaultError("VAULT_FORBIDDEN", "That recovery kit is no longer a member of this vault.");
  return openKeyBundle(state, keyBundle, kit.age, crypto);
}

/** Writes a file that holds secrets: new, private, and never inside a Git repository. */
export function writeSecretFile(target: string, content: string | Uint8Array, what: string): string {
  const abs = path.resolve(target);
  const repo = findGitRoot(path.dirname(abs));
  if (repo) throw new UserError(`Refusing to write the ${what} inside a Git repository (${repo}), where it could be committed. Choose a folder outside it.`);
  try {
    fs.writeFileSync(abs, content, { mode: 0o600, flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new UserError(`${abs} already exists. GitRoll never overwrites it; choose another name.`);
    throw e;
  }
  return abs;
}

// ── Backups ────────────────────────────────────────────────────────────────

interface BackupBody {
  format: "gitroll-vault-backup";
  v: 1;
  name: string;
  vault: string;
  created: string;
  files: Record<string, string>;
}

/** A backup of a verified state: its files, encrypted to every member. */
export async function makeBackup(name: string, state: VerifiedState, stateBytes: Uint8Array, read: (hash: string) => Uint8Array | null): Promise<Uint8Array> {
  const files: Record<string, string> = { [STATE_FILE]: base64(stateBytes) };
  for (const hash of referencedObjects(state.snapshot)) {
    const bytes = read(hash);
    if (!bytes) throw new VaultError("VAULT_TAMPERED", `Object ${hash.slice(0, 12)} is missing; the backup would be incomplete.`);
    files[`objects/${hash}.age`] = base64(bytes);
  }
  const body: BackupBody = { format: "gitroll-vault-backup", v: 1, name, vault: state.vaultId, created: new Date().toISOString(), files };
  return encrypt(utf8(canonicalJson(body)), state.chain.head.members.map((m) => X25519Recipient.parse(m.age)), crypto);
}

/** Opens a backup with a member's age identity and authenticates what is inside. */
export async function openBackup(bytes: Uint8Array, identity: X25519Identity, expectVault: string): Promise<{ name: string; state: VerifiedState; files: Map<string, Uint8Array> }> {
  let body: BackupBody;
  try {
    body = JSON.parse(fromUtf8(await decrypt(bytes, [identity], crypto))) as BackupBody;
  } catch {
    throw new VaultError("VAULT_FORBIDDEN", "That backup doesn't open with this key: it's for another vault, or it's damaged.");
  }
  if (body.format !== "gitroll-vault-backup" || body.v !== 1 || !body.files || typeof body.files !== "object") throw new VaultError("VAULT_UNSUPPORTED", "That backup's format isn't one this GitRoll reads.");
  const files = new Map<string, Uint8Array>();
  for (const [rel, b64] of Object.entries(body.files)) {
    if (rel !== STATE_FILE && !OBJECT_FILE.test(rel)) throw new VaultError("VAULT_TAMPERED", "The backup holds a file that doesn't belong in a vault.");
    const data = typeof b64 === "string" ? unbase64(b64) : null;
    if (!data) throw new VaultError("VAULT_TAMPERED", "The backup is damaged.");
    files.set(rel, data);
  }
  const stateBytes = files.get(STATE_FILE);
  if (!stateBytes) throw new VaultError("VAULT_TAMPERED", "The backup has no state.json.");
  const state = await openState(stateBytes, crypto, { expectVault });
  return { name: body.name, state, files };
}
