// The personal vault end to end, through the command line as people and
// scripts use it: create, check the kit, unlock, store, list, edit, use, lock,
// back up, and recover on a clean device; then two devices, sync conflicts,
// device removal, rollback and tampering. Synthetic secrets only.

import "./helpers.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { COMMANDS, commandSchema } from "../src/node/cli-contract.ts";
import { MCP_VAULT_ALLOWED, isVaultCommand, mcpTools } from "../src/node/mcp.ts";
import { git, tmp } from "./helpers.ts";

const cli = fileURLToPath(new URL("../src/node/cli.ts", import.meta.url));
const SECRET = "synthetic-Pa55word-for-tests";
const devices: Device[] = [];

class Device {
  readonly home = tmp();
  readonly env: NodeJS.ProcessEnv;
  readonly passphrase: string;
  constructor(passphrase = "synthetic unlock passphrase") {
    this.passphrase = passphrase;
    // A short runtime path: Unix sockets have a length limit.
    const run = fs.mkdtempSync("/tmp/grv-");
    this.env = { GITROLL_HOME: path.join(this.home, "settings"), GITROLL_VAULT_RUNTIME: run, GITROLL_VAULT_KDF_LOG_N: "10", HOME: path.join(this.home, "home") };
    fs.mkdirSync(this.env.HOME!, { recursive: true });
    devices.push(this);
  }
  run(args: string[], input?: string) {
    const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", cli, ...args], { encoding: "utf8", cwd: this.home, env: { ...process.env, ...this.env }, input: input ?? "", timeout: 60_000 });
    assert.ifError(r.error);
    return r;
  }
  ok(args: string[], input?: string) {
    const r = this.run(args, input);
    assert.equal(r.status, 0, `${args.join(" ")}\n${r.stdout}${r.stderr}`);
    return r;
  }
  json(args: string[], input?: string) {
    return JSON.parse(this.ok([...args, "--json"], input).stdout);
  }
  fail(args: string[], code: string, input?: string) {
    const r = this.run([...args, "--json"], input);
    assert.equal(r.status, 1, `${args.join(" ")} should fail\n${r.stdout}`);
    const err = JSON.parse(r.stderr).error;
    assert.equal(err.code, code, err.message);
    return err;
  }
  unlock(name = "personal") {
    return this.json(["vault", "unlock", name, "--stdin", "--timeout", "5m"], `${this.passphrase}\n`);
  }
}
after(() => {
  for (const d of devices) d.run(["vault", "lock"]);
});

function newRoll(d: Device): string {
  const dir = path.join(tmp(), "roll");
  d.json(["init", "--dir", dir]);
  return dir;
}
/** Every byte of the Roll and its whole Git history, as text, to search for leaks. */
function everything(roll: string): string {
  const history = git(roll, "log", "--all", "-p", "--binary", "--format=%B");
  const files = fs.readdirSync(roll, { recursive: true }).map(String).filter((f) => !f.startsWith(".git/") && fs.statSync(path.join(roll, f)).isFile());
  return history + files.map((f) => fs.readFileSync(path.join(roll, f), "latin1")).join("\n");
}

async function createVault(d: Device, roll: string) {
  const kit = path.join(d.env.HOME!, "kit.txt");
  const made = d.json(["vault", "init", "personal", "-C", roll, "--stdin", "--kit", kit], `${d.passphrase}\n`);
  return { made, kit };
}

