import "./helpers.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { GitRoll } from "../src/node/repo.ts";
import { loadUserConfig, saveUserConfig } from "../src/node/user-config.ts";
import { fakeGitHubRepo, git, tmp } from "./helpers.ts";

/** A private GitHub repository cloned to this computer and set up as a Roll. */
function clonedRoll(remote: string, name = "roll"): GitRoll {
  const dir = path.join(tmp(), name);
  git(path.dirname(dir), "clone", "-q", remote, dir);
  return GitRoll.init(dir, { name: "Shared Roll" });
}

function cloneOf(remote: string, name: string): GitRoll {
  const dir = path.join(tmp(), name);
  git(path.dirname(dir), "clone", "-q", remote, dir);
  return new GitRoll(dir);
}

test("first sync uploads a new Roll to an empty repository", async () => {
  const remote = fakeGitHubRepo();
  const roll = clonedRoll(remote);
  roll.addEntry({ text: "Opened business checking account" });
  assert.equal(roll.status().ahead, 2);

  const result = (await roll.sync());
  assert.equal(result.ok, true, result.message);
  assert.equal(result.code, "ok");
  assert.equal(roll.status().ahead, 0);
  assert.match(git(remote, "log", "--format=%s", "main"), /log: Opened business checking account/);
});

test("sync brings in events logged by others, including hand edits", async () => {
  const remote = fakeGitHubRepo();
  const laptop = clonedRoll(remote, "laptop");
  laptop.addEntry({ text: "Landscaper replaced plants" });
  assert.ok((await laptop.sync()).ok);

  const partner = cloneOf(remote, "partner");
  const file = path.join(partner.root, partner.entries()[0].path);
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("plants", "the front plants"));
  git(partner.root, "commit", "-qam", "Clarify");
  partner.addEntry({ text: "Paid landscaper", amount: { value: 90, currency: "USD" } });
  assert.ok((await partner.sync()).ok);

  laptop.addEntry({ text: "Decided to change onboarding architecture" });
  const result = (await laptop.sync());
  assert.ok(result.ok, result.message);
  const bodies = laptop.entries().map((e) => e.title).sort();
  assert.deepEqual(bodies, ["Decided to change onboarding architecture", "Landscaper replaced the front plants", "Paid landscaper"]);
  assert.equal(laptop.status().ahead, 0);
});

