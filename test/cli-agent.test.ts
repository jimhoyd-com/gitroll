import "./helpers.ts";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { GitRoll } from "../src/node/repo.ts";
import { requestsJson } from "../src/node/cli-contract.ts";
import { fakeGitHubRepo, git, tmp } from "./helpers.ts";

const cli = fileURLToPath(new URL("../src/node/cli.ts", import.meta.url));
const nodeArgs = ["--disable-warning=ExperimentalWarning", cli];
function run(args: string[], input = "", env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, [...nodeArgs, ...args], { encoding: "utf8", input, cwd: tmp(), env: { ...process.env, ...env }, timeout: 10_000 });
  assert.ifError(result.error);
  return result;
}
function json(args: string[], expected = 0) {
  const result = run([...args, "--json"]);
  assert.equal(result.status, expected, result.stdout + result.stderr);
  assert.equal(result.stderr, "", "results and diagnostic reports have clean stdout");
  return JSON.parse(result.stdout);
}
function failure(args: string[], code: string) {
  const result = run([...args, "--json"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.stdout, "", "validation fails before printing or mutating");
  assert.equal(JSON.parse(result.stderr).error.code, code, result.stderr);
}
function roll() { const dir = tmp(); return GitRoll.init(dir, { name: "Agent Tests" }); }

test("discovery lists accepted flags and unsupported flags cannot cause writes", () => {
  const r = roll();
  const schema = json(["schema", "log"]);
  assert.equal(schema.schemaVersion, 1);
  assert.ok(schema.commands[0].options["idempotency-key"]);
  assert.equal(schema.commands[0].options["dry-run"], undefined);
  assert.deepEqual(json(["log", "--help"]), schema);
  assert.equal(json(["schema", "add"]).commands[0].name, "log");
  const head = r.git(["rev-parse", "HEAD"]);
  for (const args of [
    ["log", "Do not write", "--dry-run"],
    ["add", "Do not write", "--dry-run"],
    ["log", "Do not write", "--text", "ignored"],
    ["log", "Do not write", "--made-up"],
    ["recent", "--limit", "nope"],
    ["recent", "--limit", "-1"],
    ["find", "words", "--offset", "1.5"],
    ["find", "words", "--fields", "title,secret"],
    ["resolve", "file", "--mine", "--theirs"],
    ["rename", "Name", "--roll", "also-selected"],
    ["status", "ignored"],
  ]) failure([...args, "-C", r.root], "INVALID_ARGUMENT");
  assert.equal(r.git(["rev-parse", "HEAD"]), head);
  assert.equal(r.entries().length, 0);
  failure(["rolls", "typo"], "INVALID_ARGUMENT");
  failure(["searches", "typo"], "INVALID_ARGUMENT");
  failure(["ai", "off", "--model", "ignored"], "INVALID_ARGUMENT");
  failure(["toString"], "INVALID_ARGUMENT");
  failure(["schema", "constructor"], "INVALID_ARGUMENT");
});

test("JSON implies no prompts or editors; explicit noninteractive rejects workspaces", () => {
  const r = roll();
  for (const args of [["log", "text", "--editor"], ["log", "text", "--template", "incident"], ["edit", "file", "--editor"]]) {
    failure([...args, "-C", r.root], "INTERACTION_REQUIRED");
  }
  for (const command of ["setup", "menu", "open", "upgrade", "uninstall"]) {
    failure([command], "UNSUPPORTED_MODE");
    const result = run([command, "--non-interactive"], "", { GITROLL_FORCE_INTERACTIVE: "1" });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(result.stdout, "");
  }
  const piped = run(["log", "-C", r.root, "--json"], "Logged from stdin", { GITROLL_FORCE_INTERACTIVE: "1" });
  assert.equal(piped.status, 0, piped.stderr);
  const entry = JSON.parse(piped.stdout).entry;
  failure(["delete", entry.path, "-C", r.root], "INTERACTION_REQUIRED");
  assert.equal(r.entries().length, 1);
});

test("JSON covers initialization, rename, registry changes and template writes", () => {
  const dir = path.join(tmp(), "new");
  assert.equal(json(["init", "--dir", dir]).path, fs.realpathSync(dir));
  assert.equal(json(["rename", "Renamed", "-C", dir]).name, "Renamed");
  assert.equal(json(["template", "--set", "1", "-C", dir]).version, 1);
  const registered = json(["rolls", "add", dir]);
  assert.equal(registered.added, false);
  assert.equal(json(["switch", registered.key]).defaultRoll, registered.key);
  json(["find", "anything", "--save", "temporary", "-C", dir]);
  assert.equal(json(["searches", "remove", "temporary"]).removed, "temporary");
  const output = path.join(tmp(), "export.md");
  assert.equal(json(["export", "--format", "markdown", "--output", output, "-C", dir]).output, output);
  failure(["export", "--format", "markdown", "-C", dir], "INVALID_ARGUMENT");
  assert.equal(json(["forget", registered.key]).forgotten, registered.key);
  assert.ok(fs.existsSync(dir));
});

test("JSON covers local backup, joining, conflict resolution and Roll removal", () => {
  const r = roll();
  const entry = r.save({ text: "Deploy\n\nWent out at 14:00." }).entry;
  fs.writeFileSync(path.join(r.root, entry.path), "# Deploy\n\nWent out at 14:00.\n\n---\n\n**Sync note (2026-09-16):** this event was changed on another device too. That version said: #conflict\n\n> # Deploy\n>\n> Went out at 15:00.\n");
  r.git(["commit", "-qam", "sync conflict"]);
  assert.match(json(["resolve", entry.path, "--theirs", "-C", r.root]).body, /15:00/);
  const remote = fakeGitHubRepo();
  assert.equal(json(["backup", remote, "-C", r.root]).ok, true);
  const joined = json(["join", remote, "agent-copy"]);
  assert.ok(fs.existsSync(joined.path));
  assert.equal(json(["remove", "agent-copy", "--delete-files", "--yes"]).deleted, "agent-copy");
  assert.equal(fs.existsSync(joined.path), false);
});

test("explicit selectors override environment defaults and keyed stdin avoids the guided composer", () => {
  const a = roll(); const b = roll();
  const registered = json(["rolls", "add", b.root]);
  const result = run(["log", "Chosen Roll", "--roll", registered.key, "--json"], "", { GITROLL_REPO: a.root });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(a.entries().length, 0);
  assert.equal(b.entries().length, 1);
  const args = ["log", "--idempotency-key", "stdin-key", "-C", a.root];
  assert.equal(run(args, "stdin event", { GITROLL_FORCE_INTERACTIVE: "1" }).status, 0);
  assert.equal(run(args, "stdin event", { GITROLL_FORCE_INTERACTIVE: "1" }).status, 0);
  assert.equal(a.entries().length, 1);
});

test("search pagination and field selection bound output across Rolls", () => {
  const a = roll(); const b = roll();
  for (const [i, r] of [a, b].entries()) {
    for (let j = 0; j < 3; j++) r.save({ text: `Unique paging result ${i}-${j}`, date: `2026-09-${10 + j}` });
    json(["rolls", "add", r.root]);
  }
  const full = json(["find", "Unique paging result", "-C", a.root]);
  const page = json(["find", "Unique paging result", "--offset", "1", "--limit", "1", "--fields", "path,title", "-C", a.root]);
  assert.deepEqual(page, [{ path: full[1].path, title: full[1].title }]);
  assert.deepEqual(json(["recent", "--limit", "0", "-C", a.root]), []);
  assert.deepEqual(json(["find", "Unique paging result", "--offset", "99", "-C", a.root]), []);
  const all = json(["find", "Unique paging result", "--all"]).flatMap((hit: { entries: unknown[] }) => hit.entries);
  const slice = json(["find", "Unique paging result", "--all", "--offset", "2", "--limit", "2"]).flatMap((hit: { entries: unknown[] }) => hit.entries);
  assert.equal(all.length, 6);
  assert.deepEqual(slice, all.slice(2, 4));
});

test("revision checks reject stale edits before copying attachments or committing", () => {
  const r = roll();
  const entry = r.save({ text: "Original" }).entry;
  const shown = json(["show", entry.path, "-C", r.root]);
  assert.match(shown.revision, /^[a-f0-9]{64}$/);
  json(["edit", entry.path, "--expect", shown.revision, "--text", "First update", "-C", r.root]);
  const head = r.git(["rev-parse", "HEAD"]);
  const attachment = path.join(tmp(), "not-copied.txt"); fs.writeFileSync(attachment, "data");
  failure(["edit", entry.path, "--expect", shown.revision, "--text", "Stale update", "--file", attachment, "-C", r.root], "CONFLICT");
  assert.equal(r.git(["rev-parse", "HEAD"]), head);
  assert.match(r.entry(entry.path).body, /First update/);
  assert.equal(r.entry(entry.path).attachments.length, 0);
  failure(["show", "missing-entry", "-C", r.root], "NOT_FOUND");
});

test("keyed log retries survive edits, moves and clones and reject changed requests", () => {
  const r = roll();
  const args = ["log", "Retryable event", "--idempotency-key", "request-123", "--code"];
  const first = json([...args, "-C", r.root]);
  assert.equal(first.replayed, false);
  const head = r.git(["rev-parse", "HEAD"]);
  const retry = json([...args, "-C", r.root]);
  assert.equal(retry.replayed, true);
  assert.equal(retry.entry.path, first.entry.path);
  assert.equal(r.git(["rev-parse", "HEAD"]), head);
  failure(["log", "Different", "--idempotency-key", "request-123", "--code", "-C", r.root], "CONFLICT");
  r.saveChanges(first.entry.path, { text: "Human revision" });
  const moved = r.moveEntry(first.entry.path, ".gitroll/events/2026-09-15-moved.md");
  const replay = json([...args, "-C", r.root]);
  assert.equal(replay.entry.path, moved.path);
  assert.match(replay.entry.body, /Human revision/);
  const cloned = path.join(tmp(), "clone");
  git(r.root, "clone", "-q", r.root, cloned);
  assert.equal(json([...args, "-C", cloned]).replayed, true);
  assert.equal(new GitRoll(cloned).entries().length, 1);
  const lock = path.resolve(r.root, r.git(["rev-parse", "--git-path", "gitroll-cli-log.lock"]).trim());
  fs.writeFileSync(lock, "other writer");
  failure([...args, "-C", r.root], "CONFLICT");
  assert.equal(fs.readFileSync(lock, "utf8"), "other writer");
  fs.unlinkSync(lock);
});

test("concurrent keyed logs create at most one event", async () => {
  const r = roll();
  const invoke = () => new Promise<{ status: number | null; out: string; err: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [...nodeArgs, "log", "Concurrent", "--idempotency-key", "same", "-C", r.root, "--json"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; let err = "";
    child.stdout.on("data", (data) => { out += data; }); child.stderr.on("data", (data) => { err += data; });
    child.on("error", reject); child.on("close", (status) => resolve({ status, out, err }));
  });
  const results = await Promise.all([invoke(), invoke()]);
  assert.ok(results.some((result) => result.status === 0));
  for (const result of results) {
    if (result.status === 0) assert.equal(JSON.parse(result.out).entry.title, "Concurrent");
    else assert.equal(JSON.parse(result.err).error.code, "CONFLICT");
  }
  assert.equal(r.entries().length, 1);
});

test("diagnostic failures preserve JSON and a nonzero status", () => {
  const r = roll();
  fs.writeFileSync(path.join(r.root, ".gitroll/events/broken.md"), "---\ndate: [invalid]\n---\nBroken\n");
  assert.ok(json(["check", "-C", r.root], 1).problems.length);
  assert.ok(json(["doctor", "-C", r.root], 1).checks.some((check: { level: string }) => check.level === "error"));
});

test("JSON error selection respects string values, short flags and the -- terminator", () => {
  assert.equal(requestsJson(["edit", "file", "--text", "--json"]), false);
  assert.equal(requestsJson(["log", "-t", "--json"]), false);
  assert.equal(requestsJson(["log", "--", "--json"]), false);
  assert.equal(requestsJson(["log", "-tfoo", "--json"]), true);
  const bad = run(["recent", "--unknown", "--json"]);
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stderr).error.code, "INVALID_ARGUMENT");
});
