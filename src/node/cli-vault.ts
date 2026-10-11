// `gitroll vault …`: personal passwords and developer secrets, encrypted on this
// computer before anything is written, kept in a Roll, and opened only by the
// devices and recovery kit that are members (docs/VAULT-FORMAT.md).
//
// Secret values are read from hidden prompts or standard input (--stdin), never
// from arguments. Listings and JSON leave values out; `reveal` and `run` are
// the only ways out, and each names what it wants. None of this is offered over
// MCP (mcp.ts).

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { X25519Identity } from "../core/age/format.ts";
import { NotFoundError, UserError } from "../core/util.ts";
import { OBJECT_FILE, STATE_FILE, VAULT_NAME, VaultError, newId, openState, referencedObjects } from "../core/vault/format.ts";
import { KIND, KIND_FIELDS, isSecretName, openItem } from "../core/vault/items.ts";
import type { VaultField } from "../core/vault/items.ts";
import { changeMembers, createVault } from "../core/vault/ops.ts";
import { CliError } from "./cli-contract.ts";
import type { GitRoll } from "./repo.ts";
import { MAX_TIMEOUT_S, runBroker } from "./vault/broker.ts";
import { brokerRequest, brokerRunning, startBroker } from "./vault/client.ts";
import { nodeVaultCrypto as crypto } from "./vault/crypto.ts";
import { createDevice, deviceInfo, reprotectDevice, unlockDevice } from "./vault/device.ts";
import type { Protection, UnlockedDevice } from "./vault/device.ts";
import { decodeCheckpoint, decodeRequest, encodeRequest, shortCode } from "./vault/enroll.ts";
import { findLocalVault, localVaults, markRecoveryChecked, putLocalVault } from "./vault/local.ts";
import type { LocalVault } from "./vault/local.ts";
import { generatePassword, hidden, newPassphrase, stdinText, visible } from "./vault/prompt.ts";
import type { Asker } from "./vault/prompt.ts";
import { checkKit, kitMember, kitText, makeBackup, openBackup, parseKit, writeSecretFile } from "./vault/recovery.ts";
import { VaultFiles, vaultFiles, verifiedState } from "./vault/store.ts";

type Values = Record<string, string | boolean | string[] | undefined>;
export interface VaultContext {
  json: boolean;
  nonInteractive: boolean;
  /** The Roll named by -C/--roll, or the default one. */
  openRoll: () => GitRoll;
  /** Whether -C or --roll was given. */
  rollGiven: boolean;
  /** For `run`: the command after --. */
  childArgv: string[] | null;
  ok(text: string): void;
  warn(text: string): void;
  dim(text: string): string;
  confirm(question: string): Promise<boolean>;
}

export const VAULT_ACTIONS = [
  "init", "recovery-check", "unlock", "lock", "status", "add", "list", "show", "edit", "remove", "reveal", "run",
  "backup", "recover", "check", "devices", "device-request", "device-add", "device-join", "device-remove", "rotate", "passphrase",
] as const;

export const VAULT_USAGE = `Vault: passwords and developer secrets, encrypted on this computer (see SECURITY.md)
  vault init <name> [--kit <file>] [--protect passphrase|keychain]
                               Create a vault in this Roll, and its recovery kit (keep it offline)
  vault recovery-check <name> --kit <file>
                               Check the recovery kit opens the vault (setup isn't finished until it does)
  vault unlock <name> [--timeout 15m]   Open it for a while; vault lock [<name>] closes it
  vault add <name> [--kind login|note|secret|card] [--title <title>] [--generate <field>]
                               Values are asked for without echo, or read as JSON with --stdin
  vault list <name> [words]    Titles and field names, never values
  vault show <name> <item>     One item, with secret values hidden
  vault reveal <name> <item> [--field <name>] [--notes]
  vault edit <name> <item> --rev <n> [--title <t>] [--field <name> ...] [--unset <name>] [--stdin]
  vault remove <name> <item> --rev <n>
  vault run <name> --env VAR=<item>[:<field>] ... -- <command> [args]
                               Run a command with secrets in its environment, no shell involved
  vault backup <name> --out <file>      One encrypted file a member or the recovery kit can restore
  vault recover <name> --kit <file> [--from <backup>]
                               Enroll this computer with the recovery kit (a clean device, a lost one)
  vault check <name>           Authenticate the vault's files without unlocking it
  vault devices <name>         Members; vault device-request, device-add, device-join, device-remove
  vault rotate <name>          A new vault key, every item re-encrypted to it
  vault passphrase [--protect passphrase|keychain]   Change how this device's key is protected
`;

