// The storage commands from the outside: what a person (or a script) sees.
import "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { git, tmp } from "./helpers.ts";

const cli = fileURLToPath(new URL("../src/node/cli.ts", import.meta.url));

function gitroll(args: string[], cwd: string, input = ""): { out: string; code: number } {
  try {
    return { out: execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", cli, ...args], { cwd, encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] }), code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { out: `${err.stdout ?? ""}${err.stderr ?? ""}`, code: err.status ?? 1 };
  }
}

function roll(): string {
  const dir = path.join(tmp(), "roll");
  fs.mkdirSync(dir, { recursive: true });
  assert.equal(gitroll(["new", "CLI Roll", "--dir", dir], dir).code, 0);
  return dir;
}

test("storage settings are readable, settable and committed", () => {
  const dir = roll();
  assert.match(gitroll(["storage"], dir).out, /one file per event/);
  const set = gitroll(["storage", "--mode", "monthly", "--timezone", "America/Chicago", "--json"], dir);
  assert.equal(set.code, 0, set.out);
  assert.deepEqual(JSON.parse(set.out).mode, "monthly");
  assert.match(gitroll(["storage"], dir).out, /grouped monthly/);
  assert.equal(git(dir, "status", "--porcelain").trim(), "", "the setting is committed, so every device files entries the same way");

  // Changing how existing entries are stored is a migration, not a setting.
  assert.match(gitroll(["storage", "--mode", "daily"], dir).out, /migrate --to daily/);
});

test("logging, archiving and searching an archived period from the CLI", () => {
  const dir = roll();
  gitroll(["storage", "--mode", "monthly", "--timezone", "UTC"], dir);
  assert.equal(gitroll(["log", "Boiler serviced", "--at", "2026-02-10"], dir).code, 0);
  assert.equal(gitroll(["log", "Filter changed", "--at", "2026-09-10"], dir).code, 0);
  assert.ok(fs.existsSync(path.join(dir, ".gitroll/logs/2026/02.md")));

  const archived = gitroll(["archive", "2026-02", "--compress", "--json"], dir);
  assert.equal(archived.code, 0, archived.out);
  assert.equal(JSON.parse(archived.out).compressed, true);
  assert.ok(fs.existsSync(path.join(dir, ".gitroll/logs/2026/02.md.gz")));

  // Out of search by default, and the omission is stated rather than implied.
  const plain = gitroll(["find", "Boiler"], dir);
  assert.match(plain.out, /1 archived file is left out/);
  assert.match(plain.out, /--include-archive to look in it too/);
  assert.doesNotMatch(plain.out, /Boiler serviced\n/);
  // Asking for it says which results came out of the archive.
  const included = gitroll(["find", "Boiler", "--include-archive"], dir).out;
  assert.match(included, /Boiler serviced/);
  assert.match(included, /archived/);

  assert.match(gitroll(["unarchive", "2026-02"], dir).out, /Reopened 2026-02/);
  assert.ok(fs.existsSync(path.join(dir, ".gitroll/logs/2026/02.md")));
});

test("migration previews before it moves anything", () => {
  const dir = roll();
  gitroll(["log", "First event", "--at", "2026-03-01"], dir);
  const preview = gitroll(["migrate", "--to", "monthly", "--dry-run"], dir);
  assert.match(preview.out, /Migration preview/);
  assert.match(preview.out, /Nothing was changed/);
  assert.ok(!fs.existsSync(path.join(dir, ".gitroll/logs/2026/03.md")));

  const done = gitroll(["migrate", "--to", "monthly", "--yes", "--json"], dir);
  assert.equal(done.code, 0, done.out);
  assert.equal(JSON.parse(done.out).moved, 1);
  assert.ok(fs.existsSync(path.join(dir, ".gitroll/logs/2026/03.md")));
  assert.equal(git(dir, "status", "--porcelain").trim(), "");
});

test("usage separates attachments from log files and doesn't claim to shrink history", () => {
  const dir = roll();
  gitroll(["storage", "--mode", "monthly"], dir);
  gitroll(["log", "With a receipt", "--at", "2026-04-01"], dir);
  const out = gitroll(["usage"], dir).out;
  assert.match(out, /Attachments/);
  assert.match(out, /Git keeps every earlier version/);
  // Sizes a person can read, and a rollover target counted the way it is set.
  assert.doesNotMatch(out, /0\.00 MB/);
  assert.match(out, /1\.0 MiB or 1000 entries/);

  const json = JSON.parse(gitroll(["usage", "--json"], dir).out);
  assert.equal(json.entries, 1);
  assert.equal(json.archivedEntries, 0);
  assert.equal(json.attachments, 0);
  assert.equal(json.largest.entries, 1);
});

test("adding a Roll to an existing project says what that means, once", () => {
  const project = path.join(tmp(), "app");
  fs.mkdirSync(project, { recursive: true });
  git(path.dirname(project), "init", "-q", project);
  fs.writeFileSync(path.join(project, "index.js"), "console.log('hi')\n");
  git(project, "add", "-A");
  git(project, "commit", "-qm", "the project");

  // The warning is shown before anything is created, whoever is asking.
  const accepted = gitroll(["init", "Work log"], project);
  assert.equal(accepted.code, 0, accepted.out);
  assert.match(accepted.out, /dedicated private repository/);
  assert.match(accepted.out, /git push/);
  assert.match(accepted.out, /visibility/);
  assert.ok(fs.existsSync(path.join(project, ".gitroll/config.yaml")));
  // And it is not repeated on every save.
  assert.doesNotMatch(gitroll(["log", "Decided on the queue"], project).out, /visibility/);
});

test("caches, locks and temporaries are untracked in every configuration", () => {
  const dir = roll();
  gitroll(["storage", "--mode", "monthly"], dir);
  gitroll(["log", "Something", "--at", "2026-05-01"], dir);
  const ignore = fs.readFileSync(path.join(dir, ".gitroll/.gitignore"), "utf8");
  for (const pattern of ["*.gitroll-tmp", "index.json"]) assert.match(ignore, new RegExp(pattern.replace("*", "\\*")));
  // The index and the write lock live in .git/, which Git never tracks.
  assert.ok(fs.existsSync(path.join(dir, ".git/gitroll/index.json")));
  assert.equal(git(dir, "status", "--porcelain").trim(), "");
});

test("hand-written entries keep their formatting, and get ids only when asked", () => {
  const dir = roll();
  gitroll(["storage", "--mode", "monthly", "--timezone", "UTC"], dir);
  gitroll(["log", "Through GitRoll"], dir);
  const file = path.join(dir, ".gitroll/logs/2026/09.md");
  const written = "# Typed by hand\n\n\nTheir   spacing.   \n    - indented   \n\n";
  fs.appendFileSync(file, `\n${written}`);

  // It is an entry immediately.
  assert.match(gitroll(["find", "Typed"], dir).out, /Typed by hand/);
  // Logging something else doesn't touch it.
  gitroll(["log", "Another through GitRoll"], dir);
  assert.ok(fs.readFileSync(file, "utf8").includes(written), "byte for byte");
  assert.equal((fs.readFileSync(file, "utf8").match(/gitroll:entry/g) ?? []).length, 2);

  assert.match(gitroll(["adopt", "--dry-run"], dir).out, /1 entry is identified only by their heading|1 entry is/);
  const adopted = gitroll(["adopt", "--yes", "--json"], dir);
  assert.equal(JSON.parse(adopted.out).adopted, 1);
  const after = fs.readFileSync(file, "utf8");
  assert.equal((after.match(/gitroll:entry/g) ?? []).length, 3);
  assert.ok(after.includes(written), "adopting adds a marker and changes nothing else");
  assert.equal(git(dir, "status", "--porcelain").trim(), "");
});

test("migrate regroups a grouped Roll, and says so when there's nothing to do", () => {
  const dir = roll();
  gitroll(["storage", "--mode", "monthly", "--timezone", "UTC"], dir);
  gitroll(["log", "Roof inspected", "--at", "2026-09-08T14:10"], dir);
  gitroll(["log", "Boiler serviced", "--at", "2026-09-03"], dir);

  const preview = gitroll(["migrate", "--to", "daily", "--dry-run"], dir);
  assert.match(preview.out, /2 entries would move into daily files/);
  assert.match(preview.out, /09\.md → \.gitroll\/logs\/2026\/09\/08\.md/);
  assert.match(preview.out, /Nothing was changed/);
  assert.ok(fs.existsSync(path.join(dir, ".gitroll/logs/2026/09.md")));

  const done = gitroll(["migrate", "--to", "daily", "--yes", "--json"], dir);
  assert.equal(JSON.parse(done.out).moved, 2);
  assert.ok(fs.existsSync(path.join(dir, ".gitroll/logs/2026/09/08.md")));
  assert.ok(!fs.existsSync(path.join(dir, ".gitroll/logs/2026/09.md")));
  assert.equal(git(dir, "status", "--porcelain").trim(), "");

  // Asking again is not "0 events would move": it says the Roll is already there.
  const again = gitroll(["migrate", "--to", "daily"], dir);
  assert.match(again.out, /already stores entries one file per day/);
  assert.doesNotMatch(again.out, /Run it for real/);
});

test("deleting an entry deletes that entry, not the first one in its file", () => {
  const dir = roll();
  gitroll(["storage", "--mode", "monthly", "--timezone", "UTC"], dir);
  gitroll(["log", "First in the file", "--at", "2026-09-01"], dir);
  gitroll(["log", "Second, the one to delete", "--at", "2026-09-02"], dir);
  gitroll(["log", "Third", "--at", "2026-09-03"], dir);

  const target = JSON.parse(gitroll(["find", "Second", "--json"], dir).out)[0];
  const result = gitroll(["delete", target.id, "--yes", "--json"], dir);
  assert.equal(result.code, 0, result.out);
  assert.equal(JSON.parse(result.out).deleted, target.id);

  const left = JSON.parse(gitroll(["recent", "--json"], dir).out).map((e: { title: string }) => e.title).sort();
  assert.deepEqual(left, ["First in the file", "Third"]);
  // …and the others are untouched in the file they share.
  const file = fs.readFileSync(path.join(dir, ".gitroll/logs/2026/09.md"), "utf8");
  assert.match(file, /# First in the file/);
  assert.match(file, /# Third/);
  assert.doesNotMatch(file, /# Second/);
});

test("today, recent and find are one list with the query already written", () => {
  // They used to be three implementations: only find said what it had left
  // out, and only find could be asked to include the archive. A person asking
  // "what did I log today" deserves the same honesty as one searching.
  const dir = roll();
  gitroll(["storage", "--mode", "monthly", "--timezone", "UTC"], dir);
  gitroll(["log", "Boiler serviced", "--at", "2026-02-10"], dir);
  gitroll(["log", "Logged just now"], dir);
  gitroll(["archive", "2026-02"], dir);

  for (const command of [["today"], ["recent"], ["find", "Logged"]]) {
    const out = gitroll(command, dir).out;
    assert.match(out, /1 archived file is left out/, `${command[0]} says what it left out`);
    assert.match(out, /Logged just now/, `${command[0]} finds today's entry`);
    assert.doesNotMatch(out, /Boiler serviced/, `${command[0]} keeps the archive out by default`);
    const included = gitroll([...command, "--include-archive"], dir);
    assert.equal(included.code, 0, `${command[0]} takes --include-archive`);
    assert.doesNotMatch(included.out, /archived file is left out/, `${command[0]} stops warning once it is looking`);
  }
  // And asking for it reaches the archived entry, in the two lists it belongs to.
  assert.match(gitroll(["recent", "--include-archive"], dir).out, /Boiler serviced/);
  assert.match(gitroll(["find", "Boiler", "--include-archive"], dir).out, /Boiler serviced/);

  // Today is today in the Roll's zone, not the one this computer is set to.
  gitroll(["storage", "--timezone", "Pacific/Kiritimati"], dir);
  const ahead = gitroll(["today", "--json"], dir);
  assert.equal(ahead.code, 0, ahead.out);
  assert.equal(JSON.parse(ahead.out).length, 0, "a Roll a day ahead has nothing logged today yet");
});
