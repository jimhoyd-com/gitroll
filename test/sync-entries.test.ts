// Two clones of one Roll, both writing into shared monthly files.
//
// A line-based merge is wrong here: two people appending to September touch the
// same lines and disagree about nothing. These tests are the proof that sync
// reasons about entries — and the reason automatic compression stays off by
// default until they pass.
import "./helpers.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { defaultStorage } from "../src/core/storage.ts";
import { mergeArchiveState, mergeSegment } from "../src/node/sync-entries.ts";
import { gunzipText, gzipDeterministic } from "../src/node/gzip.ts";
import { GitRoll } from "../src/node/repo.ts";
import { fakeGitHubRepo, git, tmp } from "./helpers.ts";

const TZ = "America/Chicago";

function sharedRoll(remote: string, name: string): GitRoll {
  const dir = path.join(tmp(), name);
  git(path.dirname(dir), "clone", "-q", remote, dir);
  const roll = GitRoll.init(dir, { name: "Shared Roll" });
  roll.setStorage(defaultStorage(TZ, "monthly"));
  return roll;
}

function cloneOf(remote: string, name: string): GitRoll {
  const dir = path.join(tmp(), name);
  git(path.dirname(dir), "clone", "-q", remote, dir);
  const roll = new GitRoll(dir);
  return roll;
}

const titles = (roll: GitRoll) => roll.entries().map((e) => e.title).sort();

test("two devices appending to the same month both keep their entries", async () => {
  const remote = fakeGitHubRepo();
  const laptop = sharedRoll(remote, "laptop");
  laptop.addEntry({ text: "Opened the account", date: "2026-09-01" });
  assert.ok((await laptop.sync()).ok);

  const phone = cloneOf(remote, "phone");
  phone.addEntry({ text: "Paid the plumber", date: "2026-09-10" });
  assert.ok((await phone.sync()).ok);

  laptop.addEntry({ text: "Roof inspected", date: "2026-09-12" });
  const result = await laptop.sync();
  assert.ok(result.ok, result.message);
  assert.deepEqual(titles(laptop), ["Opened the account", "Paid the plumber", "Roof inspected"]);
  // Exactly once each: an addition is not duplicated by the merge.
  const text = fs.readFileSync(path.join(laptop.root, ".gitroll/logs/2026/09.md"), "utf8");
  assert.equal(text.match(/gitroll:entry/g)!.length, 3);
});

test("different entries edited on each side both apply", async () => {
  const remote = fakeGitHubRepo();
  const a = sharedRoll(remote, "a");
  const one = a.addEntry({ text: "First thing", date: "2026-09-01" });
  const two = a.addEntry({ text: "Second thing", date: "2026-09-02" });
  assert.ok((await a.sync()).ok);

  const b = cloneOf(remote, "b");
  b.updateEntry(two.id, { text: "Second thing, corrected" });
  assert.ok((await b.sync()).ok);

  a.updateEntry(one.id, { text: "First thing, corrected" });
  assert.ok((await a.sync()).ok);
  assert.deepEqual(titles(a), ["First thing, corrected", "Second thing, corrected"]);
});

