// This computer's vault identity: an age X25519 key (vault key bundles are
// encrypted to it) and an Ed25519 key (it signs the vault's trust records and
// snapshots). Both are secret, kept in GitRoll's settings folder, never in a
// Roll, and never in plain text:
//
//   <settings>/vault/device.json   public half and how the secret is protected
//   <settings>/vault/device.age    the secret, encrypted with age's passphrase
//                                  (scrypt) mode, or absent when it is kept in
//                                  the operating system's credential store
//
// A missing or unreadable secret is an error, never a reason to fall back to an
// unprotected key file.

import fs from "node:fs";
import path from "node:path";
import { AgeError, ScryptIdentity, ScryptRecipient, X25519Identity, decrypt, encrypt } from "../../core/age/format.ts";
import { base64, fromUtf8, unbase64, utf8 } from "../../core/age/bytes.ts";
import { VaultError, canonicalJson, memberFor, newId, nowIso } from "../../core/vault/format.ts";
import type { Member } from "../../core/vault/format.ts";
import { UserError } from "../../core/util.ts";
import { findGitRoot } from "../repo.ts";
import { configDir } from "../user-config.ts";
import { nodeVaultCrypto as crypto } from "./crypto.ts";
import { keychainBackend } from "./keychain.ts";
import type { KeychainBackend } from "./keychain.ts";

export type Protection = "passphrase" | "keychain";

export interface DeviceInfo {
  v: 1;
  id: string;
  /** age recipient */
  age: string;
  /** Ed25519 public key, base64 */
  sign: string;
  protection: Protection;
  created: string;
}

export interface UnlockedDevice {
  info: DeviceInfo;
  age: X25519Identity;
  seed: Uint8Array;
  member: Member;
}

export const MIN_PASSPHRASE = 8;
/** age's own default: about a second and 256 MiB to try one passphrase. */
const DEFAULT_LOG_N = 18;

export const vaultHome = (): string => path.join(configDir(), "vault");
const infoFile = () => path.join(vaultHome(), "device.json");
const secretFile = () => path.join(vaultHome(), "device.age");

/**
 * The scrypt work factor for protecting a device key. GITROLL_VAULT_KDF_LOG_N
 * lowers it for tests; lowering it makes a stolen device file faster to guess.
 */
function workFactor(): number {
  const raw = process.env.GITROLL_VAULT_KDF_LOG_N;
  if (raw === undefined) return DEFAULT_LOG_N;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 10 || n > 20) throw new UserError("GITROLL_VAULT_KDF_LOG_N must be a whole number from 10 to 20.");
  return n;
}

/** The settings folder for vault keys, created private, and never inside a Git repository. */
export function ensureVaultHome(): string {
  const dir = vaultHome();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
  const repo = findGitRoot(dir);
  if (repo) throw new UserError(`Refusing to keep vault keys inside a Git repository (${repo}). Set GITROLL_HOME to a folder outside any repository.`);
  return dir;
}

export function deviceInfo(): DeviceInfo | null {
  let text: string;
  try {
    text = fs.readFileSync(infoFile(), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new UserError(`Couldn't read this device's vault key at ${infoFile()}: ${(e as Error).message}`);
  }
  const info = JSON.parse(text) as DeviceInfo;
  if (info.v !== 1 || typeof info.id !== "string" || (info.protection !== "passphrase" && info.protection !== "keychain")) {
    throw new UserError(`${infoFile()} isn't a device key this GitRoll understands.`);
  }
  return info;
}

function writePrivate(file: string, data: string | Uint8Array): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600, flag: "wx" });
  fs.renameSync(tmp, file);
}

function secretPlaintext(id: string, age: X25519Identity, seed: Uint8Array): Uint8Array {
  return utf8(canonicalJson({ v: 1, type: "device", id, age: age.toString(), sign: base64(seed) }));
}

