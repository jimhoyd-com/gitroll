// Grouped storage on disk: writing, editing, moving, archiving, compressing,
// indexing and migrating — and the awkward moments in between (two writers at
// once, a retried import, an interrupted compression, a corrupt archive).
import "./helpers.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { defaultStorage } from "../src/core/storage.ts";
import { GitRoll } from "../src/node/repo.ts";
import { applyMigration, planMigration } from "../src/node/migrate.ts";
import { EntryStore, MOVED_PATH } from "../src/node/store.ts";
import { gunzipText, gzipDeterministic } from "../src/node/gzip.ts";
import { withWriteLock } from "../src/node/lock.ts";
import { tmp } from "./helpers.ts";

const TZ = "America/Chicago";

function newRoll(mode: "monthly" | "daily" | "event" = "monthly"): GitRoll {
  const roll = GitRoll.init(path.join(tmp(), "roll"), { name: "Test Roll" });
  if (mode !== "event") {
    roll.setStorage(defaultStorage(TZ, mode));
  }
  return roll;
}

const read = (roll: GitRoll, rel: string) => fs.readFileSync(path.join(roll.root, rel), "utf8");
const exists = (roll: GitRoll, rel: string) => fs.existsSync(path.join(roll.root, rel));

test("a new Roll files entries by month, in the Roll's zone", () => {
  const roll = newRoll();
  const a = roll.addEntry({ text: "AC serviced", date: "2026-10-01T02:00:00Z" });
  const b = roll.addEntry({ text: "Filter changed", date: "2026-10-01" });
  // 02:00 UTC on 1 October is 30 September in Chicago, so it goes in September.
  assert.equal(a.path, ".gitroll/logs/2026/09.md");
  assert.equal(b.path, ".gitroll/logs/2026/10.md");
  assert.match(read(roll, ".gitroll/logs/2026/09.md"), /filed: 2026-09-30/);
  assert.match(read(roll, ".gitroll/logs/2026/09.md"), /# AC serviced/);
  // The occurrence keeps its own offset; when it was written down is separate.
  assert.match(read(roll, ".gitroll/logs/2026/09.md"), /^created: /m);
});

test("a daily Roll files by day", () => {
  const roll = newRoll("daily");
  const e = roll.addEntry({ text: "Shift handover", date: "2026-09-16T09:00:00-05:00" });
  assert.equal(e.path, ".gitroll/logs/2026/09/16.md");
});

test("an entry keeps its id when its date moves it to another period", () => {
  const roll = newRoll();
  const e = roll.addEntry({ text: "Roof inspected", date: "2026-09-16" });
  const moved = roll.updateEntry(e.id, { date: "2026-11-02" });
  assert.equal(moved.id, e.id);
  assert.equal(moved.path, ".gitroll/logs/2026/11.md");
  // The link still resolves by id, wherever the entry went.
  assert.equal(roll.entry(e.id).path, ".gitroll/logs/2026/11.md");
  assert.doesNotMatch(read(roll, ".gitroll/logs/2026/09.md"), new RegExp(e.id));
});

test("editing one entry leaves the rest of the file byte for byte", () => {
  const roll = newRoll();
  const a = roll.addEntry({ text: "First", date: "2026-09-10" });
  const b = roll.addEntry({ text: "Second", date: "2026-09-11" });
  const before = read(roll, ".gitroll/logs/2026/09.md");
  roll.updateEntry(a.id, { text: "First, revised" });
  const after = read(roll, ".gitroll/logs/2026/09.md");
  assert.match(after, /First, revised/);
  assert.equal(after.slice(after.indexOf(b.id)), before.slice(before.indexOf(b.id)));
});

test("deleting an entry removes it and nothing else", () => {
  const roll = newRoll();
  const a = roll.addEntry({ text: "Keep me", date: "2026-09-10" });
  const b = roll.addEntry({ text: "Delete me", date: "2026-09-11" });
  roll.deleteEntry(b.id);
  assert.deepEqual(roll.entries().map((e) => e.title), ["Keep me"]);
  assert.match(read(roll, ".gitroll/logs/2026/09.md"), new RegExp(a.id));
});

test("rollover opens 002 and keeps appending to the highest segment", () => {
  const roll = newRoll();
  const settings = roll.store.settings();
  roll.setStorage({ ...settings, limits: { maxBytes: 600, maxEntries: 1000 } });
  for (let i = 0; i < 6; i++) roll.addEntry({ text: `Entry ${i} ${"x".repeat(100)}`, date: "2026-09-10" });
  assert.ok(exists(roll, ".gitroll/logs/2026/09.md"));
  assert.ok(exists(roll, ".gitroll/logs/2026/09-002.md"));
  // Nothing is renamed or renumbered by a later write.
  const first = read(roll, ".gitroll/logs/2026/09.md");
  roll.addEntry({ text: "later", date: "2026-09-10" });
  assert.equal(read(roll, ".gitroll/logs/2026/09.md"), first);
});

test("a batch of backdated imports touches each destination file once", () => {
  const roll = newRoll();
  const inputs = [
    { content: "# One\n", date: "2026-07-04" },
    { content: "# Two\n", date: "2026-07-20" },
    { content: "# Three\n", date: "2026-08-02" },
  ];
  const result = roll.store.put(inputs);
  assert.deepEqual(result.paths.sort(), [".gitroll/logs/2026/07.md", ".gitroll/logs/2026/08.md"]);
  assert.equal(result.entries.length, 3);
});

test("a retried import writes nothing twice, and identical text alone is not a duplicate", () => {
  const roll = newRoll();
  const one = roll.store.put([{ content: "# Ping\n", date: "2026-09-01", key: "src:1" }], { importer: "feed", checkpoint: "1" });
  const again = roll.store.put([{ content: "# Ping\n", date: "2026-09-01", key: "src:1" }], { importer: "feed", checkpoint: "1" });
  assert.equal(again.entries.length, 0);
  assert.deepEqual(again.skipped, [one.entries[0].id]);
  assert.equal(roll.store.index.checkpoint("feed"), "1");
  // The same words with no key are a second thing that happened, not a duplicate.
  const twin = roll.store.put([{ content: "# Ping\n", date: "2026-09-01" }]);
  assert.equal(twin.entries.length, 1);
  assert.notEqual(twin.entries[0].id, one.entries[0].id);
});

test("two writers can't interleave a read-modify-write", () => {
  const roll = newRoll();
  roll.addEntry({ text: "First", date: "2026-09-01" });
  const gitDir = path.join(roll.root, ".git");
  assert.throws(
    () => withWriteLock(gitDir, "a test", () => roll.addEntry({ text: "Second", date: "2026-09-01" })),
    /Another GitRoll writer is busy/,
  );
  // The lock is released when the holder finishes, crash or not.
  assert.ok(roll.addEntry({ text: "Third", date: "2026-09-01" }));
});

test("archiving hides a period without deleting anything, and unarchiving brings it back", () => {
  const roll = newRoll();
  roll.addEntry({ text: "Old news", date: "2026-01-05" });
  roll.addEntry({ text: "Recent", date: "2026-09-05" });
  roll.store.archive("2026-01");
  assert.deepEqual(roll.entries().map((e) => e.title), ["Recent"]);
  assert.deepEqual(roll.store.entries({ includeArchived: true }).map((e) => e.title).sort(), ["Old news", "Recent"]);
  assert.ok(exists(roll, ".gitroll/logs/2026/01.md"));
  // A direct link to an archived entry still resolves.
  const archived = roll.store.entries({ includeArchived: true }).find((e) => e.title === "Old news")!;
  assert.equal(roll.store.find(archived.id)?.title, "Old news");

  roll.store.unarchive("2026-01");
  assert.equal(roll.entries().length, 2);
});

test("compression is transparent to reading, editing and identity", () => {
  const roll = newRoll();
  const e = roll.addEntry({ text: "Compressed entry", date: "2026-02-10" });
  roll.store.archive("2026-02", { compress: true });
  assert.ok(exists(roll, ".gitroll/logs/2026/02.md.gz"));
  assert.ok(!exists(roll, ".gitroll/logs/2026/02.md"));
  // Never two authoritative copies.
  const found = roll.store.find(e.id)!;
  assert.equal(found.title, "Compressed entry");
  assert.equal(found.filed, "2026-02-10");

  const edited = roll.store.update(e.id, `---\ndate: 2026-02-10\nfiled: 2026-02-10\n---\n\n# Compressed entry\n\nnow with more text\n`);
  assert.equal(edited.id, e.id);
  assert.equal(edited.path, ".gitroll/logs/2026/02.md.gz");
  assert.match(gunzipText(fs.readFileSync(path.join(roll.root, ".gitroll/logs/2026/02.md.gz"))), /more text/);

  roll.store.unarchive("2026-02");
  assert.ok(exists(roll, ".gitroll/logs/2026/02.md"));
  assert.ok(!exists(roll, ".gitroll/logs/2026/02.md.gz"));
});

test("gzip output is deterministic, so re-archiving isn't a diff", () => {
  assert.deepEqual(gzipDeterministic("hello\n"), gzipDeterministic("hello\n"));
  assert.equal(gunzipText(gzipDeterministic("hello\n")), "hello\n");
});

test("a late entry joins its archived period and stays reachable", () => {
  const roll = newRoll();
  roll.addEntry({ text: "March", date: "2026-03-01" });
  roll.store.archive("2026-03", { compress: true });
  const late = roll.store.put([{ content: "# Forgot this one\n", date: "2026-03-15" }]).entries[0];
  // It inherits the period's policy: same file, still compressed, still archived.
  assert.equal(late.path, ".gitroll/logs/2026/03.md.gz");
  assert.equal(late.archived, true);
  assert.equal(roll.store.find(late.id)?.title, "Forgot this one");
});

test("manual unarchiving overrides automatic archival until it's restored", () => {
  const roll = newRoll();
  roll.setStorage({ ...roll.store.settings(), archive: { afterDays: 30, compress: false } });
  roll.addEntry({ text: "Long ago", date: "2026-01-05" });
  const now = new Date("2026-09-16T00:00:00Z");
  assert.deepEqual(roll.store.dueForArchive(now), ["2026-01"]);
  roll.store.archive("2026-01");
  assert.deepEqual(roll.store.dueForArchive(now), []);
  roll.store.unarchive("2026-01");
  assert.deepEqual(roll.store.dueForArchive(now), [], "a period reopened by hand is left alone");
  roll.store.restoreAuto("2026-01");
  assert.deepEqual(roll.store.dueForArchive(now), ["2026-01"]);
});

test("a period is only due once the whole period is over", () => {
  const roll = newRoll();
  roll.setStorage({ ...roll.store.settings(), archive: { afterDays: 10, compress: false } });
  roll.addEntry({ text: "Early September", date: "2026-09-01" });
  assert.deepEqual(roll.store.dueForArchive(new Date("2026-09-20T00:00:00Z")), []);
  assert.deepEqual(roll.store.dueForArchive(new Date("2026-10-12T06:00:00Z")), ["2026-09"]);
});

test("a corrupt archive is isolated and reported; the rest of the Roll still reads", () => {
  const roll = newRoll();
  roll.addEntry({ text: "Good", date: "2026-09-01" });
  roll.addEntry({ text: "Also good", date: "2026-08-01" });
  roll.store.archive("2026-08", { compress: true });
  const broken = path.join(roll.root, ".gitroll/logs/2026/08.md.gz");
  fs.writeFileSync(broken, Buffer.from("not gzip at all"));
  roll.store.index.reset();
  const { entries, problems } = roll.load();
  assert.deepEqual(entries.map((e) => e.title), ["Good"]);
  assert.equal(problems.length, 1);
  assert.match(problems[0].path, /08\.md\.gz$/);
  // The original bytes are left exactly as they are.
  assert.equal(fs.readFileSync(broken, "utf8"), "not gzip at all");
});

test("an interrupted compression leaves one readable copy and the next run tidies up", () => {
  const roll = newRoll();
  const e = roll.addEntry({ text: "Survivor", date: "2026-04-01" });
  // A crash mid-write leaves a temporary beside the file; the file is untouched.
  fs.writeFileSync(path.join(roll.root, ".gitroll/logs/2026/04.md.gz.gitroll-tmp"), "half a file");
  roll.store.index.reset();
  assert.equal(roll.store.find(e.id)?.title, "Survivor");
  assert.ok(!exists(roll, ".gitroll/logs/2026/04.md.gz.gitroll-tmp"), "the temporary is swept");
});

test("the index rebuilds from the files, and notices edits made outside GitRoll", () => {
  const roll = newRoll();
  const e = roll.addEntry({ text: "Indexed", date: "2026-09-02" });
  const file = path.join(roll.root, ".gitroll/logs/2026/09.md");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("# Indexed", "# Edited by hand"));
  assert.equal(roll.entry(e.id).title, "Edited by hand");

  fs.rmSync(roll.store.index.file, { force: true });
  const fresh = new EntryStore(roll.root);
  assert.equal(fresh.find(e.id)?.title, "Edited by hand");
  assert.equal(fresh.index.incomplete, false);
});