test("the same entry edited on both sides keeps both texts and says so", async () => {
  const remote = fakeGitHubRepo();
  const a = sharedRoll(remote, "a");
  const e = a.addEntry({ text: "Paid the contractor", date: "2026-09-01" });
  assert.ok((await a.sync()).ok);

  const b = cloneOf(remote, "b");
  b.updateEntry(e.id, { text: "Paid the contractor $1,850 by cheque" });
  assert.ok((await b.sync()).ok);

  a.updateEntry(e.id, { text: "Paid the contractor $1,850 in cash" });
  const result = await a.sync();
  assert.ok(result.ok, result.message);
  const source = a.entrySource(e.id);
  assert.match(source, /in cash/);
  assert.match(source, /by cheque/);
  assert.match(source, /#conflict/);
  assert.equal(a.conflicts().length, 1);
});

test("an overflow filename created on both sides at once loses nothing", () => {
  // Two devices each open 09-002.md for their own entry, with no ancestor.
  const mine = section("01K5F8ZC7M4Q0X2R9T6V3B1DHE", "Mine");
  const theirs = section("01K5F8ZC7N4Q0X2R9T6V3B1DHF", "Theirs");
  const merge = mergeSegment({ base: null, mine: buf(mine), theirs: buf(theirs), path: ".gitroll/logs/2026/09-002.md" });
  const text = merge.data.toString("utf8");
  assert.match(text, /# Mine/);
  assert.match(text, /# Theirs/);
  assert.equal(merge.conflicts.length, 0);
});

test("an edit on one side and a delete on the other is a conflict, not a deletion", () => {
  const id = "01K5F8ZC7M4Q0X2R9T6V3B1DHE";
  const base = buf(section(id, "Original"));
  const mine = buf(section(id, "Original, revised"));
  const merge = mergeSegment({ base, mine, theirs: buf(""), path: ".gitroll/logs/2026/09.md" });
  assert.equal(merge.conflicts[0].kind, "edit-delete");
  assert.match(merge.data.toString("utf8"), /Original, revised/);
});

test("an entry moved to another period is a move, not a delete and a create", () => {
  const id = "01K5F8ZC7M4Q0X2R9T6V3B1DHE";
  const base = buf(section(id, "Roof", "2026-09-16"));
  const mine = buf(section(id, "Roof", "2026-09-16"));
  const theirs = buf(section(id, "Roof", "2026-11-02"));
  const merge = mergeSegment({ base, mine, theirs, path: ".gitroll/logs/2026/09.md" });
  assert.deepEqual(merge.displaced.map((d) => [d.id, d.period]), [[id, "2026-11"]]);
  assert.equal(merge.conflicts.length, 0);
  assert.doesNotMatch(merge.data.toString("utf8"), new RegExp(id));
});

test("two sides filing one entry differently is reported, not decided in silence", () => {
  const id = "01K5F8ZC7M4Q0X2R9T6V3B1DHE";
  const merge = mergeSegment({
    base: buf(section(id, "Trip", "2026-09-16")),
    mine: buf(section(id, "Trip", "2026-10-02")),
    theirs: buf(section(id, "Trip", "2026-11-03")),
    path: ".gitroll/logs/2026/09.md",
  });
  assert.equal(merge.conflicts.some((c) => c.kind === "placement"), true);
});

test("compressed segments are merged as entries, never as bytes", () => {
  const a = "01K5F8ZC7M4Q0X2R9T6V3B1DHE";
  const b = "01K5F8ZC7N4Q0X2R9T6V3B1DHF";
  const base = gzipDeterministic(section(a, "Shared"));
  const mine = gzipDeterministic(`${section(a, "Shared")}\n${section(b, "Mine only")}`);
  const theirs = gzipDeterministic(`${section(a, "Shared, edited")}`);
  const merge = mergeSegment({ base, mine, theirs, path: ".gitroll/logs/2026/09.md.gz" });
  const text = gunzipText(merge.data);
  assert.match(text, /Shared, edited/);
  assert.match(text, /Mine only/);
  assert.equal(merge.conflicts.length, 0);
});

test("two different decisions about archiving a period are surfaced, not overwritten", () => {
  const base = state({ "2026-09": { archived: false, compressed: false, auto: true } });
  const mine = state({ "2026-09": { archived: true, compressed: true, auto: true } });
  const theirs = state({ "2026-09": { archived: false, compressed: false, auto: false } });
  const merged = mergeArchiveState(base, mine, theirs);
  assert.deepEqual(merged.conflicts, ["2026-09"]);
  // One side changing nothing is not a disagreement.
  assert.deepEqual(mergeArchiveState(base, mine, base).conflicts, []);
  assert.match(mergeArchiveState(base, mine, base).text, /archived: true/);
});

test("a retried sync neither loses nor duplicates entries", async () => {
  const remote = fakeGitHubRepo();
  const a = sharedRoll(remote, "a");
  a.addEntry({ text: "One", date: "2026-09-01" });
  assert.ok((await a.sync()).ok);
  // Syncing again with nothing to do is a no-op, not a second copy.
  assert.ok((await a.sync()).ok);
  assert.ok((await a.sync()).ok);
  assert.deepEqual(titles(a), ["One"]);
  const b = cloneOf(remote, "b");
  assert.deepEqual(titles(b), ["One"]);
});

test("archiving on one side and editing on the other is settled explicitly", async () => {
  const remote = fakeGitHubRepo();
  const a = sharedRoll(remote, "a");
  const e = a.addEntry({ text: "January thing", date: "2026-01-05" });
  assert.ok((await a.sync()).ok);

  const b = cloneOf(remote, "b");
  b.archivePeriod("2026-01");
  assert.ok((await b.sync()).ok);

  a.updateEntry(e.id, { text: "January thing, corrected" });
  const result = await a.sync();
  assert.ok(result.ok, result.message);
  // The edit survives the archival: archiving is not a deletion.
  assert.equal(a.store.entries({ includeArchived: true }).find((x) => x.id === e.id)?.title, "January thing, corrected");
});

function section(id: string, title: string, filed = "2026-09-16"): string {
  return `<!-- gitroll:entry ${id} -->\n---\ndate: ${filed}\nfiled: ${filed}\n---\n\n# ${title}\n`;
}

const buf = (text: string) => Buffer.from(text, "utf8");

function state(periods: Record<string, { archived: boolean; compressed: boolean; auto: boolean }>): string {
  const lines = ["archive_version: 1", "periods:"];
  for (const [period, p] of Object.entries(periods)) {
    lines.push(`  "${period}":`, `    archived: ${p.archived}`, `    compressed: ${p.compressed}`, `    auto: ${p.auto}`);
  }
  return `${lines.join("\n")}\n`;
}
