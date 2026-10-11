// Where the vault broker listens, and the session token a client must present.
//
// On macOS and Linux this is a Unix socket in a folder only this user can
// enter ($XDG_RUNTIME_DIR, or a gitroll-vault-<uid> folder in the temporary
// directory, refused unless it is a real folder owned by this user with no
// access for anyone else). On Windows it is a named pipe whose name is derived
// from the settings folder. Either way a client must also send the random
// token the broker wrote, readable only by this user, so a process that can
// merely reach the socket or pipe can't use it.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UserError } from "../../core/util.ts";
import { vaultHome } from "./device.ts";

export function runtimeDir(): string {
  if (process.env.GITROLL_VAULT_RUNTIME) return path.resolve(process.env.GITROLL_VAULT_RUNTIME);
  if (process.platform === "win32") return path.join(vaultHome(), "run");
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  if (process.env.XDG_RUNTIME_DIR) return path.join(process.env.XDG_RUNTIME_DIR, "gitroll-vault");
  return path.join(os.tmpdir(), `gitroll-vault-${uid}`);
}

/** Creates the runtime folder if needed and refuses one another user could reach into. */
export function ensureRuntimeDir(): string {
  const dir = runtimeDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory()) throw new UserError(`${dir} isn't a folder. GitRoll won't run the vault there.`);
  if (process.platform !== "win32") {
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new UserError(`${dir} belongs to another user. GitRoll won't run the vault there.`);
    if (stat.mode & 0o077) fs.chmodSync(dir, 0o700);
    if (fs.lstatSync(dir).mode & 0o077) throw new UserError(`${dir} can be reached by other users. GitRoll won't run the vault there.`);
  }
  return dir;
}

export function socketPath(): string {
  const dir = runtimeDir();
  if (process.platform === "win32") return `\\\\.\\pipe\\gitroll-vault-${crypto.createHash("sha256").update(dir).digest("hex").slice(0, 24)}`;
  return path.join(dir, "broker.sock");
}

export const tokenFile = (): string => path.join(runtimeDir(), "session");