test("the same event edited by two people is combined, and nothing is lost", async () => {
  const remote = fakeGitHubRepo();
  const a = clonedRoll(remote, "a");
  const e = a.addEntry({ text: "Paid contractor $1,850", tags: ["contractor"] });
  assert.ok((await a.sync()).ok);

  const b = cloneOf(remote, "b");
  b.updateEntry(e.id, { text: "Paid contractor $1,500" });
  assert.ok((await b.sync()).ok);

  a.updateEntry(e.id, { text: "Paid contractor $1,850 by check" });
  const result = (await a.sync());

  assert.equal(result.ok, true, result.message);
  assert.deepEqual(result.merged, [e.path]);
  assert.match(result.message, /#conflict/);
  const merged = a.entry(e.id);
  assert.ok(merged.body.startsWith("Paid contractor $1,850 by check"));
  assert.match(merged.body, /\$1,500/);
  assert.ok(merged.tags.includes("conflict"));
  assert.equal(git(a.root, "status", "--porcelain"), "");

  assert.ok((await b.sync()).ok, "the other person receives the combined version");
  assert.match(b.entry(e.id).body, /by check/);
});

test("an event edited here but deleted elsewhere is kept", async () => {
  const remote = fakeGitHubRepo();
  const a = clonedRoll(remote, "a");
  const e = a.addEntry({ text: "Water heater installed" });
  assert.ok((await a.sync()).ok);

  const b = cloneOf(remote, "b");
  b.deleteEntry(e.id);
  assert.ok((await b.sync()).ok);

  a.updateEntry(e.id, { text: "Water heater installed, 10-year warranty" });
  const result = (await a.sync());
  assert.ok(result.ok, result.message);
  assert.equal(a.entry(e.id).body, "Water heater installed, 10-year warranty");
});

test("sync without a backup explains what to do and keeps events", async () => {
  const roll = GitRoll.init(tmp());
  roll.addEntry({ text: "Local only" });
  const result = (await roll.sync());
  assert.equal(result.code, "no-remote");
  assert.match(result.message, /gitroll backup/);
  assert.equal(roll.entries().length, 1);
});

test("an unreachable backup fails cleanly with local changes intact", async () => {
  const roll = GitRoll.init(tmp());
  git(roll.root, "remote", "add", "origin", path.join(tmp(), "does-not-exist.git"));
  roll.addEntry({ text: "Written while offline" });
  const head = git(roll.root, "rev-parse", "HEAD");

  const result = (await roll.sync());
  assert.equal(result.ok, false);
  assert.equal(result.code, "auth");
  // A folder that isn't there is said in those terms: no account, no Git.
  assert.match(result.message, /isn't there, or isn't a backup any more/);
  assert.match(result.message, /saved on this computer/);
  assert.equal(git(roll.root, "rev-parse", "HEAD"), head);
});

test("sync refuses to upload to a public GitHub repository", async () => {
  const roll = GitRoll.init(tmp());
  git(roll.root, "remote", "add", "origin", "git@github.com:someone/my-roll.git");
  roll.addEntry({ text: "Private" });
  const fakeGitHub = (async () => new Response(JSON.stringify({ private: false }), { status: 200 })) as typeof fetch;
  const result = await roll.sync({ fetch: fakeGitHub, useGhCli: false });
  assert.equal(result.code, "public");
  assert.match(result.message, /public repository/);
});

test("uncommitted hand edits survive a sync", async () => {
  const remote = fakeGitHubRepo();
  const roll = clonedRoll(remote);
  const e = roll.addEntry({ text: "Draft" });
  assert.ok((await roll.sync()).ok);
  fs.appendFileSync(path.join(roll.root, e.path), "\nMore detail, not committed yet.\n");
  roll.addEntry({ text: "Another event" });
  const result = (await roll.sync());
  assert.ok(result.ok, result.message);
  assert.match(fs.readFileSync(path.join(roll.root, e.path), "utf8"), /not committed yet/);
});

test("privacy is checked on the real push destination, not the download address", async () => {
  const remote = fakeGitHubRepo();
  const roll = clonedRoll(remote);
  roll.addEntry({ text: "Private" });
  git(roll.root, "remote", "set-url", "--push", "origin", "git@github.com:someone/public-roll.git");
  const githubSaysPublic = (async () => new Response(JSON.stringify({ private: false }), { status: 200 })) as typeof fetch;
  const result = await roll.sync({ fetch: githubSaysPublic, useGhCli: false });
  assert.equal(result.code, "public");
  assert.match(result.message, /github\.com\/someone\/public-roll/);
  assert.throws(() => git(remote, "rev-parse", "main"), "nothing was uploaded");
});

test("when privacy can't be confirmed, nothing is uploaded", async () => {
  const roll = GitRoll.init(tmp());
  git(roll.root, "remote", "add", "origin", "git@github.com:someone/my-roll.git");
  roll.addEntry({ text: "Private" });
  const offline = (async () => {
    throw new Error("offline");
  }) as typeof fetch;
  const rateLimited = (async () => new Response("{}", { status: 403 })) as typeof fetch;
  for (const answer of [offline, rateLimited]) {
    const result = await roll.sync({ fetch: answer, useGhCli: false });
    assert.equal(result.code, "unverified");
    assert.match(result.message, /Nothing was uploaded/);
  }
});

test("a non-GitHub backup needs to be trusted explicitly", async () => {
  const roll = GitRoll.init(tmp());
  git(roll.root, "remote", "add", "origin", "https://git.example.invalid/me/roll.git");
  roll.addEntry({ text: "Private" });
  const refused = await roll.sync({ useGhCli: false });
  assert.equal(refused.code, "unverified");
  assert.match(refused.message, /gitroll trust git\.example\.invalid\/me\/roll/);

  const config = loadUserConfig();
  saveUserConfig({ ...config, trustedRemotes: ["git.example.invalid/me/roll"] });
  const attempted = await roll.sync({ useGhCli: false });
  assert.notEqual(attempted.code, "unverified", "a trusted address is allowed (this one is unreachable)");
  assert.equal(attempted.ok, false);
});