async function protect(info: DeviceInfo, plain: Uint8Array, passphrase: string | null, keychain: KeychainBackend | null): Promise<void> {
  if (info.protection === "keychain") {
    if (!keychain) throw new UserError("This computer has no supported credential store. Protect the key with a passphrase instead (--protect passphrase).");
    await keychain.store(info.id, base64(plain));
    try {
      fs.rmSync(secretFile(), { force: true });
    } catch {
      // nothing to remove
    }
  } else {
    if (!passphrase || passphrase.length < MIN_PASSPHRASE) throw new UserError(`Choose an unlock passphrase of at least ${MIN_PASSPHRASE} characters.`);
    writePrivate(secretFile(), await encrypt(plain, [new ScryptRecipient(passphrase, workFactor())], crypto));
  }
}

/** Makes this computer's device key. Refuses when there already is one. */
export async function createDevice(protection: Protection, passphrase: string | null): Promise<UnlockedDevice> {
  ensureVaultHome();
  if (deviceInfo()) throw new UserError("This computer already has a vault device key.");
  const keychain = protection === "keychain" ? keychainBackend() : null;
  const id = await newId(crypto);
  const age = await X25519Identity.generate(crypto);
  const seed = await crypto.randomBytes(32);
  const member = await memberFor(id, "device", age, seed, crypto);
  const info: DeviceInfo = { v: 1, id, age: member.age, sign: member.sign, protection, created: nowIso() };
  await protect(info, secretPlaintext(id, age, seed), passphrase, keychain);
  writePrivate(infoFile(), `${JSON.stringify(info, null, 2)}\n`);
  return { info, age, seed, member };
}

async function readSecret(info: DeviceInfo, passphrase: string | null): Promise<Uint8Array> {
  if (info.protection === "keychain") {
    const backend = keychainBackend();
    if (!backend) throw new UserError("This device's key is in a credential store this computer can't reach.");
    const stored = await backend.load(info.id);
    const plain = stored ? unbase64(stored) : null;
    if (!plain) throw new VaultError("VAULT_LOCKED", "This device's key is missing from the credential store. Recover with your recovery kit: gitroll vault recover");
    return plain;
  }
  if (passphrase === null) throw new VaultError("VAULT_LOCKED", "Unlocking needs this device's passphrase.");
  let file: Uint8Array;
  try {
    file = fs.readFileSync(secretFile());
  } catch {
    throw new UserError(`This device's protected key is missing (${secretFile()}). Recover with your recovery kit: gitroll vault recover`);
  }
  try {
    return await decrypt(file, [new ScryptIdentity(passphrase)], crypto);
  } catch (e) {
    if (e instanceof AgeError && /work factor/.test(e.message)) throw new UserError(e.message);
    throw new VaultError("VAULT_LOCKED", "That passphrase doesn't unlock this device.");
  }
}

/** Opens this computer's device key. The public half is re-derived from the secret, never trusted from device.json. */
export async function unlockDevice(passphrase: string | null): Promise<UnlockedDevice> {
  const info = deviceInfo();
  if (!info) throw new UserError("This computer has no vault device key yet. Create a vault (gitroll vault init) or recover one (gitroll vault recover).");
  const plain = await readSecret(info, passphrase);
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(fromUtf8(plain)) as Record<string, unknown>;
  } catch {
    throw new UserError("This device's key is damaged.");
  }
  const seed = typeof data.sign === "string" ? unbase64(data.sign) : null;
  if (data.v !== 1 || data.type !== "device" || data.id !== info.id || typeof data.age !== "string" || !seed || seed.length !== 32) throw new UserError("This device's key is damaged.");
  const age = X25519Identity.parse(data.age);
  const member = await memberFor(info.id, "device", age, seed, crypto);
  if (member.age !== info.age || member.sign !== info.sign) throw new UserError(`${infoFile()} doesn't match this device's secret key.`);
  return { info, age, seed, member };
}

/** Changes how the device key is protected: a new passphrase, or a move to or from the credential store. */
export async function reprotectDevice(device: UnlockedDevice, protection: Protection, passphrase: string | null): Promise<DeviceInfo> {
  const keychain = protection === "keychain" ? keychainBackend() : null;
  const info: DeviceInfo = { ...device.info, protection };
  await protect(info, secretPlaintext(info.id, device.age, device.seed), passphrase, keychain);
  writePrivate(infoFile(), `${JSON.stringify(info, null, 2)}\n`);
  if (device.info.protection === "keychain" && protection !== "keychain") await keychainBackend()?.remove(info.id);
  return info;
}