test("the personal vault journey: create, unlock, store, list, edit, use, lock, back up, recover on a clean device", async () => {
  const a = new Device();
  const roll = newRoll(a);
  const { made, kit } = await createVault(a, roll);
  assert.equal(made.recoveryChecked, false);
  assert.equal((fs.statSync(kit).mode & 0o077), 0, "the kit is private");
  assert.match(fs.readFileSync(kit, "utf8"), /^GitRoll Vault recovery kit, version 1/);
  // Setup asks for the kit to be checked, and remembers when it was.
  assert.equal(a.json(["vault", "status"]).vaults[0].recoveryChecked, false);
  a.json(["vault", "recovery-check", "personal", "--kit", kit]);
  assert.equal(a.json(["vault", "status"]).vaults[0].recoveryChecked, true);

  // Locked: nothing can be read.
  a.fail(["vault", "list", "personal"], "VAULT_LOCKED");
  a.fail(["vault", "unlock", "personal", "--stdin"], "VAULT_LOCKED", "not the passphrase\n");
  // A wrong passphrase costs a growing delay, even for the right one.
  assert.match(a.fail(["vault", "unlock", "personal", "--stdin"], "VAULT_LOCKED", `${a.passphrase}\n`).message, /Too many wrong passphrases/);
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(a.unlock().unlocked, true);

  const added = a.json(["vault", "add", "personal", "--stdin"], JSON.stringify({ title: "Bank", fields: { username: "synthetic-user", password: SECRET } }));
  assert.equal(added.item.fields.find((f: { name: string }) => f.name === "password").value, undefined, "add never echoes a secret");
  const gen = a.json(["vault", "add", "personal", "--kind", "secret", "--title", "Deploy token", "--generate", "value", "--stdin"], "{}");
  const list = a.ok(["vault", "list", "personal", "--json"]).stdout;
  assert.ok(!list.includes(SECRET), "list --json leaves secret values out");
  assert.deepEqual(JSON.parse(list).map((i: { title: string }) => i.title), ["Bank", "Deploy token"]);
  assert.match(a.ok(["vault", "show", "personal", "Bank"]).stdout, /password: ••••••••/);
  assert.equal(a.ok(["vault", "reveal", "personal", "Bank", "--field", "password"]).stdout, SECRET);
  assert.equal(a.json(["vault", "reveal", "personal", "Bank"]).value, SECRET, "reveal defaults to the first secret field");
  assert.equal(a.ok(["vault", "reveal", "personal", gen.item.id]).stdout.length, 24);
  assert.equal(a.json(["vault", "list", "personal", "bank"]).length, 1);

  // Edits need the revision they were made from.
  a.fail(["vault", "edit", "personal", "Bank", "--rev", "2", "--field", "password", "--stdin"], "CONFLICT", "new-synthetic\n");
  a.json(["vault", "edit", "personal", "Bank", "--rev", "1", "--field", "password", "--stdin"], "new-synthetic-secret\n");
  assert.equal(a.ok(["vault", "reveal", "personal", "Bank"]).stdout, "new-synthetic-secret");
  assert.equal(a.json(["vault", "show", "personal", "Bank"]).rev, 2);

  // run: the value goes to the child's environment only; arguments are passed as they are, with no shell.
  const probe = path.join(tmp(), "probe.mjs");
  fs.writeFileSync(probe, "console.log(JSON.stringify({ len: process.env.BANK_PW?.length, args: process.argv.slice(2) })); process.exit(7);");
  const r = a.run(["vault", "run", "personal", "--env", "BANK_PW=Bank:password", "--", process.execPath, probe, "$(touch /tmp/pwned)", "$BANK_PW"]);
  assert.equal(r.status, 7, "run passes the child's exit status through");
  assert.deepEqual(JSON.parse(r.stdout), { len: "new-synthetic-secret".length, args: ["$(touch /tmp/pwned)", "$BANK_PW"] });
  const missing = a.run(["vault", "run", "personal", "--json", "--env", "X=Nope", "--", process.execPath, "-e", "0"]);
  assert.equal(missing.status, 1);
  assert.equal(JSON.parse(missing.stderr).error.code, "VAULT_INVALID");

  // Remove needs confirming.
  a.fail(["vault", "remove", "personal", "Deploy token", "--rev", "1"], "INTERACTION_REQUIRED");
  a.json(["vault", "remove", "personal", "Deploy token", "--rev", "1", "--yes"]);
  assert.equal(a.json(["vault", "list", "personal"]).length, 1);

  // Backup works locked; then lock and nothing reads.
  const backup = path.join(a.env.HOME!, "personal.backup");
  a.json(["vault", "lock"]);
  a.fail(["vault", "reveal", "personal", "Bank"], "VAULT_LOCKED");
  a.json(["vault", "backup", "personal", "--out", backup]);
  assert.equal(a.json(["vault", "check", "personal"]).ok, true);

  // Nothing secret anywhere in the Roll or its history, and commit messages name no item.
  const all = everything(roll);
  for (const s of [SECRET, "new-synthetic-secret", "Bank", "synthetic-user", "Deploy token"]) assert.ok(!all.includes(s), `${s} reached the Roll`);
  assert.deepEqual(git(roll, "log", "--format=%s").trim().split("\n").slice(0, -1).every((s) => /^vault: (create|update) personal$/.test(s)), true);
  // Ordinary GitRoll reads don't see into the vault, and see nothing wrong with it.
  assert.deepEqual(a.json(["find", "Bank", "-C", roll]), []);
  assert.equal(a.json(["check", "-C", roll]).problems.length, 0);

  // A clean device with only a clone and the kit.
  const b = new Device("another synthetic passphrase");
  const clone = path.join(tmp(), "clone");
  git(tmp(), "clone", "-q", roll, clone);
  const rec = b.json(["vault", "recover", "personal", "--kit", kit, "-C", clone, "--stdin"], `${b.passphrase}\n`);
  assert.equal(rec.items, 1);
  b.unlock();
  assert.equal(b.ok(["vault", "reveal", "personal", "Bank"]).stdout, "new-synthetic-secret");

  // A clean device with only the backup file and the kit.
  const c = new Device("third synthetic passphrase");
  const empty = newRoll(c);
  assert.equal(c.json(["vault", "recover", "personal", "--kit", kit, "--from", backup, "-C", empty, "--stdin"], `${c.passphrase}\n`).source, "backup");
  c.unlock();
  assert.equal(c.ok(["vault", "reveal", "personal", "Bank"]).stdout, "new-synthetic-secret");
});

