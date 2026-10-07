import "./helpers.ts";
import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { GitRoll } from "../src/node/repo.ts";
import { mcpTools } from "../src/node/mcp.ts";
import { generateEd25519, parsePrivateKeyFile, parsePublicKeyLine, privateKeyFile, publicKeyLine } from "../src/node/sshkey.ts";
import { parseAllowedSigners, signatureOf } from "../src/node/signing.ts";
import { git, tmp } from "./helpers.ts";

const cli = fileURLToPath(new URL("../src/node/cli.ts", import.meta.url));
const nodeArgs = ["--disable-warning=ExperimentalWarning", cli];
function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, [...nodeArgs, ...args], { encoding: "utf8", cwd: tmp(), env: { ...process.env, GITROLL_AGENT: "", ...env }, timeout: 20_000 });
  assert.ifError(result.error);
  return result;
}
function json(args: string[], env: NodeJS.ProcessEnv = {}) {
  const result = run([...args, "--json"], env);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout);
}
const roll = () => GitRoll.init(tmp(), { name: "Signing Tests" });
const hasSshKeygen = !spawnSync("ssh-keygen", ["-?"], { stdio: "ignore" }).error;
const needsSshKeygen = { skip: hasSshKeygen ? false : "ssh-keygen isn't installed, so Git can't make or check SSH signatures here" };
let unique = 0;
const agentName = (base: string) => `${base} ${process.pid}-${++unique}`;

/** A key written by hand, to sign with outside GitRoll. */
function looseKey(comment = "loose"): { file: string; publicKey: string } {
  const key = generateEd25519(comment);
  const file = path.join(tmp(), "id_ed25519");
  fs.writeFileSync(file, privateKeyFile(key), { mode: 0o600 });
  return { file, publicKey: publicKeyLine({ publicKey: key.publicKey, comment: "" }) };
}

/** Commits a new event by hand, signed with `keyFile`, with an optional agent trailer. */
function signedCommit(root: string, keyFile: string, title: string, agent?: string): void {
  const rel = `.gitroll/events/2026-01-01-${title.toLowerCase().replace(/\W+/g, "-")}.md`;
  fs.writeFileSync(path.join(root, rel), `# ${title}\n`);
  git(root, "add", rel);
  git(root, "-c", "gpg.format=ssh", "-c", `user.signingkey=${keyFile}`, "commit", "-q", "-S", "-m", `log: ${title}`, ...(agent ? ["-m", `Gitroll-Agent: ${agent}`] : []));
}

test("an Ed25519 key round-trips through OpenSSH's private key format", () => {
  const key = generateEd25519("agent:Round Trip");
  const text = privateKeyFile(key, 0x01020304);
  assert.match(text, /^-----BEGIN OPENSSH PRIVATE KEY-----\n/);
  assert.match(text, /\n-----END OPENSSH PRIVATE KEY-----\n$/);
  assert.ok(text.split("\n").every((line) => line.length <= 70));
  const body = Buffer.from(text.split("\n").slice(1, -2).join(""), "base64");
  assert.equal(body.subarray(0, 15).toString("latin1"), "openssh-key-v1\0");

  const back = parsePrivateKeyFile(text);
  assert.ok(back.publicKey.equals(key.publicKey));
  assert.ok(back.seed.equals(key.seed));
  assert.equal(back.comment, "agent:Round Trip");

  // The seed read back signs, and the public key read back verifies it.
  const priv = createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", d: back.seed.toString("base64url"), x: back.publicKey.toString("base64url") }, format: "jwk" });
  const signature = sign(null, Buffer.from("hello"), priv);
  const line = publicKeyLine(key);
  assert.match(line, /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]+=* agent:Round Trip$/);
  const pub = parsePublicKeyLine(line);
  assert.equal(pub.comment, "agent:Round Trip");
  const pubKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: pub.publicKey.toString("base64url") }, format: "jwk" });
  assert.ok(verify(null, Buffer.from("hello"), pubKey, signature));

  // A different key's private half, or a broken structure, is refused.
  const other = generateEd25519();
  assert.throws(() => parsePrivateKeyFile(privateKeyFile({ ...key, seed: other.seed })), /match/);
  assert.throws(() => parsePrivateKeyFile(text.replace("OPENSSH", "RSA")), /OpenSSH/);
  for (const comment of ["", "a", "ab", "abc", "abcd", "abcdefg"]) assert.equal(parsePrivateKeyFile(privateKeyFile({ ...key, comment })).comment, comment, "padding is right at every length");

  if (hasSshKeygen) {
    const file = path.join(tmp(), "id");
    fs.writeFileSync(file, text, { mode: 0o600 });
    const derived = spawnSync("ssh-keygen", ["-y", "-f", file], { encoding: "utf8" });
    assert.equal(derived.status, 0, derived.stderr);
    assert.equal(derived.stdout.trim(), line, "ssh-keygen reads the file and derives the same public key");
  }
});

