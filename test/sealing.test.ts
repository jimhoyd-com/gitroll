import "./helpers.ts";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import readline from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { GitRoll } from "../src/node/repo.ts";
import { mcpTools } from "../src/node/mcp.ts";
import { serve } from "../src/node/server.ts";
import { SearchIndex } from "../src/core/search.ts";
import { findSensitive } from "../src/core/privacy.ts";
import { addRecipientToConfig, parseLineRange, recipientsFromConfig, removeRecipientFromConfig, sealedBlocks, withoutSealed } from "../src/core/sealed.ts";
import { addRecipient, newKey, sealDocument, sealFile, unsealDocument } from "../src/node/sealing.ts";
import { git, tmp } from "./helpers.ts";

const cli = fileURLToPath(new URL("../src/node/cli.ts", import.meta.url));
function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", cli, ...args], { encoding: "utf8", cwd: tmp(), env: { ...process.env, ...env }, timeout: 20_000 });
  assert.ifError(result.error);
  return result;
}
function json(args: string[], env: NodeJS.ProcessEnv = {}) {
  const result = run([...args, "--json"], env);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout);
}

/** A key file of its own, outside any repository, and the env that points GitRoll at it. */
async function key(name = "test") {
  const file = path.join(tmp(), "keys.txt");
  const saved = process.env.GITROLL_IDENTITY;
  process.env.GITROLL_IDENTITY = file;
  try {
    const made = await newKey(name);
    return { ...made, env: { GITROLL_IDENTITY: file } };
  } finally {
    if (saved === undefined) delete process.env.GITROLL_IDENTITY;
    else process.env.GITROLL_IDENTITY = saved;
  }
}
/** Runs `fn` with this process using the key file (or none). */
async function withKey<T>(file: string | null, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.GITROLL_IDENTITY;
  process.env.GITROLL_IDENTITY = file ?? path.join(tmp(), "no-key-here.txt");
  if (file === null) fs.writeFileSync(process.env.GITROLL_IDENTITY, "# no keys\n");
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.GITROLL_IDENTITY;
    else process.env.GITROLL_IDENTITY = saved;
  }
}
const NO_KEY = () => {
  const file = path.join(tmp(), "empty-keys.txt");
  fs.writeFileSync(file, "");
  return { GITROLL_IDENTITY: file };
};

const BANK = "---\npin: 1234 # the card\nbank: First\n---\n\n# Bank\n\nAccount 4417\nThe password: swordfish99\n\n- [ ] Call them\n";

async function sealedRoll() {
  const k = await key("laptop");
  const roll = GitRoll.init(tmp(), { name: "Sealed" });
  addRecipient(roll, k.recipient, "laptop");
  fs.mkdirSync(path.join(roll.root, ".gitroll/notes"), { recursive: true });
  fs.writeFileSync(path.join(roll.root, ".gitroll/notes/bank.md"), BANK);
  return { roll, k };
}
const read = (roll: GitRoll, rel = ".gitroll/notes/bank.md") => fs.readFileSync(path.join(roll.root, rel), "utf8");