test("two devices: enroll, edit at once, sync, merge without losing either edit, then remove one", async () => {
  const remote = path.join(tmp(), "remote.git");
  git(tmp(), "init", "-q", "--bare", "-b", "main", remote);
  const a = new Device();
  const rollA = newRoll(a);
  git(rollA, "remote", "add", "origin", remote);
  await createVault(a, rollA);
  a.unlock();
  a.json(["vault", "add", "personal", "--stdin"], JSON.stringify({ title: "Bank", fields: { password: "one" } }));
  a.json(["vault", "add", "personal", "--stdin"], JSON.stringify({ title: "Mail", fields: { password: "mail" } }));
  assert.equal(a.json(["sync", "-C", rollA]).ok, true);

  const b = new Device("device b synthetic");
  const rollB = path.join(tmp(), "rollB");
  git(tmp(), "clone", "-q", remote, rollB);
  const req = b.json(["vault", "device-request", "--stdin"], `${b.passphrase}\n`);
  b.fail(["vault", "unlock", "personal", "--stdin"], "NOT_FOUND", `${b.passphrase}\n`);
  const added = a.json(["vault", "device-add", "personal", req.request, "--yes"]);
  assert.equal(added.code, req.code, "both devices show the same code");
  a.json(["sync", "-C", rollA]);
  // Before syncing, the new device can't join: the vault doesn't list it yet.
  b.fail(["vault", "device-join", "personal", added.checkpoint, "-C", rollB], "VAULT_ROLLBACK");
  git(rollB, "pull", "-q");
  b.json(["vault", "device-join", "personal", added.checkpoint, "-C", rollB]);
  b.unlock();
  assert.equal(b.ok(["vault", "reveal", "personal", "Bank"]).stdout, "one");

  // Both change Bank differently; B also changes Mail and adds Wifi.
  a.json(["vault", "edit", "personal", "Bank", "--rev", "1", "--field", "password", "--stdin"], "from-a\n");
  b.json(["vault", "edit", "personal", "Bank", "--rev", "1", "--field", "password", "--stdin"], "from-b\n");
  b.json(["vault", "edit", "personal", "Mail", "--rev", "1", "--field", "password", "--stdin"], "mail-b\n");
  b.json(["vault", "add", "personal", "--stdin"], JSON.stringify({ title: "Wifi", fields: { password: "wifi" } }));
  assert.equal(a.json(["sync", "-C", rollA]).ok, true);
  assert.equal(b.json(["sync", "-C", rollB]).ok, true, "sync takes the other side's state and keeps this one aside");
  const titles = b.json(["vault", "list", "personal"]).map((i: { title: string }) => i.title);
  assert.deepEqual(titles, ["Bank", "Bank (conflict)", "Mail", "Wifi"]);
  assert.equal(b.ok(["vault", "reveal", "personal", "Bank"]).stdout, "from-a");
  assert.equal(b.ok(["vault", "reveal", "personal", "Bank (conflict)"]).stdout, "from-b");
  assert.equal(b.ok(["vault", "reveal", "personal", "Mail"]).stdout, "mail-b");
  b.json(["sync", "-C", rollB]);
  a.json(["sync", "-C", rollA]);
  assert.equal(a.json(["vault", "list", "personal"]).length, 4);

  // A removes B: a new vault key, and B can't open the vault any more.
  const before = JSON.parse(fs.readFileSync(path.join(rollA, ".gitroll/vault/personal/state.json"), "utf8")).trust.at(-1).epoch;
  const removed = a.json(["vault", "device-remove", "personal", req.device, "--yes"]);
  assert.equal(removed.epoch, before + 1);
  a.json(["sync", "-C", rollA]);
  b.json(["vault", "lock"]);
  git(rollB, "pull", "-q");
  b.fail(["vault", "unlock", "personal", "--stdin"], "VAULT_FORBIDDEN", `${b.passphrase}\n`);
});

