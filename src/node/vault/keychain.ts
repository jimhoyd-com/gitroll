// The operating system's credential store, for a device key that should open
// without a passphrase while the person is logged in: macOS Keychain (the
// `security` tool), the Secret Service on Linux (`secret-tool`, from libsecret)
// and DPAPI on Windows (PowerShell). Each is the platform's own established
// implementation; GitRoll only hands it bytes.
//
// The secret is never put on a command line, where other processes could read
// it: secret-tool and PowerShell read it from standard input, and `security`
// is driven through its interactive mode on standard input.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { UserError } from "../../core/util.ts";
import { configDir } from "../user-config.ts";

export interface KeychainBackend {
  name: string;
  store(account: string, secret: string): Promise<void>;
  load(account: string): Promise<string | null>;
  remove(account: string): Promise<void>;
}

const SERVICE = "gitroll-vault";
const ACCOUNT = /^[a-z2-7]{26}$/;

function call(cmd: string, args: string[], input?: string): { status: number | null; stdout: string; stderr: string; missing: boolean } {
  const r = spawnSync(cmd, args, { input, encoding: "utf8", timeout: 30_000, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", missing: (r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT" };
}
const failed = (what: string): never => {
  throw new UserError(`The credential store refused to ${what}. Unlock it (or log in again) and retry, or protect the key with a passphrase instead.`);
};
const checkAccount = (account: string) => {
  if (!ACCOUNT.test(account)) throw new UserError("A device id is required.");
};

function secretService(): KeychainBackend | null {
  const tool = process.env.GITROLL_VAULT_SECRET_TOOL || "secret-tool";
  if (call(tool, []).missing) return null;
  return {
    name: "Secret Service (secret-tool)",
    async store(account, secret) {
      checkAccount(account);
      if (call(tool, ["store", `--label=GitRoll vault device ${account}`, "service", SERVICE, "account", account], secret).status !== 0) failed("save the device key");
    },
    async load(account) {
      checkAccount(account);
      const r = call(tool, ["lookup", "service", SERVICE, "account", account]);
      return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
    },
    async remove(account) {
      checkAccount(account);
      call(tool, ["clear", "service", SERVICE, "account", account]);
    },
  };
}

function macKeychain(): KeychainBackend | null {
  if (call("security", ["help"]).missing) return null;
  return {
    name: "macOS Keychain",
    async store(account, secret) {
      checkAccount(account);
      if (!/^[A-Za-z0-9+/=]+$/.test(secret)) throw new UserError("Only base64 can be stored.");
      // -U updates an existing item. Driven through stdin so the secret is never an argument.
      if (call("security", ["-i"], `add-generic-password -U -a ${account} -s ${SERVICE} -l "GitRoll vault device" -w ${secret}\n`).status !== 0) failed("save the device key");
    },
    async load(account) {
      checkAccount(account);
      const r = call("security", ["find-generic-password", "-a", account, "-s", SERVICE, "-w"]);
      return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
    },
    async remove(account) {
      checkAccount(account);
      call("security", ["delete-generic-password", "-a", account, "-s", SERVICE]);
    },
  };
}

function windowsDpapi(): KeychainBackend | null {
  const ps = "powershell.exe";
  if (call(ps, ["-NoProfile", "-Command", "exit 0"]).missing) return null;
  const file = (account: string) => path.join(configDir(), "vault", `device.${account}.dpapi`);
  const script = (op: "Protect" | "Unprotect") =>
    `Add-Type -AssemblyName System.Security; $in = [Console]::In.ReadToEnd().Trim(); ` +
    `$out = [Security.Cryptography.ProtectedData]::${op}([Convert]::FromBase64String($in), $null, 'CurrentUser'); [Console]::Out.Write([Convert]::ToBase64String($out))`;
  return {
    name: "Windows Data Protection (DPAPI)",
    async store(account, secret) {
      checkAccount(account);
      const r = call(ps, ["-NoProfile", "-NonInteractive", "-Command", script("Protect")], secret);
      if (r.status !== 0 || !r.stdout.trim()) failed("protect the device key");
      fs.writeFileSync(file(account), r.stdout.trim(), { mode: 0o600 });
    },
    async load(account) {
      checkAccount(account);
      let blob: string;
      try {
        blob = fs.readFileSync(file(account), "utf8");
      } catch {
        return null;
      }
      const r = call(ps, ["-NoProfile", "-NonInteractive", "-Command", script("Unprotect")], blob);
      return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
    },
    async remove(account) {
      checkAccount(account);
      fs.rmSync(file(account), { force: true });
    },
  };
}

/** The credential store on this computer, or null when there is none GitRoll can use. */
export function keychainBackend(): KeychainBackend | null {
  if (process.env.GITROLL_VAULT_SECRET_TOOL) return secretService();
  if (process.platform === "darwin") return macKeychain();
  if (process.platform === "win32") return windowsDpapi();
  return secretService();
}