test("gitroll key new: an age identity in the settings folder, 0600, never inside a repository", async () => {
  const home = tmp();
  const made = json(["key", "new", "--name", "laptop"], { GITROLL_HOME: home, GITROLL_IDENTITY: "" });
  assert.match(made.recipient, /^age1[0-9a-z]{58}$/);
  assert.equal(made.path, path.join(home, "keys.txt"));
  const text = fs.readFileSync(made.path, "utf8");
  assert.match(text, /^# created: .+\n# name: laptop\n# public key: age1\S+\nAGE-SECRET-KEY-1[0-9A-Z]{58}\n$/);
  if (process.platform !== "win32") assert.equal(fs.statSync(made.path).mode & 0o777, 0o600);
  // A second key is added beside the first, and both are listed.
  json(["key", "new"], { GITROLL_HOME: home, GITROLL_IDENTITY: "" });
  assert.equal(json(["key"], { GITROLL_HOME: home, GITROLL_IDENTITY: "" }).keys.length, 2);

  // Pointing the key file into a repository is refused, and nothing is written there.
  const repo = GitRoll.init(tmp(), { name: "Keys" });
  const inside = run(["key", "new", "--json"], { GITROLL_IDENTITY: path.join(repo.root, "keys.txt") });
  assert.equal(inside.status, 1);
  assert.match(inside.stderr, /inside a Git repository/);
  assert.equal(fs.existsSync(path.join(repo.root, "keys.txt")), false);
});

test("recipients live in config.yaml, labelled with a comment; add, list and remove", async () => {
  const k = await key();
  const roll = GitRoll.init(tmp(), { name: "Recipients" });
  const added = json(["recipients", "add", k.recipient, "--name", "phone", "-C", roll.root]);
  assert.equal(added.added, true);
  const config = read(roll, ".gitroll/config.yaml");
  assert.match(config, new RegExp(`recipients:\\n  - ${k.recipient} # phone\\n`));
  assert.match(config, /^# Which GitRoll template/, "the rest of the file is kept as written");
  assert.deepEqual(json(["recipients", "-C", roll.root]).recipients, [{ recipient: k.recipient, label: "phone" }]);
  assert.equal(json(["recipients", "add", k.recipient, "-C", roll.root]).added, false, "listed once");
  const bad = run(["recipients", "add", "age1nope", "-C", roll.root, "--json"]);
  assert.equal(bad.status, 1);
  assert.deepEqual(json(["recipients", "remove", "phone", "-C", roll.root]).recipients, []);
  assert.doesNotMatch(read(roll, ".gitroll/config.yaml"), /recipients/);
  assert.match(git(roll.root, "log", "-1", "--format=%s"), /^recipients: remove/);

  const text = addRecipientToConfig("template_version: 1\nrecipients: []\n", k.recipient, "a#b\nc");
  assert.deepEqual(recipientsFromConfig(text), [{ recipient: k.recipient, label: "a b c" }]);
  assert.deepEqual(removeRecipientFromConfig(text, k.recipient).removed, [k.recipient]);
});

test("seal --lines and --field: ciphertext in place, placeholder without a key, plaintext only with one", async () => {
  const { roll, k } = await sealedRoll();
  roll.commitFiles([".gitroll/notes/bank.md"], "bank");
  const sealed = json(["seal", "notes/bank", "--lines", "9-9", "-C", roll.root], k.env);
  assert.equal(sealed.sealed.length, 1);
  assert.match(sealed.sealed[0].lines, /^9-\d+$/);
  assert.equal(read(roll).split("\n")[8], "```sealed");
  json(["seal", "notes/bank", "--field", "pin", "-C", roll.root], k.env);
  const source = read(roll);
  assert.doesNotMatch(source, /swordfish|1234/);
  assert.match(source, /^pin: \| # the card\n  -----BEGIN AGE ENCRYPTED FILE-----\n/m, "a sealed field is a YAML block scalar, and keeps its comment");
  assert.match(source, /```sealed\n-----BEGIN AGE ENCRYPTED FILE-----\n[\s\S]+\n-----END AGE ENCRYPTED FILE-----\n```/);
  assert.match(source, /bank: First/);
  assert.match(source, /Account 4417/, "the rest of the note stays readable");

  // Without a key: placeholders, never an error.
  const shown = json(["show", "notes/bank", "-C", roll.root], NO_KEY());
  assert.deepEqual(shown.meta.pin, { sealed: true });
  assert.deepEqual(shown.sealed.map((p: { kind: string }) => p.kind), ["field", "block"]);
  const plain = run(["show", "notes/bank", "--unsealed", "-C", roll.root, "--plain"], NO_KEY());
  assert.equal(plain.status, 0);
  assert.match(plain.stdout, /\[sealed\]/);
  assert.doesNotMatch(plain.stdout, /swordfish|BEGIN AGE/);

  // With the key: opened for display only.
  const before = read(roll);
  const opened = json(["show", "notes/bank", "--unsealed", "-C", roll.root], k.env);
  assert.equal(opened.meta.pin.text, "1234");
  assert.equal(opened.sealed[1].text, "The password: swordfish99");
  assert.match(run(["show", "notes/bank", "--unsealed", "-C", roll.root, "--plain"], k.env).stdout, /The password: swordfish99/);
  assert.equal(read(roll), before, "showing never writes plaintext back");

  // Unseal is explicit, confirmed, and restores the file exactly (the field keeps its type).
  const refused = run(["unseal", "notes/bank", "-C", roll.root, "--json"], k.env);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /INTERACTION_REQUIRED/);
  json(["unseal", "notes/bank", "--yes", "-C", roll.root], k.env);
  assert.equal(read(roll), BANK);
});

test("the sealed armor opens with the reference age CLI", { skip: spawnSync("age", ["--version"]).status === 0 ? false : "age isn't installed here" }, async () => {
  const { roll, k } = await sealedRoll();
  await withKey(k.path, () => sealDocument(roll, roll.entry("notes/bank"), { lines: "8-9" }));
  const armored = sealedBlocks(read(roll))[0].armor;
  const out = spawnSync("age", ["-d", "-i", k.path], { input: armored, encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout, "Account 4417\nThe password: swordfish99\n");
});

test("a sealed block survives edits elsewhere in the note", async () => {
  const { roll, k } = await sealedRoll();
  await withKey(k.path, async () => {
    await sealDocument(roll, roll.entry("notes/bank"), { lines: "9" });
    roll.setFields(".gitroll/notes/bank.md", [["bank", { value: "Second" }]]);
    roll.addTodo("Close the old account", "notes/bank");
    roll.markTodo(".gitroll/notes/bank.md", roll.todos().find((t) => t.text === "Call them")!.line, true);
    const src = roll.entrySource("notes/bank");
    roll.writeEntrySource("notes/bank", src.replace("Account 4417", "Account 4417 (joint)"));
    assert.equal(sealedBlocks(read(roll)).length, 1);
    await unsealDocument(roll, roll.entry("notes/bank"));
  });
  const after = read(roll);
  assert.match(after, /The password: swordfish99/);
  assert.match(after, /bank: Second/);
  assert.match(after, /- \[x\] Call them/);
  assert.match(after, /- \[ \] Close the old account/);
  assert.match(after, /Account 4417 \(joint\)/);
});

test("search never sees sealed text, and the secret scanner ignores ciphertext", async () => {
  const { roll, k } = await sealedRoll();
  await withKey(k.path, () => sealDocument(roll, roll.entry("notes/bank"), { lines: "9" }));
  await withKey(k.path, () => sealDocument(roll, roll.entry("notes/bank"), { field: "pin" }));
  const index = new SearchIndex(roll.documents());
  assert.equal(index.search("swordfish").length, 0);
  assert.equal(index.search("AGE").length, 0, "nor the ciphertext");
  assert.equal(index.search("1234").length, 0);
  assert.equal(index.search("4417").length, 1);
  assert.deepEqual(json(["find", "swordfish", "-C", roll.root], k.env), []);
  assert.equal(roll.sensitive().length, 0);
  assert.equal(withoutSealed("a\n```sealed\nx\n```\nb"), "a\n\nb");
  assert.deepEqual(findSensitive(`key ${["AGE-SECRET-KEY-1", "UPA328AP5P0SQM2E247F6YCRZ99ZD98RREVSWYQNCXN0G9Y3DFLQG4T72Z"].join("")}`), ["age secret key"]);
});

test("wrong keys and tampered ciphertext fail cleanly, and leave the file alone", async () => {
  const { roll, k } = await sealedRoll();
  await withKey(k.path, () => sealDocument(roll, roll.entry("notes/bank"), { lines: "9" }));
  const stranger = await key("stranger");
  const sealed = read(roll);
  const wrong = run(["unseal", "notes/bank", "--yes", "-C", roll.root, "--json"], stranger.env);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /None of your keys can open this/);
  assert.equal(read(roll), sealed);
  // One character of the ciphertext changed.
  const lines = sealed.split("\n");
  const i = lines.findIndex((l) => l.startsWith("-----BEGIN")) + 2;
  lines[i] = (lines[i][0] === "A" ? "B" : "A") + lines[i].slice(1);
  fs.writeFileSync(path.join(roll.root, ".gitroll/notes/bank.md"), lines.join("\n"));
  const tampered = run(["unseal", "notes/bank", "--yes", "-C", roll.root, "--json"], k.env);
  assert.equal(tampered.status, 1);
  assert.match(tampered.stderr, /Nothing was unsealed/);
  assert.equal(run(["show", "notes/bank", "--unsealed", "-C", roll.root, "--json"], k.env).status, 0, "show still works: the part stays a placeholder");
});

test("several recipients: each one's key opens it", async () => {
  const { roll, k } = await sealedRoll();
  const phone = await key("phone");
  addRecipient(roll, phone.recipient, "phone");
  await withKey(k.path, () => sealDocument(roll, roll.entry("notes/bank"), { lines: "9" }));
  for (const env of [k.env, phone.env]) assert.equal(json(["show", "notes/bank", "--unsealed", "-C", roll.root], env).sealed[0].text, "The password: swordfish99");
});

test("sealing text that was committed in plain names the commits that still have it", async () => {
  const { roll, k } = await sealedRoll();
  const first = roll.commitFiles([".gitroll/notes/bank.md"], "bank")!;
  const result = await withKey(k.path, () => sealDocument(roll, roll.entry("notes/bank"), { lines: "9" }));
  assert.deepEqual(result.history, [first]);
  assert.match(result.notices.join("\n"), new RegExp(`committed in plain before it was sealed.*${first.slice(0, 12)}.*SECURITY\\.md`));
  // Text that never reached a commit has no such warning.
  fs.writeFileSync(path.join(roll.root, ".gitroll/notes/fresh.md"), "# Fresh\n\nNever committed\n");
  const fresh = await withKey(k.path, () => sealDocument(roll, roll.entry("notes/fresh")));
  assert.deepEqual(fresh.history, []);
  assert.doesNotMatch(fresh.notices.join("\n"), /committed in plain/);
});

test("a sealed file: x.pdf becomes x.pdf.age, links follow, and the app opens it only with a key", async () => {
  const { roll, k } = await sealedRoll();
  const src = path.join(tmp(), "passport.pdf");
  fs.writeFileSync(src, "%PDF-1.4 passport scan");
  const logged = roll.save({ text: "Renewed passport" }, [{ name: "passport.pdf", type: "application/pdf", data: fs.readFileSync(src) }]);
  const result = await withKey(k.path, () => sealFile(roll, ".gitroll/files/passport.pdf"));
  assert.equal(result.path, ".gitroll/files/passport.pdf.age");
  assert.equal(fs.existsSync(path.join(roll.root, ".gitroll/files/passport.pdf")), false);
  assert.match(read(roll, logged.entry.path), /\(\.\.\/files\/passport\.pdf\.age\)/);
  assert.equal(result.history.length, 1, "the plain file is still in history");
  assert.match(result.notices.join("\n"), /still has it/);
  assert.deepEqual(git(roll.root, "status", "--porcelain", "--", ".gitroll/files", ".gitroll/events").trim(), "", "sealed, relinked and committed together");

  const web = tmp();
  fs.writeFileSync(path.join(web, "index.html"), "<!doctype html><title>GitRoll</title>");
  const running = await serve(roll, { port: 0, webDir: web });
  try {
    const base = new URL(running.url).origin;
    const signIn = await fetch(running.url, { redirect: "manual" });
    const cookie = (signIn.headers.get("set-cookie") ?? "").split(";")[0];
    const get = () => fetch(`${base}/attachments/.gitroll/files/passport.pdf.age`, { headers: { Cookie: cookie } });
    await withKey(null, async () => {
      const res = await get();
      assert.equal(res.status, 403);
      assert.match(((await res.json()) as { error: string }).error, /sealed/);
    });
    await withKey(k.path, async () => {
      const res = await get();
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "application/pdf");
      assert.equal(await res.text(), "%PDF-1.4 passport scan");
    });
  } finally {
    (running.server as http.Server).close();
  }

  // And back, explicitly.
  json(["unseal", "files/passport.pdf.age", "--yes", "-C", roll.root], k.env);
  assert.equal(fs.readFileSync(path.join(roll.root, ".gitroll/files/passport.pdf"), "utf8"), "%PDF-1.4 passport scan");
  assert.match(read(roll, logged.entry.path), /\(\.\.\/files\/passport\.pdf\)/);
});

test("keys are never written inside the Roll", async () => {
  const { roll, k } = await sealedRoll();
  await withKey(k.path, () => sealDocument(roll, roll.entry("notes/bank")));
  const secret = fs.readFileSync(k.path, "utf8").match(/AGE-SECRET-KEY-1\S+/)![0];
  const files = fs.readdirSync(roll.root, { recursive: true }).map(String).filter((f) => !f.startsWith(".git/") && fs.statSync(path.join(roll.root, f)).isFile());
  for (const f of files) assert.doesNotMatch(fs.readFileSync(path.join(roll.root, f), "utf8"), /AGE-SECRET-KEY-1[0-9A-Z]{58}/, f);
  assert.doesNotMatch(git(roll.root, "log", "-p", "--all"), new RegExp(secret));
});

test("the secret scanner offers to seal: a notice, and a seal suggestion in --json", async () => {
  const roll = GitRoll.init(tmp(), { name: "Scanner" });
  const logged = json(["log", "Door code\n\nThe password: letmein123", "-C", roll.root]);
  assert.match(logged.notices.join("\n"), /gitroll seal/);
  assert.equal(logged.seal.command, `gitroll seal ${logged.entry.path} --lines ${logged.seal.lines}`);
  const line = Number(logged.seal.lines.split("-")[0]);
  assert.match(read(roll, logged.entry.path).split("\n")[line - 1], /letmein123/);
  const clean = json(["log", "Nothing secret", "-C", roll.root]);
  assert.equal(clean.seal, undefined);
});

test("MCP: no key tool, and sealed content comes back as {sealed: true} unless the server has a key", async () => {
  assert.equal(mcpTools().some((t) => t.name === "gitroll_key"), false, "key new is never offered to an agent");
  assert.ok(mcpTools().find((t) => t.name === "gitroll_unseal")!.confirm, "unsealing needs yes: true");
  const { roll, k } = await sealedRoll();
  await withKey(k.path, () => sealDocument(roll, roll.entry("notes/bank"), { field: "pin" }));
  const call = async (env: NodeJS.ProcessEnv, args: Record<string, unknown>) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", cli, "mcp", "-C", roll.root], { cwd: tmp(), env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    const lines = readline.createInterface({ input: child.stdout });
    const replies: { id?: number }[] = [];
    const waiting = new Promise<void>((resolve) => lines.on("line", (l) => { replies.push(JSON.parse(l)); if (replies.length === 2) resolve(); }));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "gitroll_show", arguments: { file: "notes/bank", ...args } } })}\n`);
    await waiting;
    child.stdin.end();
    const reply = replies.find((r) => r.id === 2) as { result: { content: { text: string }[] } };
    return JSON.parse(reply.result.content[0].text);
  };
  assert.deepEqual((await call(NO_KEY(), { unsealed: true })).meta.pin, { sealed: true });
  assert.deepEqual((await call(k.env, {})).meta.pin, { sealed: true }, "only opened when asked");
  assert.deepEqual((await call(k.env, { unsealed: true })).meta.pin, { sealed: true, text: "1234" });
});

test("line ranges parse with or without spaces, and stay fast on long input", () => {
  assert.deepEqual(parseLineRange("8"), { start: 8, end: 8 });
  assert.deepEqual(parseLineRange(" 8 - 9 "), { start: 8, end: 9 });
  assert.equal(parseLineRange("9-8"), null);
  assert.equal(parseLineRange("0"), null);
  assert.equal(parseLineRange("8-"), null);
  assert.equal(parseLineRange("a-b"), null);
  const started = Date.now();
  assert.equal(parseLineRange(`0${" ".repeat(100_000)}x`), null);
  assert.ok(Date.now() - started < 500);
});