test("a rolled-back or tampered vault is refused", async () => {
  const a = new Device();
  const roll = newRoll(a);
  await createVault(a, roll);
  a.unlock();
  a.json(["vault", "add", "personal", "--stdin"], JSON.stringify({ title: "Bank", fields: { password: "x" } }));
  a.json(["vault", "add", "personal", "--stdin"], JSON.stringify({ title: "Mail", fields: { password: "y" } }));
  const state = ".gitroll/vault/personal/state.json";
  // Someone with write access to the repository restores an older state.
  git(roll, "checkout", "HEAD~1", "--", state);
  a.fail(["vault", "check", "personal"], "VAULT_ROLLBACK");
  a.fail(["vault", "list", "personal"], "VAULT_ROLLBACK");
  git(roll, "checkout", "HEAD", "--", state);
  assert.equal(a.json(["vault", "check", "personal"]).ok, true);
  // Changing an object's bytes.
  const objects = path.join(roll, ".gitroll/vault/personal/objects");
  const file = path.join(objects, fs.readdirSync(objects)[0]);
  const original = fs.readFileSync(file);
  fs.writeFileSync(file, Buffer.concat([original, Buffer.from("x")]));
  const r = a.run(["vault", "check", "personal", "--json"]);
  assert.equal(r.status, 1);
  assert.match(JSON.parse(r.stdout).problems.join(" "), /was changed/);
  fs.writeFileSync(file, original);
  // Editing the signed state by hand.
  const text = fs.readFileSync(path.join(roll, state), "utf8");
  fs.writeFileSync(path.join(roll, state), text.replace(/"rev": 1/, '"rev": 9'));
  a.fail(["vault", "list", "personal"], "VAULT_TAMPERED");
  fs.writeFileSync(path.join(roll, state), text);
  // A symbolic link inside the vault is refused.
  fs.symlinkSync("/etc/passwd", path.join(objects, "link"));
  a.fail(["vault", "check", "personal"], "VAULT_TAMPERED");
});

