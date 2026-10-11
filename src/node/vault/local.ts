// What this device remembers about each vault it belongs to, outside every
// Roll: where the vault is, which member this device is, whether its recovery
// kit was checked, and the last trust record and snapshot it accepted (the
// pin), so a rolled-back copy of the vault is noticed. Nothing secret.
//
//   <settings>/vault/vaults.json

import fs from "node:fs";
import path from "node:path";
import { VaultError } from "../../core/vault/format.ts";
import type { Pin } from "../../core/vault/format.ts";
import { NotFoundError, UserError } from "../../core/util.ts";
import { ensureVaultHome, vaultHome } from "./device.ts";

export interface LocalVault {
  id: string;
  name: string;
  /** The Roll's folder. */
  roll: string;
  /** This device's member id in the vault. */
  member: string;
  pin: Pin;
  recoveryChecked: boolean;
  added: string;
}

interface LocalFile {
  v: 1;
  vaults: Record<string, LocalVault>;
}

const file = () => path.join(vaultHome(), "vaults.json");

function load(): LocalFile {
  try {
    const data = JSON.parse(fs.readFileSync(file(), "utf8")) as LocalFile;
    if (data.v !== 1 || typeof data.vaults !== "object" || !data.vaults) throw new Error("unknown format");
    return data;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { v: 1, vaults: {} };
    throw new UserError(`Couldn't read ${file()}: ${(e as Error).message}`);
  }
}

function save(data: LocalFile): void {
  ensureVaultHome();
  const tmp = `${file()}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file());
}

export function localVaults(): LocalVault[] {
  return Object.values(load().vaults);
}

export function localVault(id: string): LocalVault {
  const v = load().vaults[id];
  if (!v) throw new NotFoundError("This device isn't enrolled in that vault.");
  return v;
}

/** Finds a vault by name, and by Roll folder when two have the same name. */
export function findLocalVault(name: string, roll?: string): LocalVault {
  const all = localVaults().filter((v) => v.name === name && (!roll || path.resolve(v.roll) === path.resolve(roll)));
  if (all.length === 1) return all[0];
  if (all.length > 1) throw new UserError(`${all.length} vaults on this device are called ${name}. Say which Roll with -C <folder>.`);
  const known = localVaults().map((v) => v.name);
  throw new NotFoundError(`This device has no vault called ${name}.${known.length ? ` Its vaults: ${[...new Set(known)].join(", ")}` : " Create one with: gitroll vault init personal"}`);
}

export function putLocalVault(entry: LocalVault): void {
  const data = load();
  data.vaults[entry.id] = entry;
  save(data);
}

/**
 * Moves the pin forward to a state that was just verified against it. Never
 * backwards: a pin only ever records the newest state this device accepted.
 */
export function advancePin(id: string, pin: Pin): void {
  const data = load();
  const entry = data.vaults[id];
  if (!entry) return;
  const cur = entry.pin;
  if (pin.trust.seq < cur.trust.seq || pin.snapshot.seq < cur.snapshot.seq) throw new VaultError("VAULT_ROLLBACK", "Refusing to remember an older vault state than this device already accepted.");
  if (pin.trust.seq === cur.trust.seq && pin.trust.hash === cur.trust.hash && pin.snapshot.seq === cur.snapshot.seq && pin.snapshot.hash === cur.snapshot.hash) return;
  entry.pin = pin;
  save(data);
}

export function markRecoveryChecked(id: string): void {
  const data = load();
  if (data.vaults[id]) {
    data.vaults[id].recoveryChecked = true;
    save(data);
  }
}