const print = (data: unknown) => console.log(JSON.stringify(data, null, 2));
const invalid = (message: string): never => {
  throw new CliError("INVALID_ARGUMENT", message);
};
const one = (v: Values, flag: string): string | undefined => {
  const x = v[flag];
  return Array.isArray(x) ? x[x.length - 1] : typeof x === "string" ? x : undefined;
};
const many = (v: Values, flag: string): string[] => {
  const x = v[flag];
  return Array.isArray(x) ? x : typeof x === "string" ? [x] : [];
};

function vaultName(name: string | undefined): string {
  if (!name) invalid("Name the vault, e.g. gitroll vault list personal");
  if (!VAULT_NAME.test(name!)) invalid("A vault name is 1–32 lowercase letters, digits and dashes, like personal.");
  return name!;
}

function revOption(v: Values): number {
  const raw = one(v, "rev");
  if (raw === undefined || !/^[1-9]\d{0,15}$/.test(raw)) invalid("--rev <n> is required: the item's revision from gitroll vault show (or list --json). The change is refused if the item changed since.");
  return Number(raw);
}

function timeoutOption(v: Values): number | undefined {
  const raw = one(v, "timeout");
  if (raw === undefined) return undefined;
  const m = /^(\d+)\s*(s|m|h)?$/.exec(raw.trim());
  if (!m) invalid("--timeout takes a duration like 90s, 15m or 2h.");
  const seconds = Number(m![1]) * (m![2] === "h" ? 3600 : m![2] === "m" ? 60 : m![2] === "s" ? 1 : 60);
  if (seconds < 1 || seconds > MAX_TIMEOUT_S) invalid("--timeout must be between 1 second and 12 hours.");
  return seconds;
}

function protectionOption(v: Values): Protection | undefined {
  const p = one(v, "protect");
  if (p === undefined) return undefined;
  if (p !== "passphrase" && p !== "keychain") invalid("--protect is passphrase or keychain.");
  return p as Protection;
}

const asker = (v: Values, ctx: VaultContext): Asker => ({ stdin: !!v.stdin, nonInteractive: ctx.nonInteractive });

/** This device's key, opened: made first if there isn't one. */
async function openOrCreateDevice(v: Values, ctx: VaultContext, stdinIndex = 0): Promise<{ device: UnlockedDevice; created: boolean }> {
  const info = deviceInfo();
  if (info) {
    const pass = info.protection === "passphrase" ? await hidden("This device's unlock passphrase: ", asker(v, ctx), stdinIndex) : null;
    return { device: await unlockDevice(pass), created: false };
  }
  const protection = protectionOption(v) ?? "passphrase";
  if (!ctx.json && !v.stdin && protection === "passphrase") console.error("This computer needs a device key for vaults, protected by an unlock passphrase. If you forget it, the recovery kit gets you back in.");
  const pass = protection === "passphrase" ? await newPassphrase("Choose an unlock passphrase: ", asker(v, ctx), stdinIndex) : null;
  return { device: await createDevice(protection, pass), created: true };
}

function entryFor(name: string, ctx: VaultContext): LocalVault {
  return findLocalVault(name, ctx.rollGiven ? ctx.openRoll().root : undefined);
}

/** Fields for a new item: JSON on stdin, or one prompt per field (hidden for secret ones). */
async function itemInput(v: Values, ctx: VaultContext, kind: string): Promise<{ title?: string; fields: VaultField[]; notes?: string; kind?: string }> {
  if (v.stdin) {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(await stdinText()) as Record<string, unknown>;
    } catch {
      return invalid('--stdin takes JSON: {"title": "…", "fields": {"username": "…", "password": "…"}, "notes": "…"}');
    }
    return { title: typeof data.title === "string" ? data.title : undefined, kind: typeof data.kind === "string" ? data.kind : undefined, notes: typeof data.notes === "string" ? data.notes : undefined, fields: parseFields(data.fields) };
  }
  const ask = asker(v, ctx);
  const fields: VaultField[] = [];
  const generate = one(v, "generate");
  for (const name of KIND_FIELDS[kind] ?? []) {
    if (name === generate) continue;
    const secret = isSecretName(name);
    const value = secret ? await hidden(`${name}: `, ask) : await visible(`${name}: `, ask);
    if (value) fields.push({ name, value, secret });
  }
  for (;;) {
    const name = await visible("Another field (its name, or Enter to finish): ", ask);
    if (!name) break;
    const secret = isSecretName(name) || /^y/i.test(await visible(`Is ${name} secret? (y/N) `, ask));
    fields.push({ name, value: secret ? await hidden(`${name}: `, ask) : await visible(`${name}: `, ask), secret });
  }
  return { fields };
}