test("secrets never come from arguments, and noninteractive calls don't prompt", () => {
  const a = new Device();
  const roll = newRoll(a);
  a.fail(["vault", "init", "personal", "-C", roll], "INTERACTION_REQUIRED");
  // There is no option that takes a value: --password is not an option at all.
  const r = a.run(["vault", "add", "personal", "--password", "x", "--json"]);
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stderr).error.code, "INVALID_ARGUMENT");
  assert.ok(!r.stderr.includes('"x"'));
});

test("vault commands are never MCP tools, and a new one can't become one by accident", () => {
  const tools = mcpTools();
  assert.ok(!tools.some((t) => isVaultCommand(t.command)), "no vault or secrets tool");
  assert.equal(COMMANDS.vault.mcp, false);
  assert.equal(MCP_VAULT_ALLOWED.size, 0);
  for (const name of ["vault", "vault-x", "vault_reveal", "secrets", "secrets-run"]) assert.ok(isVaultCommand(name), name);
  for (const name of ["vaulted", "secretsauce", "find"]) assert.ok(!isVaultCommand(name), name);
  // Every command in the catalog that is a vault command is excluded, whatever its own flags say.
  for (const name of Object.keys(COMMANDS).filter(isVaultCommand)) assert.ok(!tools.some((t) => t.command === name), name);
  assert.ok(commandSchema("vault").error.codes.includes("VAULT_LOCKED"));
});

test("the broker refuses a request without its session token, and oversized requests", async () => {
  const a = new Device();
  const roll = newRoll(a);
  await createVault(a, roll);
  a.unlock();
  const socket = path.join(a.env.GITROLL_VAULT_RUNTIME!, "broker.sock");
  assert.equal(fs.statSync(a.env.GITROLL_VAULT_RUNTIME!).mode & 0o077, 0, "runtime folder is private");
  assert.equal(fs.statSync(path.join(a.env.GITROLL_VAULT_RUNTIME!, "session")).mode & 0o077, 0, "token file is private");
  const ask = (line: string) =>
    new Promise<string>((resolve, reject) => {
      const s = net.createConnection(socket);
      let data = "";
      s.on("connect", () => s.write(line));
      s.on("data", (c) => (data += c));
      s.on("close", () => resolve(data));
      s.on("error", reject);
    });
  const id = JSON.parse(fs.readFileSync(path.join(a.env.GITROLL_HOME!, "vault", "vaults.json"), "utf8"));
  const vault = Object.keys(id.vaults)[0];
  const reply = JSON.parse(await ask(`${JSON.stringify({ v: 1, token: "guess", op: "resolve", vault, refs: [{ item: "x" }] })}\n`));
  assert.equal(reply.error.code, "VAULT_FORBIDDEN");
  const big = JSON.parse(await ask(`{"v":1,"pad":"${"x".repeat(1_100_000)}"}\n`).catch(() => '{"ok":false,"error":{"code":"VAULT_INVALID"}}'));
  assert.equal(big.ok, false);
});

