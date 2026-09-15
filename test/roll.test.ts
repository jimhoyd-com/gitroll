import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { parseEntry } from "../src/core/entry.ts";
import { GitRoll, displayRemote } from "../src/node/repo.ts";
import { git, tmp } from "./helpers.ts";

const pdf = Buffer.from("%PDF-1.4 receipt for $1,850");

test("init creates a readable Roll with no GitHub Actions", () => {
  const repo = GitRoll.init(path.join(tmp(), "My Roll"), { name: "My Roll" });
  assert.equal(repo.config().name, "My Roll");
  assert.ok(!fs.existsSync(path.join(repo.root, ".github")), "the Roll template must not include workflows");
  assert.equal(git(repo.root, "status", "--porcelain"), "");
  assert.match(git(repo.root, "log", "--format=%s"), /init: My Roll/);
  assert.deepEqual(repo.check(), []);
  assert.throws(() => GitRoll.init(repo.root), /already a Roll/);
});

test("saving an event writes Markdown, stores the attachment and commits both", () => {
  const repo = GitRoll.init(tmp());
  const e = repo.addEntry(
    { text: "Carlos completed the shower tile. #tile", type: "expense", projects: ["Bathroom Remodel"], amount: { value: 1850, currency: "USD" }, data: { vendor: "Carlos" } },
    [{ name: "receipt.pdf", type: "application/pdf", data: pdf }],
  );

  const file = path.join(repo.root, e.path);
  assert.match(e.path, /^entries\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.md$/);
  const onDisk = parseEntry(fs.readFileSync(file, "utf8"));
  assert.equal(onDisk.body, "Carlos completed the shower tile. #tile");
  assert.equal(onDisk.type, "expense");
  assert.deepEqual(onDisk.tags, ["tile"]);
  assert.deepEqual(onDisk.projects, ["bathroom-remodel"]);
  assert.equal(onDisk.data.vendor, "Carlos");

  const stored = repo.attachmentFile(onDisk.attachments[0].hash)!;
  assert.deepEqual(fs.readFileSync(stored), pdf);
  assert.equal(repo.projects()[0].name, "Bathroom Remodel");

  assert.equal(git(repo.root, "status", "--porcelain"), "", "everything is committed");
  const committed = git(repo.root, "show", "--name-only", "--format=%s", "HEAD");
  assert.match(committed, /^log\(expense\): Carlos completed the shower tile/);
  assert.ok(committed.includes(e.path) && committed.includes(path.relative(repo.root, stored)) && committed.includes("projects/bathroom-remodel.yaml"));
  assert.deepEqual(repo.check(), []);
});

test("reading picks up hand edits and reports broken files without failing", () => {
  const repo = GitRoll.init(tmp());
  const e = repo.addEntry({ text: "AC serviced" });
  const file = path.join(repo.root, e.path);
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("AC serviced", "AC serviced, capacitor replaced"));
  fs.mkdirSync(path.join(repo.root, "entries/2020/01"), { recursive: true });
  fs.writeFileSync(path.join(repo.root, "entries/2020/01/broken.md"), "not an event");

  const { entries, problems } = repo.load();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].body, "AC serviced, capacitor replaced");
  assert.equal(problems.length, 1);
  assert.match(problems[0].error, /front matter/);
});

test("editing keeps history, and attachments can be added and removed", () => {
  const repo = GitRoll.init(tmp());
  const e = repo.addEntry({ text: "Paid contractor $1,850" }, [{ name: "photo.jpg", type: "image/jpeg", data: Buffer.from("jpeg-1") }]);
  const edited = repo.updateEntry(e.id.slice(-8), {
    text: "Paid contractor $1,500",
    removeAttachments: [e.attachments[0].hash],
  }, [{ name: "receipt.pdf", type: "application/pdf", data: pdf }]);

  assert.equal(edited.id, e.id);
  assert.equal(edited.path, e.path);
  assert.deepEqual(edited.attachments.map((a) => a.name), ["receipt.pdf"]);
  assert.equal(repo.entry(e.id).body, "Paid contractor $1,500");

  const history = repo.history(e.id);
  assert.equal(history.length, 2);
  assert.match(history[0].subject, /^edit: /);
  assert.match(history[0].patch, /-Paid contractor \$1,850/);
  assert.match(history[0].patch, /\+Paid contractor \$1,500/);

  repo.deleteEntry(e.id);
  assert.equal(repo.entries().length, 0);
  assert.match(git(repo.root, "show", `HEAD~1:${e.path}`), /\$1,500/, "deleted events stay in Git history");
});

test("attachments: size limit, deduplication, integrity checks", () => {
  const repo = GitRoll.init(tmp());
  fs.appendFileSync(path.join(repo.root, ".gitroll/config.yaml"), "attachments:\n  max_mb: 1\n");
  assert.equal(repo.maxAttachmentBytes(), 1024 * 1024);
  assert.throws(() => repo.addEntry({ text: "Big video" }, [{ name: "big.mov", data: Buffer.alloc(1024 * 1024 + 1) }]), /limit is 1 MB/);
  assert.equal(repo.entries().length, 0, "nothing is saved when an attachment is rejected");

  const a = repo.addEntry({ text: "Receipt" }, [{ name: "r.pdf", data: pdf }]);
  const b = repo.addEntry({ text: "Same receipt again" }, [{ name: "copy.pdf", data: pdf }]);
  assert.equal(a.attachments[0].hash, b.attachments[0].hash);
  assert.equal(fs.readdirSync(path.join(repo.root, "attachments")).filter((f) => f !== ".gitkeep").length, 1);

  fs.writeFileSync(repo.attachmentFile(a.attachments[0].hash)!, "tampered");
  assert.ok(repo.check().some((p) => p.error.includes("does not match its SHA-256")));
  assert.equal(repo.attachmentFile("../../etc/passwd"), null);
});

test("remote URLs are shown without credentials", () => {
  assert.equal(displayRemote("git@github.com:you/my-roll.git"), "github.com/you/my-roll");
  assert.equal(displayRemote("https://user:secret@github.com/you/my-roll.git"), "github.com/you/my-roll");
});
