// A log that shares a repository with a project.
//
// The thing under test is whose commit it is. GitRoll committing every event as
// it is written is right for a Roll of its own and wrong in the middle of
// somebody's branch, so a Roll can say `commit: manual` and keep the writing
// while leaving Git to its owner.

import "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { GitRoll } from "../src/node/repo.ts";
import { git, tmp } from "./helpers.ts";

const cli = fileURLToPath(new URL("../src/node/cli.ts", import.meta.url));

function gitroll(args: string[]): { out: string; code: number } {
  try {
    return { out: execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", cli, ...args], { encoding: "utf8", cwd: tmp(), stdio: ["pipe", "pipe", "pipe"] }), code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { out: `${err.stdout ?? ""}${err.stderr ?? ""}`, code: err.status ?? 1 };
  }
}

/** A repository with a project in it, and a log added beside the code. */
function project(config = ""): GitRoll {
  const dir = path.join(tmp(), "project");
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "app.js"), "export const x = 1;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "feat: the project");
  const roll = GitRoll.init(dir, { name: "Project log" });
  if (config) fs.appendFileSync(path.join(dir, ".gitroll/config.yaml"), config);
  return roll;
}

const commits = (roll: GitRoll) => git(roll.root, "log", "--format=%s").trim().split("\n").filter(Boolean);

test("commit: manual writes the event and leaves the commit to its owner", () => {
  const roll = project("commit: manual\n");
  const before = commits(roll).length;

  const logged = gitroll(["log", "Chose Postgres over the alternatives", "-C", roll.root]);
  assert.equal(logged.code, 0, logged.out);
  assert.match(logged.out, /not committed \(commit: manual\)/);

  const [entry] = roll.entries();
  assert.ok(fs.existsSync(path.join(roll.root, entry.path)), "the event is on disk");
  assert.equal(commits(roll).length, before, "and nothing was committed on the branch");
  assert.equal(roll.status().uncommittedLog, 2, "the event and the edited config are both waiting");

  // Editing and deleting follow the same rule.
  gitroll(["edit", entry.path, "--text", "Chose Postgres. Ruled out MySQL on replication.", "-C", roll.root]);
  assert.match(roll.entrySource(entry.path), /replication/);
  assert.equal(commits(roll).length, before, "still the owner's branch, untouched");

  // And `save` is how the person asks for the commit they were left to make.
  const saved = gitroll(["save", "-C", roll.root]);
  assert.equal(saved.code, 0, saved.out);
  assert.equal(roll.status().uncommittedLog, 0);
  assert.equal(commits(roll).length, before + 1, "one commit, when it was asked for");
});

test("commit_prefix keeps a repository's commit convention", () => {
  const roll = project('commit_prefix: "chore(gitroll): "\n');
  roll.save({ text: "Deployed 2.1 to production" }, []);
  assert.match(commits(roll)[0], /^chore\(gitroll\): log: Deployed 2\.1/, "the prefix is used exactly as written, and the kind survives");

  // Every kind of commit GitRoll makes, not just logging.
  const [entry] = roll.entries();
  roll.moveEntry(entry.path, ".gitroll/events/releases/2-1.md");
  assert.match(commits(roll)[0], /^chore\(gitroll\): move:/);
});

test("a repository's own commit hook refuses the commit without costing the writing", () => {
  const roll = project();
  const hooks = path.join(roll.root, ".git/hooks");
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(hooks, "pre-commit"), "#!/bin/sh\necho 'eslint: 3 problems'\nexit 1\n", { mode: 0o755 });

  const refused = gitroll(["log", "The 3am incident", "-C", roll.root]);
  assert.equal(refused.code, 1);
  assert.match(refused.out, /written and safe on this computer/);
  assert.match(refused.out, /pre-commit hook/, "the hook is named rather than guessed at from the error text");
  assert.match(refused.out, /commit: manual/, "and the way to stop it happening again is given");

  // The event itself is exactly where a person would look for it.
  const [entry] = roll.entries();
  assert.match(roll.entrySource(entry.path), /The 3am incident/);
  assert.equal(roll.status().uncommittedLog, 1, "waiting to be committed, not lost");
});

test("status says which arrangement a Roll is under", () => {
  const manual = project("commit: manual\n");
  manual.save({ text: "Something worth keeping" }, []);
  const said = gitroll(["status", "-C", manual.root]);
  assert.match(said.out, /written but not committed — this Roll is set commit: manual/);
  assert.equal(JSON.parse(gitroll(["status", "-C", manual.root, "--json"]).out).commit, "manual");

  const auto = project();
  auto.save({ text: "Something worth keeping" }, []);
  assert.equal(auto.status().uncommittedLog, 0, "auto mode commits as it writes, as it always has");
  assert.equal(JSON.parse(gitroll(["status", "-C", auto.root, "--json"]).out).commit, "auto");
});