test("a device key kept in the system credential store unlocks without a passphrase", async () => {
  const a = new Device();
  // A stand-in for secret-tool that keeps secrets in a file, reading them from stdin like the real one.
  const store = path.join(a.home, "store.json");
  const tool = path.join(a.home, "secret-tool");
  fs.writeFileSync(tool, `#!${process.execPath}\nconst fs=require("fs");const f=${JSON.stringify(store)};const db=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,"utf8")):{};const [op,...a]=process.argv.slice(2);const acct=a[a.indexOf("account")+1];\nif(!op)process.exit(2);if(op==="store"){db[acct]=fs.readFileSync(0,"utf8");fs.writeFileSync(f,JSON.stringify(db));}else if(op==="lookup"){if(!db[acct])process.exit(1);process.stdout.write(db[acct]);}else if(op==="clear"){delete db[acct];fs.writeFileSync(f,JSON.stringify(db));}\n`, { mode: 0o755 });
  a.env.GITROLL_VAULT_SECRET_TOOL = tool;
  const roll = newRoll(a);
  a.json(["vault", "init", "personal", "-C", roll, "--protect", "keychain", "--kit", path.join(a.env.HOME!, "kit.txt")]);
  assert.ok(!fs.existsSync(path.join(a.env.GITROLL_HOME!, "vault", "device.age")), "no key file when the store holds it");
  a.json(["vault", "unlock", "personal"]);
  a.json(["vault", "add", "personal", "--stdin"], JSON.stringify({ title: "T", fields: { password: "p" } }));
  assert.equal(a.ok(["vault", "reveal", "personal", "T"]).stdout, "p");
  // Moving it to a passphrase.
  a.json(["vault", "passphrase", "--protect", "passphrase", "--stdin"], "a new synthetic passphrase\n");
  assert.ok(fs.existsSync(path.join(a.env.GITROLL_HOME!, "vault", "device.age")));
  a.json(["vault", "lock"]);
  a.json(["vault", "unlock", "personal", "--stdin"], "a new synthetic passphrase\n");
});

test("an interrupted write leaves the vault readable, and the next change finishes or clears what it left", async () => {
  const a = new Device();
  const roll = newRoll(a);
  await createVault(a, roll);
  a.unlock();
  const add = (title: string) => a.json(["vault", "add", "personal", "--stdin"], JSON.stringify({ title, fields: { password: SECRET } }));
  add("Bank");
  const dir = path.join(roll, ".gitroll/vault/personal");

  // Stopped after state.json was replaced, before the commit (power cut, or a commit hook refused).
  add("Email");
  git(roll, "reset", "-q", "HEAD~1");
  assert.match(git(roll, "status", "--porcelain"), /\.gitroll\/vault\/personal/);
  assert.deepEqual(a.json(["vault", "list", "personal"]).map((i: { title: string }) => i.title), ["Bank", "Email"], "the newest state on disk is the vault");

  // Stopped while writing: half-written temporary files, and an object no state lists yet.
  fs.writeFileSync(path.join(dir, "objects", ".tmp-0123456789abcdef"), "partial object");
  fs.writeFileSync(path.join(dir, ".tmp-fedcba9876543210"), "{ partial state");
  const orphan = crypto.randomBytes(200);
  const orphanName = `${crypto.createHash("sha256").update(orphan).digest("hex")}.age`;
  fs.writeFileSync(path.join(dir, "objects", orphanName), orphan);
  assert.equal(a.ok(["vault", "reveal", "personal", "Bank"]).stdout, SECRET, "still reads");
  const check = a.run(["vault", "check", "personal", "--json"]);
  assert.equal(check.status, 1);
  const problems: string[] = JSON.parse(check.stdout).problems;
  assert.equal(problems.length, 3);
  assert.ok(problems.every((p) => /interrupted write/.test(p)), problems.join("\n"));

  // The next change commits what was left uncommitted and clears the leftovers.
  add("Third");
  assert.equal(git(roll, "status", "--porcelain").trim(), "");
  for (const f of ["objects/.tmp-0123456789abcdef", ".tmp-fedcba9876543210", `objects/${orphanName}`]) assert.ok(!fs.existsSync(path.join(dir, f)), `${f} was cleared`);
  assert.ok(!git(roll, "log", "--all", "--name-only", "--format=").includes(".tmp-"), "no temporary file was ever committed");
  assert.equal(a.json(["vault", "check", "personal"]).ok, true);
  assert.equal(a.json(["vault", "list", "personal"]).length, 3);
});
