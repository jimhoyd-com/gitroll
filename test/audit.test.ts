// Regressions for what a real-world audit of 0.3.0 found: writing that was
// quietly thinned or lost, and status that claimed more than it knew.
//
// Each test here is named after the behaviour a person would notice, not the
// function that was wrong, because that is how it was found.

import "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { NO_AMOUNT, suggestedAmount, amountsInText } from "../src/core/util.ts";
import { GitRoll } from "../src/node/repo.ts";
import { Composer } from "../src/node/tui/compose.ts";
import { editorCommand, git, tmp } from "./helpers.ts";

const cli = fileURLToPath(new URL("../src/node/cli.ts", import.meta.url));

function gitroll(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): { out: string; code: number } {
  try {
    const out = execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", cli, ...args], {
      cwd: opts.cwd ?? tmp(),
      encoding: "utf8",
      input: "",
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { out, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { out: `${err.stdout ?? ""}${err.stderr ?? ""}`, code: err.status ?? 1 };
  }
}

function roll(name = "Audit"): GitRoll {
  const dir = path.join(tmp(), "roll");
  fs.mkdirSync(dir, { recursive: true });
  return GitRoll.init(dir, { name });
}

/** An event with everything in it that an earlier undo used to drop. */
const RICH = `---
date: 2026-03-01
amount: 41.90
currency: EUR
projects: [house]
tags: [receipt]
warranty: 2031-03-01
# the plumber's own reference
ref: "AB-19/2"
---

# The tap was replaced

Body text, kept exactly.

[Receipt](../files/receipt.pdf)
`;

test("undo puts a deleted event back byte for byte, front matter and all", () => {
  const r = roll();
  fs.mkdirSync(path.join(r.root, ".gitroll/files"), { recursive: true });
  fs.writeFileSync(path.join(r.root, ".gitroll/files/receipt.pdf"), "pdf");
  const rel = ".gitroll/events/2026-03-01-tap.md";
  fs.writeFileSync(path.join(r.root, rel), RICH);
  r.commitPending();

  const before = fs.readFileSync(path.join(r.root, rel), "utf8");
  const entry = r.entry(rel);
  const source = r.deleteEntry(rel);
  assert.equal(fs.existsSync(path.join(r.root, rel)), false);

  // The route the terminal's Ctrl+Z takes: the file it was handed back.
  r.restoreEntry(entry, source);
  assert.equal(fs.readFileSync(path.join(r.root, rel), "utf8"), before, "the file is exactly what it was");

  // And the route /deleted and the browser take: read back out of history.
  r.deleteEntry(rel);
  const back = r.restoreDeleted("2026-03-01-tap");
  assert.equal(fs.readFileSync(path.join(r.root, back.path), "utf8"), before, "the same file, by the other way back");
  assert.equal(back.amount?.value, 41.9);
  assert.equal(back.amount?.currency, "EUR");
  assert.deepEqual(back.projects, ["house"]);
  assert.ok(back.tags.includes("receipt"));
  assert.equal(back.meta.warranty instanceof Date ? back.meta.warranty.toISOString().slice(0, 10) : back.meta.warranty, "2031-03-01");
  assert.equal(back.meta.ref, "AB-19/2");
});

test("an event edited in $EDITOR keeps every change, front matter included", () => {
  const r = roll();
  const rel = ".gitroll/events/2026-03-01-tap.md";
  fs.writeFileSync(path.join(r.root, rel), RICH);
  r.commitPending();

  const edited = gitroll(["edit", "2026-03-01-tap", "--editor", "-C", r.root], {
    env: {
      EDITOR: editorCommand((text) =>
        text
          .replace("amount: 41.90", "amount: 99")
          .replace("date: 2026-03-01", "date: 2026-03-02")
          .replace("warranty: 2031-03-01", "warranty: 2032-03-01")
          .replace("Body text, kept exactly.", "Body text, edited by hand."),
      ),
    },
  });
  assert.equal(edited.code, 0, edited.out);

  const after = fs.readFileSync(path.join(r.root, rel), "utf8");
  assert.match(after, /amount: 99/, "the amount someone typed is the amount");
  assert.match(after, /date: 2026-03-02/);
  assert.match(after, /warranty: 2032-03-01/, "a key GitRoll doesn't read is still edited");
  assert.match(after, /# the plumber's own reference/, "and their comment survives");
  assert.match(after, /Body text, edited by hand\./);
  assert.match(after, /\[Receipt\]/, "the file link is untouched");
});

test("front matter that won't parse refuses the save and keeps what was typed", () => {
  const r = roll();
  const rel = ".gitroll/events/2026-03-01-tap.md";
  fs.writeFileSync(path.join(r.root, rel), RICH);
  r.commitPending();
  const before = fs.readFileSync(path.join(r.root, rel), "utf8");

  const failed = gitroll(["edit", "2026-03-01-tap", "--editor", "-C", r.root], {
    env: { EDITOR: editorCommand((text) => text.replace("amount: 41.90", "amount: [unclosed").replace("Body text, kept exactly.", "Writing worth keeping.")) },
  });
  assert.equal(failed.code, 1);
  assert.match(failed.out, /invalid YAML/);
  assert.equal(fs.readFileSync(path.join(r.root, rel), "utf8"), before, "the existing record is untouched");

  const kept = /\n {2}(\S+gitroll-edit-\d+\.md)/.exec(failed.out)?.[1];
  assert.ok(kept, `the editor's text is kept somewhere and said so: ${failed.out}`);
  assert.match(fs.readFileSync(kept, "utf8"), /Writing worth keeping\./, "and nothing typed was thrown away");
});

test("an impossible date is refused before a file is written, and a real one is not", () => {
  const r = roll();
  for (const bad of ["2026-02-30", "2026-99-99", "2026-13-01"]) {
    const refused = gitroll(["log", "AC serviced", "--at", bad, "-C", r.root]);
    assert.equal(refused.code, 1, `${bad} was accepted`);
    assert.match(refused.out, /no such date/);
  }
  assert.equal(r.entries().length, 0, "nothing was written by any of them");

  assert.equal(gitroll(["log", "Leap day", "--at", "2028-02-29", "-C", r.root]).code, 0);
  assert.equal(r.entries()[0].date?.slice(0, 10), "2028-02-29");

  // The same rule when the date is changed rather than given.
  const badEdit = gitroll(["edit", "leap-day", "--at", "2026-02-30", "-C", r.root]);
  assert.equal(badEdit.code, 1);
  assert.match(badEdit.out, /no such date/);
});

test("an undated event is usable, and check says so without failing", () => {
  const r = roll();
  fs.writeFileSync(path.join(r.root, ".gitroll/events/notes.md"), "# Notes\n\nSomething that happened, on no particular day.\n");
  r.commitPending();

  const found = gitroll(["show", "notes", "-C", r.root]);
  assert.equal(found.code, 0, found.out);
  assert.match(found.out, /undated/);

  const checked = gitroll(["check", "-C", r.root, "--json"]);
  assert.equal(checked.code, 0, "an undated event is not a failure");
  const report = JSON.parse(checked.out) as { errors: unknown[]; warnings: { path: string; error: string }[] };
  assert.deepEqual(report.errors, []);
  assert.match(report.warnings[0].error, /no date/);

  // A link that leads nowhere is a different matter.
  fs.writeFileSync(path.join(r.root, ".gitroll/events/2026-01-01-broken.md"), "# Broken\n\n[gone](./nope.md)\n");
  r.commitPending();
  const again = gitroll(["check", "-C", r.root]);
  assert.equal(again.code, 1);
  assert.match(again.out, /nope\.md, which isn't in this Roll/);
});

test("moving an event keeps the links pointing at it, anchors and spaces included", () => {
  const r = roll();
  const a = r.save({ text: "Event A happened" }, []).entry;
  fs.writeFileSync(
    path.join(r.root, ".gitroll/events/2026-05-01-event-b.md"),
    `# Event B\n\nSee [Event A](./${path.basename(a.path)}#step-two), and [again](${path.basename(a.path)}).\n`,
  );
  r.commitPending();

  const moved = r.moveEntry(a.path, ".gitroll/events/house/2026 notes/moved.md");
  const b = r.entries().find((e) => e.path.endsWith("event-b.md"))!;
  assert.deepEqual(b.links, [moved.path], "B still points at A");
  assert.match(r.entrySource(b.path), /#step-two/, "and the anchor came with it");
  assert.deepEqual(r.check().filter((p) => (p.severity ?? "error") === "error"), [], "nothing is broken");
  assert.ok(r.history(moved.path).length >= 1, "history follows the move");
});

test("saved, committed and uploaded are three different things", () => {
  const r = roll();
  const remote = path.join(tmp(), "remote.git");
  fs.mkdirSync(remote, { recursive: true });
  git(remote, "init", "-q", "--bare", "-b", "main");
  r.save({ text: "Logged through the app" }, []);
  r.git(["remote", "add", "origin", remote]);
  r.git(["push", "-q", "-u", "origin", "HEAD:refs/heads/main"]);

  // Written by hand, in somebody's own editor: saved, not committed.
  fs.writeFileSync(path.join(r.root, ".gitroll/events/2026-04-01-by-hand.md"), "---\ndate: 2026-04-01\n---\n\n# Written by hand\n");
  // And a code file, which is none of GitRoll's business.
  fs.writeFileSync(path.join(r.root, "app.js"), "export const x = 1;\n");
  git(r.root, "add", "app.js");

  const status = r.status();
  assert.equal(status.ahead, 0, "every commit is uploaded");
  assert.equal(status.uncommittedLog, 1, "and one log record is not in any of them");

  const said = gitroll(["status", "-C", r.root]);
  assert.doesNotMatch(said.out, /^Synced with/m, "so nothing says the Roll is simply synced");
  assert.match(said.out, /isn't committed, so it isn't backed up/);
  assert.match(said.out, /gitroll save/);

  // Saving commits the log and nothing else, and leaves the index alone.
  const saved = gitroll(["save", "-C", r.root]);
  assert.equal(saved.code, 0, saved.out);
  assert.equal(r.status().uncommittedLog, 0);
  assert.match(git(r.root, "status", "--porcelain"), /^A {2}app\.js$/m, "the staged code file is still staged, and uncommitted");
  assert.match(gitroll(["status", "-C", r.root]).out, /1 commit to sync/);
});

test("syncing says it uploads the whole branch, and asks before it takes code with it", () => {
  const r = roll();
  const remote = path.join(tmp(), "remote.git");
  fs.mkdirSync(remote, { recursive: true });
  git(remote, "init", "-q", "--bare", "-b", "main");
  r.save({ text: "Logged through the app" }, []);
  r.git(["remote", "add", "origin", remote]);

  fs.writeFileSync(path.join(r.root, "app.js"), "export const x = 1;\n");
  git(r.root, "add", "app.js");
  git(r.root, "commit", "-qm", "feat: the code, not the log");
  assert.equal(r.status().pendingOther, 1);

  const refused = gitroll(["sync", "-C", r.root, "--non-interactive"]);
  assert.equal(refused.code, 1, refused.out);
  assert.match(refused.out, /files outside \.gitroll\//);
  assert.equal(git(remote, "rev-list", "--count", "--all").trim(), "0", "and nothing was uploaded");

  const agreed = gitroll(["sync", "-C", r.root, "--yes"]);
  assert.equal(agreed.code, 0, agreed.out);
  assert.match(agreed.out, /Uploading branch main to/);
  assert.notEqual(git(remote, "rev-list", "--count", "--all").trim(), "0");
});

test("a deleted event is findable and recoverable from the one-shot CLI", () => {
  const r = roll();
  const e = r.save({ text: "Paid the plumber", amount: { value: 240, currency: "USD" }, tags: ["receipt"] }, []).entry;
  r.deleteEntry(e.path);

  const listed = gitroll(["deleted", "-C", r.root, "--json"]);
  assert.equal(listed.code, 0, listed.out);
  const [gone] = JSON.parse(listed.out) as { path: string; title: string }[];
  assert.equal(gone.path, e.path);

  const back = gitroll(["undelete", "plumber", "-C", r.root, "--json"]);
  assert.equal(back.code, 0, back.out);
  const restored = r.entries().find((x) => x.path === e.path)!;
  assert.equal(restored.amount?.value, 240, "with its metadata intact");
  assert.ok(restored.tags.includes("receipt"));
});

test("an amount is suggested by GitRoll's own composers, and never read out of a file it did not write", () => {
  // One rule, one implementation: the browser composer and the terminal
  // composer both ask this.
  assert.deepEqual(suggestedAmount("Paid $40 for the part"), { value: 40, currency: "USD" });
  assert.equal(amountsInText("$40 now and $12.50 later").length, 2, "several sums are countable, so a person can be told");
  assert.equal(suggestedAmount("Issue #40 took 40 minutes"), null, "a number is not a sum");

  const composer = new Composer({ projects: [], tags: [] });
  composer.input("text").set("Paid $40 for the part");
  assert.deepEqual(composer.suggested(), { value: 40, currency: "USD" });
  assert.deepEqual(composer.toInput().amount, { value: 40, currency: "USD" }, "the terminal composer records what it showed");
  composer.input("amount").set(NO_AMOUNT);
  assert.equal(composer.toInput().amount, undefined, "and a person can say it isn't one");

  // A one-shot CLI log is explicit: a script's text is not searched for money.
  const r = roll();
  gitroll(["log", "Paid $40 for the part", "-C", r.root]);
  assert.equal(r.entries()[0].amount, undefined, "nothing is inferred from a non-interactive log");

  // Neither is a file somebody wrote themselves.
  fs.writeFileSync(path.join(r.root, ".gitroll/events/2026-06-01-by-hand.md"), "# Paid $40 for the part\n");
  r.commitPending();
  assert.equal(r.entries().find((e) => e.path.endsWith("by-hand.md"))!.amount, undefined);
});
