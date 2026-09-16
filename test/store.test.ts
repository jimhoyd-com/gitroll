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
import { git, tmp } from "./helpers.ts";

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
  // The date somebody chose rides in the entry's own marker, where GitHub
  // renders it as nothing; the file reads as prose.
  assert.match(read(roll, ".gitroll/logs/2026/09.md"), /<!-- gitroll:entry [0-9A-HJKMNP-TV-Z]{26} 2026-10-01T02:00:00Z -->/);
  assert.match(read(roll, ".gitroll/logs/2026/09.md"), /# AC serviced/);
  assert.doesNotMatch(read(roll, ".gitroll/logs/2026/09.md"), /^---$/m, "no front matter for an entry that needs none");
  // When it was written down isn't stored: Git knows, and the id makes it findable.
  assert.doesNotMatch(read(roll, ".gitroll/logs/2026/09.md"), /^created:/m);
  assert.match(roll.createdAt(a.id)!, /^\d{4}-\d{2}-\d{2}T/);
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

test("a daily Roll doesn't write a filing date its path already states", () => {
  const roll = newRoll("daily");
  const e = roll.addEntry({ text: "Shift handover", date: "2026-09-16T09:00:00-05:00" });
  const file = read(roll, ".gitroll/logs/2026/09/16.md");
  assert.doesNotMatch(file, /^filed:/m, "the file is called 16.md; saying it again adds nothing");
  // The time of day is worth keeping, so it rides in the marker.
  assert.match(file, /<!-- gitroll:entry [0-9A-HJKMNP-TV-Z]{26} 2026-09-16T09:00:00-05:00 -->/);
  // …and it still reads back, because the path is the authority there.
  assert.equal(roll.store.find(e.id)?.filed, "2026-09-16");
  assert.equal(roll.entry(e.id).path, ".gitroll/logs/2026/09/16.md");
});

test("a monthly Roll keeps the filing date, because the path only knows the month", () => {
  const roll = newRoll();
  // 02:00 UTC on 1 October is 30 September in Chicago: the day lives nowhere else.
  const e = roll.addEntry({ text: "Late payment", date: "2026-10-01T02:00:00Z" });
  assert.equal(roll.store.find(e.id)?.filed, "2026-09-30");
  assert.equal(roll.store.find(e.id)?.date, "2026-10-01T02:00:00Z");
});

test("a daily entry that moves day takes its file with it and leaves no stale filing date", () => {
  const roll = newRoll("daily");
  const e = roll.addEntry({ text: "Inspection", date: "2026-09-16T09:00:00-05:00" });
  const moved = roll.updateEntry(e.id, { date: "2026-11-02T09:00:00-06:00" });
  assert.equal(moved.id, e.id);
  assert.equal(moved.path, ".gitroll/logs/2026/11/02.md");
  assert.doesNotMatch(read(roll, ".gitroll/logs/2026/11/02.md"), /^filed:/m);
  assert.equal(roll.store.find(e.id)?.filed, "2026-11-02");
});

test("a filing date written by hand still wins over the path", () => {
  const roll = newRoll("daily");
  const e = roll.addEntry({ text: "Odd one", date: "2026-09-16T09:00:00-05:00" });
  const file = path.join(roll.root, ".gitroll/logs/2026/09/16.md");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("# Odd one", "---\nfiled: 2026-09-15\n---\n\n# Odd one"));
  roll.store.index.reset();
  assert.equal(roll.store.find(e.id)?.filed, "2026-09-15", "what an entry says about itself is not overruled");
});