test("allowed_signers lines parse, with quoted principals and options", () => {
  const lines = parseAllowedSigners(`# comment\n\nyou@example.com ssh-ed25519 AAAAone\n"agent:Claude Code" ssh-ed25519 AAAAtwo\na@x,b@y namespaces="git" ssh-ed25519 AAAAthree comment\n`);
  assert.deepEqual(lines, [
    { principals: ["you@example.com"], key: "ssh-ed25519 AAAAone" },
    { principals: ["agent:Claude Code"], key: "ssh-ed25519 AAAAtwo" },
    { principals: ["a@x", "b@y"], key: "ssh-ed25519 AAAAthree" },
  ]);
  assert.deepEqual(signatureOf("G", "agent:x"), { status: "good", signer: "agent:x" });
  assert.deepEqual(signatureOf("B", ""), { status: "bad", signer: null });
  assert.deepEqual(signatureOf("U", "who"), { status: "unknown", signer: null });
  assert.deepEqual(signatureOf("N", ""), { status: "unsigned", signer: null });
});

test("agent-key keeps the private key in GitRoll's settings folder and commits only the public key", () => {
  const r = roll();
  const name = agentName("Key Keeper");
  const made = json(["agent-key", name, "-C", r.root]);
  assert.equal(made.principal, `agent:${name}`);
  assert.equal(made.created, true);
  assert.equal(made.added, true);
  assert.ok(made.committed);
  assert.ok(path.relative(r.root, made.keyPath).startsWith(".."), "the private key is outside the Roll");
  assert.ok(made.keyPath.startsWith(process.env.GITROLL_HOME!));
  if (process.platform !== "win32") assert.equal(fs.statSync(made.keyPath).mode & 0o777, 0o600);
  parsePrivateKeyFile(fs.readFileSync(made.keyPath, "utf8"));

  const signers = fs.readFileSync(path.join(r.root, ".gitroll/allowed_signers"), "utf8");
  assert.ok(signers.includes(`"agent:${name}" ${made.publicKey}`), signers);
  assert.equal(git(r.root, "status", "--porcelain").trim(), "", "allowed_signers is committed");
  assert.equal(git(r.root, "log", "-1", "--format=%s").trim(), `signers: add agent:${name}`);
  const tracked = git(r.root, "ls-files").trim().split("\n");
  for (const file of tracked) assert.ok(!fs.readFileSync(path.join(r.root, file), "utf8").includes("PRIVATE KEY"), `${file} holds no private key`);
  assert.equal(git(r.root, "log", "--all", "-p").includes("PRIVATE KEY"), false, "no private key anywhere in history");

  const again = json(["agent-key", name, "-C", r.root]);
  assert.equal(again.created, false);
  assert.equal(again.added, false);
  assert.equal(again.committed, null);
  assert.equal(again.publicKey, made.publicKey);

  // Settings inside the repository would put the key in it: refused, nothing written.
  const inside = run(["agent-key", agentName("Inside"), "-C", r.root, "--json"], { GITROLL_HOME: path.join(r.root, "settings") });
  assert.equal(inside.status, 1);
  assert.match(JSON.parse(inside.stderr).error.message, /inside this repository/);
  assert.equal(fs.existsSync(path.join(r.root, "settings")), false);

  assert.equal(run(["agent-key", "a,b", "-C", r.root, "--json"]).status, 1, "a comma would be two principals");
  assert.ok(!mcpTools().some((t) => t.name === "gitroll_agent_key"), "an agent can't mint its own identity over MCP");
});

