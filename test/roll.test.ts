import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { parseEntry } from "../src/core/entry.ts";
import { GitRoll, displayRemote, findGitRoot, findRepoRoot } from "../src/node/repo.ts";
import { git, tmp } from "./helpers.ts";

const pdf = Buffer.from("%PDF-1.4 receipt for $1,850");

test("init creates a readable Roll with no GitHub Actions", () => {
  const repo = GitRoll.init(path.join(tmp(), "My Roll"), { name: "My Roll" });
  assert.equal(repo.config().name, "My Roll");
  assert.equal(repo.config().templateVersion, 1);
  assert.ok(!fs.existsSync(path.join(repo.root, ".github")), "the Roll template must not include workflows");
  assert.ok(fs.existsSync(path.join(repo.root, ".gitroll/README.md")), "the log explains itself");
  assert.equal(git(repo.root, "status", "--porcelain"), "");
  assert.match(git(repo.root, "log", "--format=%s"), /gitroll: add a log/);
  assert.deepEqual(repo.check(), []);
  assert.throws(() => GitRoll.init(repo.root), /already a log/);
});

test("saving an event writes readable Markdown, stores the file and commits both", () => {
  const repo = GitRoll.init(tmp());
  const e = repo.addEntry(
    { text: "Carlos completed the shower tile. #tile", date: "2026-09-15", tags: ["Bathroom Remodel"], amount: { value: 1850, currency: "USD" } },
    [{ name: "receipt.pdf", type: "application/pdf", data: pdf }],
  );

  assert.equal(e.path, ".gitroll/events/2026-09-15-carlos-completed-the-shower-tile-tile.md");
  const onDisk = parseEntry(e.path, fs.readFileSync(path.join(repo.root, e.path), "utf8"));
  assert.equal(onDisk.title, "Carlos completed the shower tile. #tile");
  assert.deepEqual(onDisk.tags, ["bathroom-remodel", "tile"]);
  assert.deepEqual(onDisk.amount, { value: 1850, currency: "USD" });
  assert.equal(onDisk.attachments[0].path, ".gitroll/files/receipt.pdf");

  assert.deepEqual(fs.readFileSync(repo.attachmentFile(".gitroll/files/receipt.pdf")!), pdf);

  assert.equal(git(repo.root, "status", "--porcelain"), "", "everything is committed");
  const committed = git(repo.root, "show", "--name-only", "--format=%s", "HEAD");
  assert.match(committed, /^log: Carlos completed the shower tile/);
  assert.ok(committed.includes(e.path) && committed.includes(".gitroll/files/receipt.pdf"));
  assert.deepEqual(repo.check(), []);
});

test("a file written by hand is an event, with no GitRoll involved", () => {
  const repo = GitRoll.init(tmp());
  fs.mkdirSync(path.join(repo.root, ".gitroll/files"), { recursive: true });
  fs.writeFileSync(path.join(repo.root, ".gitroll/files/ac-receipt.pdf"), pdf);
  fs.writeFileSync(
    path.join(repo.root, ".gitroll/events/2026-09-15-ac-serviced.md"),
    "# AC serviced\n\nReplaced the capacitor. Paid $325.\n\n[Receipt](../files/ac-receipt.pdf)\n",
  );

  const [e] = repo.entries();
  assert.equal(e.title, "AC serviced");
  assert.equal(e.date, "2026-09-15");
  assert.equal(e.attachments[0].path, ".gitroll/files/ac-receipt.pdf");
  assert.deepEqual(repo.check(), []);
});

test("reading picks up hand edits and reports broken files without failing", () => {
  const repo = GitRoll.init(tmp());
  const e = repo.addEntry({ text: "AC serviced" });
  const file = path.join(repo.root, e.path);
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("AC serviced", "AC serviced, capacitor replaced"));
  fs.writeFileSync(path.join(repo.root, ".gitroll/events/broken.md"), "---\ndate: [not, a, date]\n---\n\nBroken\n");

  const { entries, problems } = repo.load();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].title, "AC serviced, capacitor replaced");
  assert.equal(problems.length, 1);
  assert.match(problems[0].error, /date/);
});