test("when an entry was written down comes from Git, and its history is its own", () => {
  const roll = newRoll();
  const a = roll.addEntry({ text: "First", date: "2026-09-10" });
  const b = roll.addEntry({ text: "Second", date: "2026-09-11" });
  roll.updateEntry(a.id, { text: "First, revised" });

  // Both entries share a file, and each has its own history inside it.
  const historyA = roll.history(a.id);
  assert.equal(historyA.length, 2, "added, then edited");
  assert.match(historyA[0].subject, /edit: First, revised/);
  assert.equal(roll.history(b.id).length, 1);

  // Creation time is the commit that added it, not the file's first commit.
  const created = roll.createdAt(b.id)!;
  assert.match(created, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(new Date(created).getTime() <= Date.now());
});

test("an entry saved but not yet committed has no creation time to claim", () => {
  const roll = newRoll();
  const e = roll.store.put([{ content: "# Uncommitted\n", date: "2026-09-10" }]).entries[0];
  assert.equal(roll.createdAt(e.id), null, "nothing has recorded it yet, so nothing is invented");
});

// A Roll is a logbook first and a GitRoll file second. Somebody can open a
// segment in an editor and write in it, and everything has to keep working.
test("an entry somebody typed, with no marker, is an entry", () => {
  const roll = newRoll();
  roll.addEntry({ text: "Logged through GitRoll" });
  const file = path.join(roll.root, ".gitroll/logs/2026/09.md");
  fs.appendFileSync(file, "\n# Bought a drill\n\nFrom the shop on the corner.\n\n# Called the insurer\n\nClaim 4471.\n");
  roll.store.index.reset();

  const titles = roll.entries().map((e) => e.title).sort();
  assert.deepEqual(titles, ["Bought a drill", "Called the insurer", "Logged through GitRoll"]);
  // Findable and openable straight away, before GitRoll has written anything.
  const drill = roll.entries().find((e) => e.title === "Bought a drill")!;
  assert.match(drill.id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(roll.entry(drill.id).title, "Bought a drill");
});

test("a hand-written entry is dated by the commit that added it", () => {
  const roll = newRoll();
  roll.addEntry({ text: "First" });
  const file = path.join(roll.root, ".gitroll/logs/2026/09.md");
  fs.appendFileSync(file, "\n# Wrote this by hand\n\nIn an editor, like anything else in the repository.\n");
  git(roll.root, "add", "-A");
  git(roll.root, "commit", "-qm", "My own commit");
  roll.store.index.reset();

  const byHand = roll.entries().find((e) => e.title === "Wrote this by hand")!;
  assert.equal(byHand.dateFrom, "commit");
  assert.match(byHand.date!, /^\d{4}-\d{2}-\d{2}T/);
});

test("writing to a file is no reason to mark up what else is in it", () => {
  const roll = newRoll();
  roll.addEntry({ text: "First" });
  const file = path.join(roll.root, ".gitroll/logs/2026/09.md");
  fs.appendFileSync(file, "\n# Typed by hand\n\nWords, spacing and order are mine.\n");
  roll.store.index.reset();

  roll.addEntry({ text: "Second, through GitRoll" });
  const after = read(roll, ".gitroll/logs/2026/09.md");
  assert.equal((after.match(/gitroll:entry/g) ?? []).length, 2, "only GitRoll's own two entries carry markers");
  assert.match(after, /# Typed by hand\n\nWords, spacing and order are mine\./);
  assert.equal(roll.entries().length, 3);
});

test("an entry gets its marker when it is the one being acted on", () => {
  const roll = newRoll();
  roll.addEntry({ text: "First" });
  const file = path.join(roll.root, ".gitroll/logs/2026/09.md");
  fs.appendFileSync(file, "\n# Typed by hand\n\nMine.\n\n# Also mine\n\nUntouched.\n");
  roll.store.index.reset();

  const byHand = roll.entries().find((e) => e.title === "Typed by hand")!;
  const edited = roll.updateEntry(byHand.id, { text: "# Typed by hand\n\nMine, revised." });
  assert.equal(edited.id, byHand.id, "adopting an entry doesn't rename it, so links to it still work");
  const after = read(roll, ".gitroll/logs/2026/09.md");
  assert.match(after, new RegExp(`<!-- gitroll:entry ${byHand.id} -->`));
  assert.match(after, /# Also mine\n\nUntouched\./);
  assert.equal((after.match(/gitroll:entry/g) ?? []).length, 2, "the other hand-written entry is still untouched");
});

test("ids can be given to every hand-written entry at once, when asked", () => {
  const roll = newRoll();
  const file = path.join(roll.root, ".gitroll/logs/2026/09.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "# One\n\nFirst.\n\n# Two\n\nSecond.\n");
  roll.store.index.reset();
  assert.equal(roll.store.unmarkedCount(), 2);
  const ids = roll.entries().map((e) => e.id).sort();

  const result = roll.store.adoptAll();
  assert.equal(result.adopted, 2);
  assert.equal(roll.store.unmarkedCount(), 0);
  // The ids they already had are the ids they keep.
  assert.deepEqual(roll.entries().map((e) => e.id).sort(), ids);
  assert.match(read(roll, ".gitroll/logs/2026/09.md"), /# One\n\nFirst\./);
});

test("GitRoll's own header is not a heading, so it is never read as an entry", () => {
  const roll = newRoll();
  roll.addEntry({ text: "Only entry" });
  const file = read(roll, ".gitroll/logs/2026/09.md");
  assert.match(file, /^<!-- gitroll:log 2026-09 -->$/m);
  assert.doesNotMatch(file.split("<!-- gitroll:entry")[0], /^#\s/m);
  assert.equal(roll.entries().length, 1);
});

test("what somebody wrote comes back exactly as they wrote it", () => {
  const roll = newRoll();
  roll.addEntry({ text: "Through GitRoll" });
  const file = path.join(roll.root, ".gitroll/logs/2026/09.md");
  // Their spacing: blank lines where they wanted them, trailing spaces, an
  // indented list, no marker. None of it is GitRoll's to tidy.
  const written = "# Bought a drill\n\n\nFrom   the shop.   \nA note:\n    - a  spaced list   \n\n\n";
  fs.appendFileSync(file, `\n${written}`);
  roll.store.index.reset();

  roll.addEntry({ text: "Another, through GitRoll" });
  const after = read(roll, ".gitroll/logs/2026/09.md");
  assert.ok(after.includes(written), "the hand-written entry is byte for byte what it was");
  // …and no marker was inserted above it either: GitRoll wrote elsewhere in
  // the file, which is no reason to mark up somebody else's entry.
  assert.doesNotMatch(after.slice(0, after.indexOf(written)).trimEnd().split("\n").pop()!, /gitroll:entry/);
});

test("editing one entry leaves every other byte in the file alone", () => {
  const roll = newRoll();
  const a = roll.addEntry({ text: "First" });
  roll.addEntry({ text: "Second" });
  const file = path.join(roll.root, ".gitroll/logs/2026/09.md");
  fs.writeFileSync(file, `${fs.readFileSync(file, "utf8")}\n# Theirs,   spaced oddly\n\n\nwith   their own   spacing   \n`);
  roll.store.index.reset();
  const before = read(roll, ".gitroll/logs/2026/09.md");

  roll.updateEntry(a.id, { text: "First, revised" });
  const after = read(roll, ".gitroll/logs/2026/09.md");
  assert.match(after, /First, revised/);
  assert.ok(after.includes("with   their own   spacing   \n"), "their spacing survives an edit to somebody else's entry");
  assert.equal(after.slice(after.indexOf("# Second")), before.slice(before.indexOf("# Second")), "everything after the edited entry is untouched");
});

// Regrouping: the same entries, in files named for days instead of months.
test("a monthly Roll regroups into daily files, keeping ids and dates", () => {
  const roll = newRoll();
  const a = roll.addEntry({ text: "Roof inspected", date: "2026-09-08T14:10:00-05:00" });
  const b = roll.addEntry({ text: "Boiler serviced", date: "2026-09-03" });
  assert.equal(a.path, ".gitroll/logs/2026/09.md");

  const plan = roll.store.planRegroup("daily");
  assert.deepEqual(plan.items.map((i) => i.to).sort(), [".gitroll/logs/2026/09/03.md", ".gitroll/logs/2026/09/08.md"]);
  assert.ok(exists(roll, ".gitroll/logs/2026/09.md"), "a preview writes nothing");

  roll.setStorage({ ...roll.store.settings(), mode: "daily" });
  const result = roll.store.regroup("daily");
  assert.equal(result.moved, 2);
  assert.ok(!exists(roll, ".gitroll/logs/2026/09.md"), "the month file is gone once everything left it");
  // Same ids, same dates, same filing days — only the file's name changed.
  assert.equal(roll.entry(a.id).path, ".gitroll/logs/2026/09/08.md");
  assert.equal(roll.store.find(a.id)?.date, "2026-09-08T14:10:00-05:00");
  assert.equal(roll.store.find(b.id)?.filed, "2026-09-03");
  assert.equal(roll.entries().length, 2);
});

test("an entry dated by its commit isn't re-dated by being moved", () => {
  const roll = newRoll();
  const e = roll.addEntry({ text: "Logged as it happened" });
  const before = roll.store.find(e.id)!.date!;
  assert.match(before, /^\d{4}-\d{2}-\d{2}T/);
  // Its date lives in Git, not in the file — so moving it has to write it down,
  // or the migration commit would become the moment it happened.
  assert.doesNotMatch(read(roll, ".gitroll/logs/2026/09.md"), /gitroll:entry [0-9A-HJKMNP-TV-Z]{26} \d/);

  roll.setStorage({ ...roll.store.settings(), mode: "daily" });
  roll.store.regroup("daily");
  assert.equal(roll.store.find(e.id)?.date, before, "the moment it happened survived the move");
  assert.match(read(roll, `.gitroll/logs/2026/09/${before.slice(8, 10)}.md`), /gitroll:entry [0-9A-HJKMNP-TV-Z]{26} \d{4}-/);
});

test("an archived period is left alone, and says why", () => {
  const roll = newRoll();
  roll.addEntry({ text: "Current", date: "2026-09-10" });
  roll.addEntry({ text: "Old", date: "2026-01-10" });
  roll.store.archive("2026-01", { compress: true });

  const plan = roll.store.planRegroup("daily");
  assert.deepEqual(plan.items.map((i) => i.title), ["Current"]);
  assert.match(plan.skipped[0].reason, /archived — reopen it first: gitroll unarchive 2026-01/);

  roll.setStorage({ ...roll.store.settings(), mode: "daily" });
  roll.store.regroup("daily");
  assert.ok(exists(roll, ".gitroll/logs/2026/01.md.gz"), "somebody's decision to archive it stands");
  assert.ok(exists(roll, ".gitroll/logs/2026/09/10.md"));
});

test("daily regroups back into monthly", () => {
  const roll = newRoll("daily");
  const a = roll.addEntry({ text: "One", date: "2026-09-03" });
  roll.addEntry({ text: "Two", date: "2026-09-08" });
  roll.setStorage({ ...roll.store.settings(), mode: "monthly" });
  const result = roll.store.regroup("monthly");
  assert.equal(result.moved, 2);
  assert.equal(roll.entry(a.id).path, ".gitroll/logs/2026/09.md");
  assert.ok(!exists(roll, ".gitroll/logs/2026/09/03.md"));
  assert.equal(roll.entries().length, 2);
});

test("an attachment link follows its entry to a file at a different depth", () => {
  const roll = newRoll();
  const saved = roll.save({ text: "Bought a filter" }, [{ name: "receipt.pdf", data: Buffer.from("receipt") }]);
  assert.match(read(roll, ".gitroll/logs/2026/09.md"), /\(\.\.\/\.\.\/files\/receipt\.pdf\)/);

  // A day's file sits one folder deeper than a month's, so the link has to change.
  roll.setStorage({ ...roll.store.settings(), mode: "daily" });
  roll.store.regroup("daily");
  const moved = roll.store.find(saved.entry.id)!;
  assert.match(moved.path, /09\/\d{2}\.md$/);
  assert.deepEqual(moved.attachments.map((a) => a.path), [".gitroll/files/receipt.pdf"]);
  assert.equal(roll.check().length, 0, "and nothing is left pointing at a file that isn't there");

  // …and back again.
  roll.setStorage({ ...roll.store.settings(), mode: "monthly" });
  roll.store.regroup("monthly");
  assert.deepEqual(roll.store.find(saved.entry.id)?.attachments.map((a) => a.path), [".gitroll/files/receipt.pdf"]);
  assert.equal(roll.check().length, 0);
});

test("migrating a per-event Roll keeps its attachments attached", () => {
  const roll = newRoll("event");
  const saved = roll.save({ text: "AC serviced", date: "2026-09-15" }, [{ name: "invoice.pdf", data: Buffer.from("invoice") }]);
  assert.match(read(roll, saved.entry.path), /\(\.\.\/files\/invoice\.pdf\)/);

  roll.setStorage({ ...roll.store.settings(), mode: "monthly" });
  applyMigration(roll.store, planMigration(roll.store, "monthly"));
  const moved = roll.entries().find((e) => e.title === "AC serviced")!;
  assert.equal(moved.path, ".gitroll/logs/2026/09.md");
  assert.deepEqual(moved.attachments.map((a) => a.path), [".gitroll/files/invoice.pdf"]);
  assert.equal(roll.check().length, 0);
});

test("check looks inside grouped and archived files, not only per-event ones", () => {
  const roll = newRoll();
  roll.addEntry({ text: "Broken link\n\n[Receipt](../../files/nothing-here.pdf)", date: "2026-09-10" });
  roll.addEntry({ text: "Also broken\n\n[Receipt](../../files/gone.pdf)", date: "2026-01-10" });
  roll.store.archive("2026-01", { compress: true });

  const problems = roll.check();
  assert.equal(problems.length, 2, "an archived, gzipped file is checked like any other");
  assert.ok(problems.some((p) => p.path.endsWith("01.md.gz")));
  assert.ok(problems.every((p) => /isn't in this Roll/.test(p.error)));
});

test("changing an entry's words doesn't change when it happened", () => {
  const roll = newRoll();
  const e = roll.addEntry({ text: "Boiler serviced", date: "2026-09-03" });
  roll.updateEntry(e.id, { text: "Boiler serviced, revised" });
  const after = roll.store.find(e.id)!;
  assert.equal(after.date, "2026-09-03", "the occurrence is untouched by an edit to the text");
  assert.equal(after.filed, "2026-09-03");
  assert.equal(after.path, ".gitroll/logs/2026/09.md");

  // An entry logged as it happened keeps the moment Git gave it, too.
  const now = roll.addEntry({ text: "Logged now" });
  const when = roll.store.find(now.id)!.date;
  roll.updateEntry(now.id, { text: "Logged now, corrected" });
  assert.equal(roll.store.find(now.id)?.date, when);
});

test("an entry in a shared file has no path of its own to be moved to", () => {
  const roll = newRoll();
  const e = roll.addEntry({ text: "Boiler serviced", date: "2026-09-03" });
  const before = read(roll, ".gitroll/logs/2026/09.md");
  assert.throws(() => roll.moveEntry(e.id, ".gitroll/events/moved.md"), /shares .* with other entries/);
  assert.equal(read(roll, ".gitroll/logs/2026/09.md"), before, "and nothing was moved");
  assert.ok(!exists(roll, ".gitroll/events/moved.md"));
});
