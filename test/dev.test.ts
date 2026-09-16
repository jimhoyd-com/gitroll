// What a developer's Roll needs: references to code, templates for the kinds of
// event they write often, links between events, putting an earlier version
// back, and settling an event that was changed in two places.
import "./helpers.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { parseEntry } from "../src/core/entry.ts";
import { codeRefs, repoName, repoUrl, sourceRef } from "../src/core/code.ts";
import { related } from "../src/core/relations.ts";
import { TEMPLATES, findTemplate, renderTemplate } from "../src/core/templates.ts";
import { GitRoll } from "../src/node/repo.ts";
import { mergeEntry, splitConflict } from "../src/node/merge.ts";
import { git, tmp } from "./helpers.ts";

const event = (body: string, name = "2026-09-15-note.md") => parseEntry(`.gitroll/events/${name}`, body);

test("commits, pull requests and issues are recognized as they are written", () => {
  const e = event(`---
source:
  repo: acme/app
  branch: fix/checkout
  commit: 9f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f60718293
---

# Checkout times out

Caused by the index dropped in 9f1c2d3, fixed in #412. Related: other/lib#88 and
https://github.com/acme/app/pull/415. Not this one: \`#999\` or <!-- #1000 -->.
`);

  const source = sourceRef(e)!;
  assert.equal(source.repo, "acme/app");
  assert.equal(source.branch, "fix/checkout", "the branch the work happened on");
  assert.equal(source.commit, "9f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f60718293");

  const refs = codeRefs(e);
  assert.deepEqual(
    refs.map((r) => [r.kind, r.text]),
    [
      ["commit", "9f1c2d3e4a5b"],
      // A bare number is a pull request or an issue; GitHub numbers them together.
      ["ref", "#412"],
      ["ref", "other/lib#88"],
      ["pr", "acme/app#415"],
    ],
  );
  // A number belongs to the repository the event names, so the link goes to the right one.
  assert.equal(refs[1].url, "https://github.com/acme/app/issues/412");
  assert.equal(refs[2].url, "https://github.com/other/lib/issues/88");
  assert.equal(refs[0].url, "https://github.com/acme/app/commit/9f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f60718293");
  assert.ok(!refs.some((r) => r.id === "999" || r.id === "1000"), "code spans and comments aren't references");
});

test("a number with no repository anywhere is shown, but never linked to a guess", () => {
  const refs = codeRefs(event("# Fixed\n\nClosed #412.\n"));
  assert.deepEqual(refs.map((r) => [r.text, r.url]), [["#412", undefined]]);
});

test("repository addresses in any shape give the same repository", () => {
  for (const source of ["git@github.com:acme/app.git", "https://github.com/acme/app", "https://github.com/acme/app.git", "acme/app"]) {
    assert.equal(repoName(source), "acme/app", source);
    assert.equal(repoUrl(source), "https://github.com/acme/app", source);
  }
  assert.equal(repoName("/home/me/not-hosted"), null);
});