test("verify: a good agent signature, unsigned changes, --require-signed, history and status", needsSshKeygen, () => {
  const r = roll();
  const name = agentName("Signer");
  json(["agent-key", name, "-C", r.root]);
  const before = json(["status", "-C", r.root]);
  assert.deepEqual(before.signing, { enabled: false, allowedSigners: ".gitroll/allowed_signers" });
  assert.equal(json(["status", "-C", r.root], { GITROLL_AGENT: name }).signing.enabled, true);

  const logged = json(["log", "Signed by the agent", "--agent", name, "-C", r.root]);
  assert.equal(git(r.root, "log", "-1", "--format=%(trailers:key=Gitroll-Agent,valueonly)").trim(), name);
  const raw = git(r.root, "cat-file", "commit", "HEAD");
  assert.match(raw, /-----BEGIN SSH SIGNATURE-----/);

  const report = json(["verify", "-C", r.root]);
  assert.equal(report.ok, true);
  assert.equal(report.scope, "repository");
  assert.equal(report.allowedSigners, ".gitroll/allowed_signers");
  const head = report.commits[0];
  assert.equal(head.status, "good");
  assert.equal(head.signer, `agent:${name}`);
  assert.equal(head.agent, name);
  assert.equal(head.agentCheck, "match");
  assert.match(head.key, /^SHA256:/);
  assert.ok(report.commits.slice(1).every((c: { status: string }) => c.status === "unsigned"), "the person's own commits are unsigned here");
  assert.equal(report.summary.good, 1);

  const strict = run(["verify", "--require-signed", "-C", r.root, "--json"]);
  assert.equal(strict.status, 1, "unsigned changes fail only when signing is required");
  assert.equal(JSON.parse(strict.stdout).ok, false);
  const recent = json(["verify", "--since", "HEAD~1", "--require-signed", "-C", r.root]);
  assert.equal(recent.summary.total, 1);
  assert.equal(recent.ok, true);

  const history = json(["history", logged.entry.path, "-C", r.root]);
  assert.deepEqual(history[0].signature, { status: "good", signer: `agent:${name}` });

  // A trailer by itself is a claim: an unsigned one is reported, not failed.
  json(["log", "Says it's an agent", "--agent", agentName("No Key"), "-C", r.root]);
  const unproven = json(["verify", "--since", "HEAD~1", "-C", r.root]);
  assert.equal(unproven.commits[0].agentCheck, "unproven");
  assert.equal(unproven.ok, true);
  const doctor = run(["doctor", "-C", r.root, "--json"]);
  const messages = JSON.parse(doctor.stdout).checks.map((c: { message: string }) => c.message);
  assert.ok(messages.some((m: string) => m.includes("No Key") && m.includes("agent-key")), messages.join("\n"));
  assert.ok(messages.some((m: string) => m.includes("allowed_signers lists 1 signer")), messages.join("\n"));
  assert.ok(messages.some((m: string) => m.startsWith("Tip: sign changes")), "the existing tip stays");
});