test("two entries claiming one id are reported, never combined", () => {
  const roll = newRoll();
  const e = roll.addEntry({ text: "Original", date: "2026-09-02" });
  fs.mkdirSync(path.join(roll.root, ".gitroll/logs/2025"), { recursive: true });
  fs.writeFileSync(path.join(roll.root, ".gitroll/logs/2025/12.md"), `<!-- gitroll:entry ${e.id} -->\n---\nfiled: 2025-12-01\n---\n\n# Impostor\n`);
  roll.store.index.reset();
  const problems = roll.load().problems;
  assert.equal(problems.length, 1);
  assert.match(problems[0].error, /two entries claim this id/);
  assert.equal(roll.store.index.incomplete, true);
});

test("pagination never claims to be more than it is", () => {
  const roll = newRoll();
  for (let i = 0; i < 5; i++) roll.addEntry({ text: `Entry ${i}`, date: `2026-09-0${i + 1}` });
  roll.addEntry({ text: "Archived one", date: "2026-08-01" });
  roll.store.archive("2026-08");
  const page = roll.store.page({ offset: 1, limit: 2 });
  assert.equal(page.entries.length, 2);
  assert.equal(page.total, 5);
  assert.equal(page.incomplete, false);
  assert.equal(roll.store.page({ includeArchived: true }).total, 6);
});