function parseFields(raw: unknown): VaultField[] {
  if (raw === undefined) return [];
  if (Array.isArray(raw)) {
    return raw.map((f) => {
      const o = (f ?? {}) as Record<string, unknown>;
      if (typeof o.name !== "string" || typeof o.value !== "string") invalid("Each field needs a name and a string value.");
      return { name: o.name as string, value: o.value as string, secret: typeof o.secret === "boolean" ? o.secret : isSecretName(o.name as string) };
    });
  }
  if (raw && typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>).map(([name, value]) => {
      if (typeof value !== "string") invalid(`The field ${name} needs a string value.`);
      return { name, value: value as string, secret: isSecretName(name) };
    });
  }
  return invalid("fields must be an object of name: value, or a list of {name, value, secret}.");
}

interface Shown {
  id: string;
  rev: number;
  kind: string;
  title: string;
  fields: { name: string; secret: boolean; value?: string }[];
  notes: boolean | string;
  created: string;
  updated: string;
}

function printItem(item: Shown, ctx: VaultContext): void {
  console.log(`${item.title}  ${ctx.dim(`${item.kind} · ${item.id} · rev ${item.rev}`)}`);
  for (const f of item.fields) console.log(`  ${f.name}: ${f.value !== undefined ? f.value : "••••••••"}`);
  if (typeof item.notes === "string") console.log(item.notes ? `\n${item.notes}` : "");
  else if (item.notes) console.log(ctx.dim("  (has notes: gitroll vault reveal … --notes)"));
}