test("templates are ordinary Markdown, and what they produce is an ordinary event", () => {
  assert.deepEqual(TEMPLATES.map((t) => t.id), ["debugging", "incident", "deployment", "experiment", "decision"]);
  assert.equal(findTemplate("adr")?.id, "decision", "an ADR is the decision template");
  assert.equal(findTemplate("nope"), null);

  const text = renderTemplate(findTemplate("incident")!, "Checkout timeouts");
  assert.match(text, /^# Checkout timeouts/);
  assert.match(text, /## Impact[\s\S]*## Follow-up/);
  assert.ok(!text.includes("{{title}}"));

  const repo = GitRoll.init(tmp());
  const entry = repo.addEntry({ text, tags: findTemplate("incident")!.tags, date: "2026-09-15" });
  assert.equal(entry.path, ".gitroll/events/2026-09-15-checkout-timeouts.md");
  assert.equal(entry.title, "Checkout timeouts");
  assert.deepEqual(entry.tags, ["incident"]);
  assert.equal((entry.body.match(/^# /gm) ?? []).length, 1, "the template's heading isn't repeated");
});

test("--code records the repository, branch and commit the work was on", () => {
  const project = tmp();
  git(project, "init", "-q", "-b", "trunk");
  fs.writeFileSync(path.join(project, "app.ts"), "export const x = 1;\n");
  git(project, "add", "-A");
  git(project, "commit", "-qm", "first");
  git(project, "remote", "add", "origin", "git@github.com:acme/app.git");
  git(project, "switch", "-qc", "fix/checkout");

  const repo = GitRoll.init(project, { name: "Project log" });
  const source = repo.sourceNow(project)!;
  assert.equal(source.repo, "acme/app");
  assert.equal(source.branch, "fix/checkout");
  assert.match(String(source.commit), /^[0-9a-f]{40}$/);

  const entry = repo.addEntry({ text: "Chose a partial index", date: "2026-09-15", source });
  const onDisk = parseEntry(entry.path, fs.readFileSync(path.join(repo.root, entry.path), "utf8"));
  assert.equal(sourceRef(onDisk)?.branch, "fix/checkout");
  // The Roll's own branch is the same repository here, and is reported separately.
  assert.equal(repo.status().branch, "fix/checkout");
  assert.equal(repo.status().repo, "acme/app");
  assert.deepEqual(repo.check(), []);
});

test("the Roll's branch is reported, including detached HEAD and before the first commit", () => {
  const dir = tmp();
  git(dir, "init", "-q", "-b", "main");
  fs.mkdirSync(path.join(dir, ".gitroll/events"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".gitroll/config.yaml"), "template_version: 1\n");
  const repo = new GitRoll(dir);

  const empty = repo.status();
  assert.equal(empty.hasCommits, false);
  assert.equal(empty.head, null);
  assert.equal(empty.blocker, null, "a repository with no commits is still on a branch");

  repo.addEntry({ text: "First thing", date: "2026-09-15" });
  const onBranch = repo.status();
  assert.equal(onBranch.branch, "main");
  assert.equal(onBranch.blocker, null);
  assert.match(String(onBranch.head), /^[0-9a-f]{7,}$/);

  git(dir, "checkout", "-q", "--detach", "HEAD");
  const detached = repo.status();
  assert.equal(detached.blocker, "detached");
  assert.equal(detached.branch, "", "there is no branch to name, and GitRoll doesn't invent one");
  // Writing still works; it is syncing that has nowhere to go.
  repo.addEntry({ text: "Logged while detached", date: "2026-09-15" });
  assert.equal(repo.entries().length, 2);

  // A branch switched in another terminal shows up the next time status is read.
  git(dir, "checkout", "-q", "-B", "experiment");
  assert.equal(repo.status().branch, "experiment");
});

test("events link to each other with ordinary Markdown links, both ways", () => {
  const repo = GitRoll.init(tmp());
  const incident = repo.addEntry({ text: "# Checkout timeouts\n\nThe index was dropped.", date: "2026-09-14" });
  const fix = repo.addEntry({
    text: `# Added the index back\n\nFollows [the incident](${incident.path.split("/").pop()}). Also see [nothing.md](nothing.md).`,
    date: "2026-09-15",
  });

  const all = repo.entries();
  const fromFix = related(all.find((e) => e.path === fix.path)!, all);
  assert.deepEqual(fromFix.links.map((e) => e.path), [incident.path]);
  assert.deepEqual(fromFix.missing, [".gitroll/events/nothing.md"], "a link to an event that isn't here is reported, not hidden");

  const fromIncident = related(all.find((e) => e.path === incident.path)!, all);
  assert.deepEqual(fromIncident.backlinks.map((e) => e.path), [fix.path], "backlinks are the same links, read the other way");
  assert.deepEqual(fromIncident.links, []);
});

test("an earlier version can be put back, as a new commit", () => {
  const repo = GitRoll.init(tmp());
  const first = repo.addEntry({ text: "# Deploy\n\nWent out at 14:00.", date: "2026-09-15" });
  repo.updateEntry(first.path, { text: "# Deploy\n\nWent out at 14:00. Rolled back at 14:20." });
  const versions = repo.history(first.path);
  assert.equal(versions.length, 2);

  const { entry, from, unchanged } = repo.restoreVersion(first.path, versions[1].commit);
  assert.equal(unchanged, false);
  assert.equal(from, versions[1].commit.slice(0, 12));
  assert.match(entry.body, /Went out at 14:00\.$/);
  assert.equal(repo.history(first.path).length, 3, "restoring adds a version, it never removes one");
  assert.match(repo.history(first.path)[0].subject, /^restore: /);
  assert.match(git(repo.root, "show", `HEAD~1:${first.path}`), /Rolled back/, "the version restored away is still in history");

  // Restoring the same version twice changes nothing, and says so.
  assert.equal(repo.restoreVersion(first.path, versions[1].commit).unchanged, true);
  assert.throws(() => repo.restoreVersion(first.path, "0000000"), /no commit/i);
});

test("an earlier version survives a rename, and a move isn't a version", () => {
  const repo = GitRoll.init(tmp());
  const first = repo.addEntry({ text: "# Deploy\n\nWent out at 14:00.", date: "2026-09-15" });
  repo.updateEntry(first.path, { text: "# Deploy\n\nWent out at 14:00. Rolled back." });
  const moved = repo.moveEntry(first.path, ".gitroll/events/releases/2026-09-15-deploy.md");

  // The newest commit that said something different — not the move, which said the same thing.
  const previous = repo.previousVersion(moved.path)!;
  const { entry } = repo.restoreVersion(moved.path, previous);
  assert.match(entry.body, /Went out at 14:00\.$/, "a version from before the rename comes back");
  assert.equal(entry.path, moved.path, "it comes back under the name it has now");
  assert.deepEqual(repo.check(), []);
});

test("an event changed in two places is settled by a person, and both versions stay", () => {
  const repo = GitRoll.init(tmp());
  const entry = repo.addEntry({ text: "# Paid the contractor\n\nPaid $1,850.", date: "2026-09-15" });
  const file = path.join(repo.root, entry.path);
  const mine = fs.readFileSync(file, "utf8");
  const merged = mergeEntry(mine.replace("$1,850", "$1,000"), mine, mine.replace("$1,850", "$1,500"));
  assert.equal(merged.conflicted, true);
  fs.writeFileSync(file, merged.text);
  git(repo.root, "commit", "-qam", "as a sync would leave it");

  const [conflict] = repo.conflicts();
  assert.equal(conflict.entry.path, entry.path);
  assert.match(conflict.mine, /\$1,850/);
  assert.match(conflict.theirs, /\$1,500/);
  assert.equal(splitConflict("# No conflict here\n"), null);

  const resolved = repo.resolveConflict(entry.path, "theirs");
  assert.match(resolved.body, /\$1,500/);
  assert.ok(!resolved.body.includes("Sync note"), "the note goes with the conflict");
  assert.ok(!resolved.tags.includes("conflict"));
  assert.equal(repo.conflicts().length, 0);
  assert.match(git(repo.root, "show", `HEAD~1:${entry.path}`), /\$1,850/, "the version not chosen is still in history");

  // And a version written out of both is just as acceptable.
  const other = repo.addEntry({ text: "# Another one\n\nMine.", date: "2026-09-16" });
  const otherFile = path.join(repo.root, other.path);
  fs.writeFileSync(otherFile, mergeEntry("# Another one\n\nBase.\n", fs.readFileSync(otherFile, "utf8"), "# Another one\n\nTheirs.\n").text);
  git(repo.root, "commit", "-qam", "another conflict");
  const combined = repo.resolveConflict(other.path, { text: "# Another one\n\nMine and theirs, together." });
  assert.match(combined.body, /Mine and theirs, together/);
  assert.deepEqual(repo.check(), []);
});