test("editing rewrites only what changed, and history follows the file", () => {
  const repo = GitRoll.init(tmp());
  const e = repo.addEntry({ text: "Paid contractor $1,850", date: "2026-09-15" });
  fs.writeFileSync(
    path.join(repo.root, e.path),
    `---\nvendor: Carlos   # kept by hand\n---\n\n# Paid contractor $1,850\n\nPaid by check.\n`,
  );

  const edited = repo.updateEntry(e.path, { tags: ["contractor"] });
  const source = fs.readFileSync(path.join(repo.root, e.path), "utf8");
  assert.match(source, /# kept by hand/, "an unknown key and its comment survive editing");
  assert.match(source, /Paid by check\./, "the handwritten body is untouched");
  assert.deepEqual(edited.tags, ["contractor"]);

  const history = repo.history(e.path);
  assert.equal(history[0].subject.startsWith("edit: "), true);

  repo.deleteEntry(e.path);
  assert.equal(repo.entries().length, 0);
  assert.match(git(repo.root, "show", `HEAD~1:${e.path}`), /Paid by check/, "deleted events stay in Git history");
});

test("moving an event keeps its links and its history", () => {
  const repo = GitRoll.init(tmp());
  const e = repo.addEntry({ text: "AC serviced", date: "2026-09-15" }, [{ name: "receipt.pdf", data: pdf }]);
  const moved = repo.moveEntry(e.path, ".gitroll/events/house/2026-09-15-ac-serviced.md");
  assert.equal(moved.path, ".gitroll/events/house/2026-09-15-ac-serviced.md");
  assert.equal(moved.attachments[0].path, ".gitroll/files/receipt.pdf", "the link still resolves");
  assert.ok(repo.history(moved.path).length >= 2, "git follows the rename");
  assert.deepEqual(repo.check(), []);
});

test("an event's history is its own, not a similar event's", () => {
  const repo = GitRoll.init(tmp());
  repo.addEntry({ text: "Something else" });
  const e = repo.addEntry({ text: "Deploy" });
  repo.updateEntry(e.path, { text: "Deploy\n\nRolled back." });

  // Two events are alike — a heading, a line of text, the same front matter
  // keys — and `git log --follow` used to answer that this one was a rename of
  // the other and show its commits here. An event that was only ever added has
  // exactly the history of its own file.
  assert.deepEqual(repo.history(e.path).map((h) => h.subject), ["edit: Deploy", "log: Deploy"]);
});

test("files get readable names and never overwrite each other", () => {
  const repo = GitRoll.init(tmp());
  const a = repo.addEntry({ text: "Receipt" }, [{ name: "AC Receipt.PDF", data: pdf }]);
  const b = repo.addEntry({ text: "Another receipt" }, [{ name: "AC Receipt.PDF", data: Buffer.from("%PDF other") }]);
  assert.equal(a.attachments[0].path, ".gitroll/files/ac-receipt.pdf");
  assert.equal(b.attachments[0].path, ".gitroll/files/ac-receipt-2.pdf");
  assert.deepEqual(fs.readFileSync(repo.attachmentFile(".gitroll/files/ac-receipt.pdf")!), pdf);
  assert.equal(repo.attachmentFile("../../etc/passwd"), null);
});

test("the same bytes under the same name are one file, said once", () => {
  // Attaching a receipt the text already links used to store a second copy and
  // add a second link, so the entry showed the photo twice and counted two
  // attachments. The same file attached to two entries is shared, not copied.
  const repo = GitRoll.init(tmp());
  const byHand = repo.addEntry({ text: "Paid the plumber\n\n[Receipt](../files/ac-receipt.pdf)" }, [{ name: "AC Receipt.PDF", data: pdf }]);
  assert.deepEqual(byHand.attachments.map((a) => a.path), [".gitroll/files/ac-receipt.pdf"]);
  assert.equal(byHand.body.match(/ac-receipt/g)?.length, 1, "the link the author wrote is not repeated");

  const again = repo.addEntry({ text: "Same receipt, another entry" }, [{ name: "AC Receipt.PDF", data: pdf }]);
  assert.deepEqual(again.attachments.map((a) => a.path), [".gitroll/files/ac-receipt.pdf"], "shared, not copied");

  // Editing is the same promise: re-attaching what the body links adds nothing.
  const edited = repo.updateEntry(byHand.id, { text: byHand.body }, [{ name: "AC Receipt.PDF", data: pdf }]);
  assert.deepEqual(edited.attachments.map((a) => a.path), [".gitroll/files/ac-receipt.pdf"]);

  // A different file called the same thing is still a different file.
  const other = repo.addEntry({ text: "A different receipt" }, [{ name: "AC Receipt.PDF", data: Buffer.from("%PDF other") }]);
  assert.deepEqual(other.attachments.map((a) => a.path), [".gitroll/files/ac-receipt-2.pdf"]);
  assert.deepEqual(fs.readFileSync(repo.attachmentFile(".gitroll/files/ac-receipt.pdf")!), pdf, "and the first is untouched");
});

test("two events logged the same day with the same words get different files", () => {
  const repo = GitRoll.init(tmp());
  const a = repo.addEntry({ text: "AC serviced", date: "2026-09-15" });
  const b = repo.addEntry({ text: "AC serviced", date: "2026-09-15" });
  assert.equal(a.path, ".gitroll/events/2026-09-15-ac-serviced.md");
  assert.equal(b.path, ".gitroll/events/2026-09-15-ac-serviced-2.md");
});

test("attachments have a size limit, and nothing is saved when one is rejected", () => {
  const repo = GitRoll.init(tmp());
  fs.appendFileSync(path.join(repo.root, ".gitroll/config.yaml"), "attachments:\n  max_mb: 1\n");
  assert.equal(repo.maxAttachmentBytes(), 1024 * 1024);
  assert.throws(() => repo.addEntry({ text: "Big video" }, [{ name: "big.mov", data: Buffer.alloc(1024 * 1024 + 1) }]), /limit is 1 MB/);
  assert.equal(repo.entries().length, 0);
});

test("an unsupported template version blocks writes and explains why", () => {
  const repo = GitRoll.init(tmp());
  fs.writeFileSync(path.join(repo.root, ".gitroll/config.yaml"), "template_version: 99\n");
  assert.equal(repo.template().code, "unsupported");
  assert.throws(() => repo.addEntry({ text: "Nope" }), /Update GitRoll/);
  assert.equal(repo.entries().length, 0);
});

test("a Roll with no template version is unknown, and is never filled in silently", () => {
  const repo = GitRoll.init(tmp());
  fs.writeFileSync(path.join(repo.root, ".gitroll/config.yaml"), "name: Hand made\n");
  assert.equal(repo.template().code, "unknown");
  repo.addEntry({ text: "Still writable" });
  assert.equal(fs.readFileSync(path.join(repo.root, ".gitroll/config.yaml"), "utf8"), "name: Hand made\n", "logging leaves the marker alone");

  repo.setTemplateVersion(1);
  assert.equal(repo.template().code, "ok");
  assert.match(fs.readFileSync(path.join(repo.root, ".gitroll/config.yaml"), "utf8"), /^template_version: 1$/m);
  assert.throws(() => repo.setTemplateVersion(99), /understands template versions up to 1/);
});

test("adding a log to an existing project touches nothing else", () => {
  const dir = tmp();
  git(dir, "init", "-q", "-b", "main");
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src/app.ts"), "export const hi = 1;\n");
  fs.writeFileSync(path.join(dir, "README.md"), "# My project\n");
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "the project");

  // Work in progress, staged and unstaged: none of it may end up in GitRoll's commit.
  fs.writeFileSync(path.join(dir, "src/app.ts"), "export const hi = 2;\n");
  fs.writeFileSync(path.join(dir, "staged.txt"), "half-finished\n");
  git(dir, "add", "staged.txt");

  const repo = GitRoll.init(dir, { name: "Project log" });
  assert.equal(fs.readFileSync(path.join(dir, "README.md"), "utf8"), "# My project\n", "the project's README is left alone");
  const committed = git(repo.root, "show", "--name-only", "--format=", "HEAD").trim().split("\n");
  assert.ok(committed.every((f) => f.startsWith(".gitroll/")), `GitRoll committed ${committed.join(", ")}`);
  assert.match(git(dir, "status", "--porcelain"), /A {2}staged\.txt/, "the staged file is still only staged");
  assert.match(git(dir, "status", "--porcelain"), /^ M src\/app\.ts$/m, "the unstaged edit is untouched");

  const e = repo.addEntry({ text: "Chose Postgres", date: "2026-09-15" });
  assert.equal(e.path, ".gitroll/events/2026-09-15-chose-postgres.md");
  assert.deepEqual(
    git(repo.root, "show", "--name-only", "--format=", "HEAD").trim().split("\n"),
    [".gitroll/events/2026-09-15-chose-postgres.md"],
  );
});