export async function vaultCommand(args: string[], v: Values, ctx: VaultContext): Promise<void> {
  const [action, ...rest] = args;
  if (action === "__broker") return runBroker();
  if (!action) {
    if (ctx.json) return print({ actions: VAULT_ACTIONS });
    return void process.stdout.write(VAULT_USAGE);
  }
  if (!(VAULT_ACTIONS as readonly string[]).includes(action)) invalid(`“${action}” isn't a vault command. Run: gitroll vault`);
  if (action !== "run" && ctx.childArgv) invalid("Only gitroll vault run takes a command after --.");
  switch (action) {
    case "init":
      return init(vaultName(rest[0]), v, ctx);
    case "recovery-check": {
      const entry = entryFor(vaultName(rest[0]), ctx);
      const kit = await readKit(v);
      const files = vaultFiles(entry);
      const { state } = await verifiedState(files, entry);
      await checkKit(kit, state, files.readObject(state.snapshot.keys));
      markRecoveryChecked(entry.id);
      if (ctx.json) return print({ vault: entry.name, recoveryChecked: true });
      ctx.ok("The recovery kit opens this vault. Setup is complete; keep the kit offline.");
      return;
    }
    case "unlock": {
      const entry = entryFor(vaultName(rest[0]), ctx);
      const info = deviceInfo();
      if (!info) throw new UserError("This computer has no vault device key. Recover with your kit: gitroll vault recover");
      const passphrase = info.protection === "passphrase" ? await hidden("Unlock passphrase: ", asker(v, ctx)) : null;
      await startBroker();
      const r = await brokerRequest<{ expiresAt: string; recoveryChecked: boolean }>("unlock", { vault: entry.id, passphrase, timeout: timeoutOption(v) });
      if (ctx.json) return print({ vault: entry.name, unlocked: true, expiresAt: r.expiresAt, recoveryChecked: r.recoveryChecked });
      ctx.ok(`Unlocked ${entry.name} until ${new Date(r.expiresAt).toLocaleTimeString()} (if left idle). Lock it with: gitroll vault lock`);
      if (!r.recoveryChecked) ctx.warn(`Setup isn't finished: check the recovery kit with gitroll vault recovery-check ${entry.name} --kit <file>`);
      return;
    }
    case "lock": {
      const id = rest[0] ? entryFor(vaultName(rest[0]), ctx).id : undefined;
      const locked = (await brokerRunning()) ? (await brokerRequest<{ locked: string[] }>("lock", id ? { vault: id } : {})).locked : [];
      if (ctx.json) return print({ locked: locked.map((x) => localVaults().find((l) => l.id === x)?.name ?? x) });
      return console.log(locked.length ? `Locked.` : "Nothing was unlocked.");
    }
    case "status":
      return status(rest[0], ctx);
    case "add": {
      const entry = entryFor(vaultName(rest[0]), ctx);
      const input = await itemInput(v, ctx, one(v, "kind") ?? "login");
      const kind = one(v, "kind") ?? input.kind ?? "login";
      if (!KIND.test(kind)) invalid("--kind is a word like login, note, secret or card.");
      const title = one(v, "title") ?? input.title ?? (await visible("Title: ", asker(v, ctx)));
      const fields = [...input.fields];
      const generate = one(v, "generate");
      if (generate) {
        if (fields.some((f) => f.name === generate)) invalid(`--generate ${generate} and a value for ${generate}: choose one.`);
        fields.push({ name: generate, value: generatePassword(), secret: true });
      }
      const r = await brokerRequest<{ item: Shown; commit: string | null }>("add", { vault: entry.id, item: { kind, title, fields, notes: input.notes } });
      if (ctx.json) return print(r);
      ctx.ok(`Saved “${r.item.title}” (${r.item.id}).${generate ? ` Generated a ${generate}; see it with: gitroll vault reveal ${entry.name} ${r.item.id} --field ${generate}` : ""}`);
      return;
    }
    case "list": {
      const entry = entryFor(vaultName(rest[0]), ctx);
      const r = await brokerRequest<{ items: Shown[] }>("list", { vault: entry.id, query: rest.slice(1).join(" ") });
      if (ctx.json) return print(r.items);
      if (!r.items.length) return console.log(rest.length > 1 ? "No items match." : `The vault is empty. Add something: gitroll vault add ${entry.name}`);
      for (const i of r.items) console.log(`${i.title}  ${ctx.dim(`${i.kind} · ${i.id} · ${i.fields.map((f) => f.name).join(", ")}`)}`);
      return;
    }
    case "show": {
      const entry = entryFor(vaultName(rest[0]), ctx);
      const r = await brokerRequest<{ item: Shown }>("get", { vault: entry.id, item: need(rest[1], "gitroll vault show <name> <item>") });
      if (ctx.json) return print(r.item);
      return printItem(r.item, ctx);
    }
    case "reveal": {
      const entry = entryFor(vaultName(rest[0]), ctx);
      const item = need(rest[1], "gitroll vault reveal <name> <item> [--field <name>]");
      if (v.notes) {
        const r = await brokerRequest<{ item: Shown }>("get", { vault: entry.id, item, notes: true });
        if (ctx.json) return print({ id: r.item.id, notes: r.item.notes });
        return void process.stdout.write(`${r.item.notes}`);
      }
      const r = await brokerRequest<{ values: string[] }>("resolve", { vault: entry.id, refs: [{ item, field: one(v, "field") }] });
      if (ctx.json) return print({ item, field: one(v, "field") ?? null, value: r.values[0] });
      return void process.stdout.write(`${r.values[0]}${process.stdout.isTTY ? "\n" : ""}`);
    }
    case "edit": {
      const entry = entryFor(vaultName(rest[0]), ctx);
      const item = need(rest[1], "gitroll vault edit <name> <item> --rev <n>");
      const rev = revOption(v);
      const patch: { title?: string; notes?: string; kind?: string; set: VaultField[]; unset: string[] } = { set: [], unset: many(v, "unset") };
      if (one(v, "title") !== undefined) patch.title = one(v, "title");
      if (one(v, "kind") !== undefined) patch.kind = one(v, "kind");
      const named = many(v, "field");
      if (v.stdin && !named.length) {
        const input = await itemInput(v, ctx, "");
        patch.set = input.fields;
        if (input.title !== undefined) patch.title = input.title;
        if (input.notes !== undefined) patch.notes = input.notes;
      }
      // Always typed without echo (or one line of stdin each, in order); a field stays secret if it was, or if its name says so.
      for (const [i, name] of named.entries()) patch.set.push({ name, value: await hidden(`New ${name}: `, asker(v, ctx), i), secret: isSecretName(name) });
      const generate = one(v, "generate");
      if (generate) patch.set.push({ name: generate, value: generatePassword(), secret: true });
      if (patch.title === undefined && patch.kind === undefined && patch.notes === undefined && !patch.set.length && !patch.unset.length) invalid("Say what to change: --title, --field <name>, --generate <name>, --unset <name>, or --stdin.");
      const r = await brokerRequest<{ item: Shown; commit: string | null }>("edit", { vault: entry.id, item, rev, patch });
      if (ctx.json) return print(r);
      ctx.ok(`Saved “${r.item.title}” (rev ${r.item.rev}).`);
      return;
    }
    case "remove": {
      const entry = entryFor(vaultName(rest[0]), ctx);
      const item = need(rest[1], "gitroll vault remove <name> <item> --rev <n>");
      const rev = revOption(v);
      if (!(await ctx.confirm("Remove that item from the vault? Its earlier versions stay in Git history, encrypted."))) return;
      const r = await brokerRequest<{ removed: { id: string; title: string }; commit: string | null }>("remove", { vault: entry.id, item, rev });
      if (ctx.json) return print(r);
      ctx.ok(`Removed “${r.removed.title}”. If it was a password, it stays readable to anyone who had a copy of the vault key: change it where it's used.`);
      return;
    }
    case "run":
      return run(vaultName(rest[0]), v, ctx);
    case "backup": {
      const entry = entryFor(vaultName(rest[0]), ctx);
      const out = one(v, "out") ?? invalid("Usage: gitroll vault backup <name> --out <file>");
      const files = vaultFiles(entry);
      const { state, bytes } = await verifiedState(files, entry);
      const backup = await makeBackup(entry.name, state, bytes, (h) => files.readObject(h));
      const file = writeSecretFile(out!, backup, "backup");
      if (ctx.json) return print({ vault: entry.name, path: file, items: state.snapshot.items.length, snapshot: state.snapshot.seq });
      ctx.ok(`Backed up ${plural(state.snapshot.items.length, "item")} to ${file}. It opens only with a member device or the recovery kit.`);
      return;
    }
    case "recover":
      return recover(vaultName(rest[0]), v, ctx);
    case "check":
      return check(vaultName(rest[0]), ctx);
    case "devices": {
      const entry = entryFor(vaultName(rest[0]), ctx);
      const { state } = await verifiedState(vaultFiles(entry), entry);
      const members = state.chain.head.members.map((m) => ({ id: m.id, role: m.role, thisDevice: m.id === entry.member }));
      if (ctx.json) return print({ vault: entry.name, epoch: state.chain.head.epoch, members });
      for (const m of members) console.log(`${m.id}  ${m.role}${m.thisDevice ? " (this device)" : ""}`);
      return;
    }
    case "device-request": {
      const { device } = await openOrCreateDevice(v, ctx);
      const request = encodeRequest(device.member);
      const code = await shortCode(request);
      if (ctx.json) return print({ request, code, device: device.member.id });
      console.log(request);
      console.error(`\nOn a device that's already a member, run:\n  gitroll vault device-add <name> '${request}'\nand check it shows this code: ${code}`);
      return;
    }
    case "device-add": {
      const entry = entryFor(vaultName(rest[0]), ctx);
      const request = need(rest[1], "gitroll vault device-add <name> <request>");
      const member = decodeRequest(request);
      const code = await shortCode(request.trim());
      if (!(await ctx.confirm(`Add the device whose code is ${code}? Only say yes if the new device shows the same code.`))) return;
      const r = await brokerRequest<{ checkpoint: string; commit: string | null }>("add-member", { vault: entry.id, member });
      if (ctx.json) return print({ vault: entry.name, device: member.id, code, ...r });
      ctx.ok("Added. Sync this Roll, then on the new device run:");
      console.log(`  gitroll vault device-join ${entry.name} '${r.checkpoint}'`);
      return;
    }
    case "device-join":
      return join(vaultName(rest[0]), need(rest[1], "gitroll vault device-join <name> <checkpoint>"), ctx);
    case "device-remove": {
      const entry = entryFor(vaultName(rest[0]), ctx);
      const member = need(rest[1], "gitroll vault device-remove <name> <device-id>");
      if (!(await ctx.confirm("Remove that device? The vault gets a new key and every item is re-encrypted."))) return;
      const r = await brokerRequest<{ epoch: number; commit: string | null }>("remove-member", { vault: entry.id, member });
      if (ctx.json) return print({ vault: entry.name, removed: member, ...r });
      ctx.ok(`Removed, and re-encrypted everything to a new vault key (epoch ${r.epoch}).`);
      ctx.warn("That device can still read what it already had, and every earlier version in Git history. Change the passwords and tokens it could see.");
      return;
    }
    case "rotate": {
      const entry = entryFor(vaultName(rest[0]), ctx);
      if (!(await ctx.confirm("Make a new vault key and re-encrypt every item?"))) return;
      const r = await brokerRequest<{ epoch: number; commit: string | null }>("rotate", { vault: entry.id });
      if (ctx.json) return print({ vault: entry.name, ...r });
      ctx.ok(`Re-encrypted everything to a new vault key (epoch ${r.epoch}).`);
      return;
    }
    case "passphrase": {
      const info = deviceInfo();
      if (!info) throw new UserError("This computer has no vault device key yet.");
      const ask = asker(v, ctx);
      const device = await unlockDevice(info.protection === "passphrase" ? await hidden("Current unlock passphrase: ", ask, 0) : null);
      const protection = protectionOption(v) ?? "passphrase";
      const next = protection === "passphrase" ? await newPassphrase("New unlock passphrase: ", ask, info.protection === "passphrase" ? 1 : 0) : null;
      await reprotectDevice(device, protection, next);
      if (ctx.json) return print({ device: info.id, protection });
      ctx.ok(protection === "keychain" ? "This device's key is now kept in the system credential store." : "Changed. The vault key and items didn't change.");
      return;
    }
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function need(value: string | undefined, usage: string): string {
  if (!value?.trim()) invalid(`Usage: ${usage}`);
  return value!;
}

async function readKit(v: Values) {
  const file = one(v, "kit") ?? invalid("--kit <file> is required: the recovery kit made when the vault was created.");
  let text: string;
  try {
    text = fs.readFileSync(path.resolve(file!), "utf8");
  } catch {
    throw new UserError(`Couldn't read the recovery kit at ${file}.`);
  }
  return parseKit(text);
}

async function init(name: string, v: Values, ctx: VaultContext): Promise<void> {
  const roll = ctx.openRoll();
  const files = new VaultFiles(roll, name);
  if (files.exists()) throw new UserError(`This Roll already has a vault called ${name}.`);
  if (localVaults().some((l) => l.name === name && path.resolve(l.roll) === roll.root)) throw new UserError(`This device already has a vault called ${name} in this Roll.`);
  const kitPath = path.resolve(one(v, "kit") ?? path.join(os.homedir(), `gitroll-vault-${name}-recovery-kit.txt`));
  if (fs.existsSync(kitPath)) throw new UserError(`${kitPath} already exists. Choose where the recovery kit goes with --kit <file>.`);
  const { device } = await openOrCreateDevice(v, ctx);
  const recoveryKey = await X25519Identity.generate(crypto);
  const seed = await crypto.randomBytes(32);
  const recoveryId = await newId(crypto);
  const recovery = await kitMember({ name, vault: "", member: recoveryId, age: recoveryKey, seed });
  const write = await createVault(device.member, recovery, { id: device.member.id, seed: device.seed }, crypto);
  // The kit first: a vault that exists without its kit is one lost device away from gone.
  const kitFile = writeSecretFile(kitPath, kitText({ name, vault: write.vaultId, member: recoveryId, age: recoveryKey, seed }), "recovery kit");
  const commit = files.apply(write, null, `vault: create ${name}`);
  const state = await openState(files.readState(), crypto, { expectVault: write.vaultId });
  putLocalVault({ id: write.vaultId, name, roll: roll.root, member: device.member.id, pin: state.pin, recoveryChecked: false, added: new Date().toISOString() });
  const events = roll.entries().length + roll.notes().length;
  if (ctx.json) return print({ vault: name, id: write.vaultId, path: files.dir, kit: kitFile, device: device.member.id, commit, recoveryChecked: false });
  ctx.ok(`Created the vault ${name} in ${files.dir}.`);
  console.log(`Recovery kit: ${kitFile}`);
  console.log("Print it or copy it somewhere offline, then delete it from this computer. It's the only way back in if every device is lost: no GitRoll account or service can open this vault.");
  ctx.warn(`Setup isn't finished until you check the kit: gitroll vault recovery-check ${name} --kit ${JSON.stringify(kitFile)}`);
  if (events) console.log(ctx.dim("Tip: a vault is best kept in a private Roll of its own. Everything in it is encrypted, but Git still shows how many items there are and when they change."));
  console.log(`Then: gitroll vault unlock ${name}, and gitroll vault add ${name}`);
}

async function status(name: string | undefined, ctx: VaultContext): Promise<void> {
  const info = deviceInfo();
  const unlocked = (await brokerRunning()) ? (await brokerRequest<{ vaults: { vault: string; expiresAt: string }[] }>("ping")).vaults : [];
  const vaults = localVaults().filter((l) => !name || l.name === name);
  if (name && !vaults.length) throw new NotFoundError(`This device has no vault called ${name}.`);
  const rows = vaults.map((l) => {
    const open = unlocked.find((u) => u.vault === l.id);
    return { name: l.name, id: l.id, roll: l.roll, unlocked: !!open, expiresAt: open?.expiresAt ?? null, recoveryChecked: l.recoveryChecked };
  });
  if (ctx.json) return print({ device: info ? { id: info.id, protection: info.protection } : null, vaults: rows });
  if (!info) console.log("This computer has no vault device key yet. Create a vault: gitroll vault init personal");
  else console.log(`This device: ${info.id} (key protected by ${info.protection === "keychain" ? "the system credential store" : "an unlock passphrase"})`);
  for (const r of rows) {
    console.log(`${r.name}  ${r.unlocked ? `unlocked until ${new Date(r.expiresAt!).toLocaleTimeString()}` : "locked"}  ${ctx.dim(r.roll)}`);
    if (!r.recoveryChecked) ctx.warn(`  Recovery kit not checked yet: gitroll vault recovery-check ${r.name} --kit <file>`);
  }
}

async function check(name: string, ctx: VaultContext): Promise<void> {
  const entry = entryFor(name, ctx);
  const files = vaultFiles(entry);
  const { state } = await verifiedState(files, entry);
  const problems: string[] = [];
  const present = new Set<string>();
  for (const rel of files.files()) {
    const m = OBJECT_FILE.exec(rel);
    if (m) present.add(m[1]);
    else if (rel !== STATE_FILE) problems.push(`${rel} doesn't belong in a vault.`);
  }
  const referenced = referencedObjects(state.snapshot);
  for (const hash of referenced) {
    const bytes = files.readObject(hash);
    if (!bytes) problems.push(`Object ${hash.slice(0, 12)} is missing.`);
    else if ((await crypto.sha256(bytes)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "") !== hash) problems.push(`Object ${hash.slice(0, 12)} was changed.`);
  }
  const extra = [...present].filter((h) => !referenced.includes(h));
  if (extra.length) problems.push(`${extra.length} unreferenced ${extra.length === 1 ? "object" : "objects"} (left by an interrupted write; the next change removes them).`);
  const result = { vault: entry.name, ok: problems.length === 0, snapshot: state.snapshot.seq, trust: state.chain.head.seq, epoch: state.chain.head.epoch, items: state.snapshot.items.length, members: state.chain.head.members.length, problems };
  if (problems.length) process.exitCode = 1;
  if (ctx.json) return print(result);
  if (!problems.length) ctx.ok(`The vault ${entry.name} is intact: ${plural(result.items, "item")}, ${plural(result.members, "member")}, signed, and not older than what this device last saw.`);
  for (const p of problems) ctx.warn(p);
}

/** Enroll this computer with the recovery kit, from the Roll here or a backup file. */
async function recover(name: string, v: Values, ctx: VaultContext): Promise<void> {
  const kit = await readKit(v);
  if (kit.name !== name) ctx.warn(`The kit was made for a vault called ${kit.name}; recovering it as ${name}.`);
  const roll = ctx.openRoll();
  const files = new VaultFiles(roll, name);
  let state;
  let source: "roll" | "backup" = "roll";
  const from = one(v, "from");
  if (from) {
    const backup = await openBackup(new Uint8Array(fs.readFileSync(path.resolve(from))), kit.age, kit.vault);
    if (files.exists()) {
      const here = await openState(files.readState(), crypto, { expectVault: kit.vault });
      if (here.snapshot.seq >= backup.state.snapshot.seq) {
        state = here;
        ctx.warn("This Roll already holds the vault, as new as the backup or newer; using it.");
      }
    }
    if (!state) {
      source = "backup";
      state = backup.state;
      // Restore exactly the authenticated files, then re-read them from disk.
      const restore = { state: JSON.parse(new TextDecoder().decode(backup.files.get(STATE_FILE)!)), objects: new Map([...backup.files].filter(([k]) => k !== STATE_FILE).map(([k, b]) => [OBJECT_FILE.exec(k)![1], b])), unreferenced: [], vaultKey: kit.age };
      files.apply(restore, files.exists() ? files.readState() : null, `vault: restore ${name} from a backup`);
      state = await openState(files.readState(), crypto, { expectVault: kit.vault });
    }
  } else {
    if (!files.exists()) throw new NotFoundError(`This Roll has no vault called ${name}. Sync or clone the Roll first, or restore a backup with --from <file>.`);
    state = await openState(files.readState(), crypto, { expectVault: kit.vault });
  }
  const vaultKey = await checkKit(kit, state, files.readObject(state.snapshot.keys));
  const { device } = await openOrCreateDevice(v, ctx);
  const existing = state.chain.head.members.find((m) => m.id === device.member.id);
  let commit: string | null = null;
  if (!existing) {
    const items = [];
    for (const ref of state.snapshot.items) items.push(await openItem(state, ref, files.readObject(ref.object), vaultKey, crypto));
    const write = await changeMembers(state, vaultKey, items, { add: [device.member] }, { id: kit.member, seed: kit.seed }, crypto);
    commit = files.apply(write, files.readState(), `vault: recover ${name} on a new device`);
    state = await openState(files.readState(), crypto, { expectVault: kit.vault });
  }
  putLocalVault({ id: state.vaultId, name, roll: roll.root, member: device.member.id, pin: state.pin, recoveryChecked: true, added: new Date().toISOString() });
  const others = state.chain.head.members.filter((m) => m.role === "device" && m.id !== device.member.id).map((m) => m.id);
  if (ctx.json) return print({ vault: name, id: state.vaultId, device: device.member.id, source, items: state.snapshot.items.length, otherDevices: others, commit });
  ctx.ok(`Recovered ${name} on this computer (${plural(state.snapshot.items.length, "item")}). Unlock it with: gitroll vault unlock ${name}`);
  if (others.length) console.log(`If a device was lost or stolen, remove it, which also re-encrypts everything:\n${others.map((id) => `  gitroll vault device-remove ${name} ${id}`).join("\n")}`);
}

/** A new device joins after a member added it: pin the checkpoint the member printed. */
async function join(name: string, text: string, ctx: VaultContext): Promise<void> {
  const point = decodeCheckpoint(text);
  const info = deviceInfo();
  if (!info) throw new UserError("This computer has no device key. Start with: gitroll vault device-request");
  const roll = ctx.openRoll();
  const files = new VaultFiles(roll, name);
  if (!files.exists()) throw new NotFoundError(`This Roll has no vault called ${name} yet. Sync the Roll (gitroll sync) after the other device added you, then try again.`);
  const state = await openState(files.readState(), crypto, { expectVault: point.vault, pin: point.pin });
  const me = state.chain.head.members.find((m) => m.id === info.id);
  if (!me || me.age !== info.age || me.sign !== info.sign) throw new VaultError("VAULT_FORBIDDEN", "This device isn't a member of that vault yet. Did the other device add it, and has the Roll synced since?");
  // The kit belongs to the vault, not the device: it was made, and checked, where the vault was created.
  putLocalVault({ id: state.vaultId, name, roll: roll.root, member: info.id, pin: state.pin, recoveryChecked: true, added: new Date().toISOString() });
  if (ctx.json) return print({ vault: name, id: state.vaultId, device: info.id, items: state.snapshot.items.length });
  ctx.ok(`Joined ${name}. Unlock it with: gitroll vault unlock ${name}`);
}

/** `vault run`: values go to the child's environment only; no shell parses the command. */
async function run(name: string, v: Values, ctx: VaultContext): Promise<void> {
  const entry = entryFor(name, ctx);
  const command = ctx.childArgv ?? [];
  if (!command.length) invalid("Usage: gitroll vault run <name> --env VAR=<item>[:<field>] -- <command> [args]");
  const env = many(v, "env");
  if (!env.length) invalid("Say which secrets the command gets: --env VAR=<item>[:<field>] (repeatable).");
  const refs = env.map((spec) => {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/.exec(spec);
    if (!m) invalid(`--env takes VAR=<item>[:<field>], e.g. --env GITHUB_TOKEN=github:token (got ${spec.split("=")[0]}=…)`);
    const colon = m![2].lastIndexOf(":");
    const field = colon > 0 ? m![2].slice(colon + 1) : "";
    return /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(field) ? { variable: m![1], item: m![2].slice(0, colon), field } : { variable: m![1], item: m![2], field: undefined };
  });
  const r = await brokerRequest<{ values: string[] }>("resolve", { vault: entry.id, refs: refs.map(({ item, field }) => ({ item, field })) });
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  refs.forEach((ref, i) => (childEnv[ref.variable] = r.values[i]));
  r.values.fill("");
  const child = spawn(command[0], command.slice(1), { stdio: "inherit", env: childEnv, shell: false, windowsHide: false });
  for (const ref of refs) childEnv[ref.variable] = undefined;
  const forward = (sig: NodeJS.Signals) => () => child.kill(sig);
  const signals = (["SIGINT", "SIGTERM", "SIGHUP"] as NodeJS.Signals[]).map((sig) => [sig, forward(sig)] as const);
  for (const [sig, fn] of signals) process.on(sig, fn);
  const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.on("error", (e) => reject(new UserError(`Couldn't run ${command[0]}: ${(e as NodeJS.ErrnoException).code === "ENOENT" ? "no such command" : "it failed to start"}.`)));
    child.on("exit", (c, s) => resolve({ code: c, signal: s }));
  });
  for (const [sig, fn] of signals) process.removeListener(sig, fn);
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
}