test("usage counts attachments apart from entries", () => {
  const roll = newRoll();
  roll.save({ text: "With a receipt", date: "2026-09-01" }, [{ name: "receipt.pdf", data: Buffer.alloc(4096, 1) }]);
  const usage = roll.store.usage();
  assert.ok(usage.attachmentBytes >= 4096);
  assert.ok(usage.segmentBytes > 0 && usage.segmentBytes < 4096);
  assert.equal(usage.entries, 1);
});

// ── Migration ──────────────────────────────────────────────────────────────

test("migration previews before it rewrites, and keeps dates as written", () => {
  const roll = newRoll("event");
  roll.addEntry({ text: "AC serviced", date: "2026-09-15" });
  roll.addEntry({ text: "Filter changed", date: "2026-10-02T09:00:00-05:00" });
  fs.writeFileSync(path.join(roll.root, ".gitroll/events/2026-08-04-by-hand.md"), "# Written by hand\n");
  fs.writeFileSync(path.join(roll.root, ".gitroll/events/undated.md"), "# No date anywhere\n");

  const plan = planMigration(roll.store, "monthly");
  assert.deepEqual(plan.items.map((i) => i.period).sort(), ["2026-08", "2026-09", "2026-10"]);
  // A day in a file name is a day, not midnight UTC.
  assert.equal(plan.items.find((i) => i.from.includes("by-hand"))!.filed, "2026-08-04");
  assert.equal(plan.skipped.length, 1);
  assert.match(plan.skipped[0].reason, /undated/);
  assert.ok(fs.existsSync(path.join(roll.root, ".gitroll/events/2026-08-04-by-hand.md")), "a preview writes nothing");

  roll.setStorage({ ...roll.store.settings(), mode: "monthly" });
  const result = applyMigration(roll.store, plan);
  assert.equal(result.moved, 3);
  assert.ok(exists(roll, ".gitroll/logs/2026/08.md"));
  assert.ok(!exists(roll, ".gitroll/events/2026-08-04-by-hand.md"));
  assert.ok(exists(roll, ".gitroll/events/undated.md"), "what couldn't be placed stays where it was");
  // A link written before the migration still finds its entry.
  const moved = fs.readFileSync(path.join(roll.root, MOVED_PATH), "utf8");
  assert.match(moved, /2026-08-04-by-hand\.md": [0-9A-HJKMNP-TV-Z]{26}/);
  assert.equal(roll.store.find(".gitroll/events/2026-08-04-by-hand.md")?.title, "Written by hand");
});

test("migration is safe to interrupt and run again", () => {
  const roll = newRoll("event");
  roll.addEntry({ text: "One", date: "2026-05-01" });
  roll.addEntry({ text: "Two", date: "2026-06-01" });
  roll.setStorage({ ...roll.store.settings(), mode: "monthly" });

  const first = planMigration(roll.store, "monthly");
  applyMigration(roll.store, { ...first, items: first.items.slice(0, 1) });
  const second = planMigration(roll.store, "monthly");
  assert.equal(second.items.length, 1, "only what's left is still to do");
  applyMigration(roll.store, second);
  assert.deepEqual(roll.entries().map((e) => e.title).sort(), ["One", "Two"]);
  // Running it once more does nothing at all.
  assert.equal(planMigration(roll.store, "monthly").items.length, 0);
});

test("ids survive migration, so the same repository migrates the same way twice", () => {
  const make = () => {
    const roll = newRoll("event");
    fs.writeFileSync(path.join(roll.root, ".gitroll/events/2026-05-01-x.md"), "# Same\n");
    return planMigration(roll.store, "monthly").items[0].id;
  };
  assert.equal(make(), make());
});