test("an unrecognized .gitroll folder is never written into", () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, ".gitroll"));
  fs.writeFileSync(path.join(dir, ".gitroll/something-else.json"), "{}\n");
  assert.throws(() => GitRoll.init(dir), /isn't a GitRoll log/);
  assert.deepEqual(fs.readdirSync(path.join(dir, ".gitroll")), ["something-else.json"]);
});

test("a log is found from a subfolder of its repository", () => {
  const repo = GitRoll.init(tmp(), { name: "Project log" });
  const deep = path.join(repo.root, "src/nested");
  fs.mkdirSync(deep, { recursive: true });
  assert.equal(findRepoRoot(deep), repo.root);
  assert.equal(findGitRoot(deep), repo.root);
});

test("an ignore rule over .gitroll is reported: the log has to be committed", () => {
  const repo = GitRoll.init(tmp());
  fs.writeFileSync(path.join(repo.root, ".gitignore"), ".gitroll/\n");
  assert.match(repo.warning() ?? "", /must be committed/);
});

test("remote URLs are shown without credentials", () => {
  assert.equal(displayRemote("git@github.com:you/my-roll.git"), "github.com/you/my-roll");
  assert.equal(displayRemote("https://user:secret@github.com/you/my-roll.git"), "github.com/you/my-roll");
});

test("an event Git didn't recognize as moved isn't offered back as a deleted one", () => {
  const repo = GitRoll.init(tmp(), { name: "Home" });
  const e = repo.addEntry({ text: "AC serviced\n\nReplaced the capacitor." });
  // Rename detection is what usually tells a move from a deletion. It is off
  // here, as it is in repositories that set it, and past diff.renameLimit in a
  // large commit: the move arrives as a delete and an add.
  git(repo.root, "config", "diff.renames", "false");
  repo.moveEntry(e.path, ".gitroll/events/house/2026-09-15-ac-serviced.md");

  assert.deepEqual(repo.deleted(), [], "it moved; it wasn't deleted");

  // Actually deleting it is still a deletion, with the text as it stood.
  const moved = repo.entries()[0];
  repo.deleteEntry(moved.id);
  const gone = repo.deleted();
  assert.equal(gone.length, 1);
  assert.equal(gone[0].entry.title, "AC serviced");
  assert.match(gone[0].source, /Replaced the capacitor\./);
});