test("verify flags an unknown signer, a bad signature and an agent trailer signed by someone else", needsSshKeygen, () => {
  const r = roll();
  const real = agentName("Real");
  const made = json(["agent-key", real, "-C", r.root]);

  const stranger = looseKey();
  signedCommit(r.root, stranger.file, "Stranger");
  const unknown = json(["verify", "--since", "HEAD~1", "-C", r.root]);
  assert.equal(unknown.commits[0].status, "unknown");
  assert.equal(unknown.commits[0].signer, null);
  assert.equal(unknown.ok, true, "an unlisted key is reported, not failed");
  assert.equal(run(["verify", "--since", "HEAD~1", "--require-signed", "-C", r.root, "--json"]).status, 1);

  // Signed with Real's key, but claiming to be another agent.
  signedCommit(r.root, made.keyPath, "Impostor", "Claimed Agent");
  const mismatch = run(["verify", "--since", "HEAD~1", "-C", r.root, "--json"]);
  assert.equal(mismatch.status, 1);
  const commit = JSON.parse(mismatch.stdout).commits[0];
  assert.equal(commit.status, "good");
  assert.equal(commit.signer, `agent:${real}`);
  assert.equal(commit.agent, "Claimed Agent");
  assert.equal(commit.agentCheck, "mismatch");
  const plain = run(["verify", "--since", "HEAD~1", "-C", r.root]);
  assert.match(plain.stdout, /says agent Claimed Agent, but was signed by agent:/);

  // A signed commit whose message was changed afterwards.
  signedCommit(r.root, made.keyPath, "Honest", real);
  const tampered = git(r.root, "cat-file", "commit", "HEAD").replace("log: Honest", "log: Altered");
  const file = path.join(tmp(), "commit");
  fs.writeFileSync(file, tampered);
  const forged = git(r.root, "hash-object", "-t", "commit", "-w", file).trim();
  git(r.root, "update-ref", "HEAD", forged);
  const bad = run(["verify", "--since", "HEAD~1", "-C", r.root, "--json"]);
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stdout).commits[0].status, "bad");
});

test("verify reads only .gitroll/ commits when the Roll shares a repository with a project", needsSshKeygen, () => {
  const dir = tmp();
  git(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "app.js"), "1\n");
  git(dir, "add", "app.js");
  git(dir, "commit", "-q", "-m", "code");
  const r = GitRoll.init(dir, { name: "Embedded" });
  fs.writeFileSync(path.join(dir, "app.js"), "2\n");
  git(dir, "commit", "-q", "-am", "more code");
  r.addEntry({ text: "A log entry" });
  const report = json(["verify", "-C", r.root]);
  assert.equal(report.scope, "roll");
  assert.deepEqual(report.commits.map((c: { subject: string }) => c.subject).filter((s: string) => s.includes("code")), []);
  assert.equal(report.summary.total, 2);
});

test("a commit an MCP client makes is signed with that agent's key", needsSshKeygen, async () => {
  const r = roll();
  const name = agentName("MCP Signer");
  json(["agent-key", name, "-C", r.root]);
  const child = spawn(process.execPath, [...nodeArgs, "mcp", "-C", r.root], { cwd: tmp(), env: { ...process.env, GITROLL_AGENT: "" }, stdio: ["pipe", "pipe", "pipe"] });
  const lines = readline.createInterface({ input: child.stdout });
  const answers = new Map<number, (m: any) => void>();
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    answers.get(message.id)?.(message);
  });
  let id = 0;
  const request = (method: string, params: unknown) =>
    new Promise<any>((resolve) => {
      answers.set(++id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  try {
    await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name } });
    const logged = await request("tools/call", { name: "gitroll_log", arguments: { text: "Logged over MCP" } });
    assert.equal(logged.result.isError, false, logged.result.content[0].text);
    const verified = await request("tools/call", { name: "gitroll_verify", arguments: { since: "HEAD~1" } });
    const report = JSON.parse(verified.result.content[0].text);
    assert.equal(report.commits[0].agentCheck, "match");
  } finally {
    child.stdin.end();
    await new Promise((resolve) => child.on("close", resolve));
  }
  const out = git(r.root, "-c", `gpg.ssh.allowedSignersFile=${path.join(r.root, ".gitroll/allowed_signers")}`, "log", "-1", "--format=%G?|%GS|%(trailers:key=Gitroll-Agent,valueonly)").trim();
  assert.equal(out, `G|agent:${name}|${name}`);
});
