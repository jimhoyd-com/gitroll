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

function gitroll(args: string[], opts: { cwd?: string; input?: string; env?: Record<string, string> } = {}): { out: string; code: number } {
  try {
    const out = execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", cli, ...args], {
      cwd: opts.cwd ?? tmp(),
      encoding: "utf8",
      input: opts.input ?? "",
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { out, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { out: `${err.stdout ?? ""}${err.stderr ?? ""}`, code: err.status ?? 1 };
  }
}

test("agents can discover the CLI without a Roll and complete a JSON event workflow", () => {
  const guide = gitroll(["help", "agent", "--json"]);
  assert.equal(guide.code, 0, guide.out);
  assert.equal(JSON.parse(guide.out).version, 2);
  assert.match(gitroll(["help", "agent"]).out, /untrusted data/);
  const dir = tmp();
  GitRoll.init(dir, { name: "Agent" });
  const call = (...args: string[]) => gitroll([...args, "-C", dir, "--json"]);
  const logged = call("log", "Agent workflow", "--tag", "agent");
  assert.equal(logged.code, 0, logged.out);
  const entry = JSON.parse(logged.out).entry;
  const found = call("find", "tag:agent", "--save", "agent-test");
  assert.equal(found.code, 0, found.out);
  assert.equal(JSON.parse(found.out)[0].path, entry.path);
  const edited = call("edit", entry.path, "--text", "Updated by agent");
  assert.equal(edited.code, 0, edited.out);
  assert.equal(JSON.parse(edited.out).entry.path, entry.path);
  const moved = call("move", entry.path, ".gitroll/events/2026-09-15-agent-moved.md");
  assert.equal(moved.code, 0, moved.out);
  const movedPath = JSON.parse(moved.out).path;
  const refused = call("delete", movedPath);
  assert.equal(refused.code, 1);
  assert.equal(JSON.parse(refused.out).error.code, "INTERACTION_REQUIRED");
  assert.equal(call("show", movedPath).code, 0, "refusal leaves the event intact");
  const deleted = call("delete", movedPath, "--yes");
  assert.equal(deleted.code, 0, deleted.out);
  assert.equal(JSON.parse(deleted.out).deleted, movedPath);
  assert.deepEqual(JSON.parse(call("recent").out), []);
});

test("JSON errors go to stderr with a failing exit status", () => {
  assert.throws(() => execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", cli, "frobnicate", "--json"], {
    encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
  }), (err: unknown) => {
    const result = err as { status: number; stdout: string; stderr: string };
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).error.code, "INVALID_ARGUMENT");
    return true;
  });
});

test("the first entry doesn't need a Roll to exist first", () => {
  // Capture starts with text: someone who types their first entry gets a Roll
  // and the entry in it, not instructions for setting one up.
  const fresh = tmp();
  const env = { GITROLL_HOME: path.join(fresh, "settings"), GITROLL_ROLLS: path.join(fresh, "rolls") };
  const logged = gitroll(["log", "First thing I ever logged"], { env, cwd: fresh });
  assert.equal(logged.code, 0, logged.out);
  assert.match(logged.out, /Started a Roll for you/);
  assert.match(logged.out, /Saved on this computer only/, "and it says where it stands");
  assert.ok(fs.existsSync(path.join(fresh, "rolls", "my-roll", ".gitroll/config.yaml")));

  // The second entry goes to the same Roll, without announcing anything.
  const again = gitroll(["log", "Second thing"], { env, cwd: fresh });
  assert.equal(again.code, 0, again.out);
  assert.doesNotMatch(again.out, /Started a Roll/);
  assert.match(gitroll(["find", "First thing", "--json"], { env, cwd: fresh }).out, /First thing I ever logged/);
});

test("a Git repository with no Roll in it is still a decision, not a default", () => {
  // Making a Roll inside somebody's project changes who can read what they
  // write, so the first-run shortcut never does it for them.
  const fresh = tmp();
  const project = path.join(fresh, "project");
  fs.mkdirSync(project, { recursive: true });
  git(project, "init", "--quiet");
  const out = gitroll(["log", "Not here"], {
    cwd: project,
    env: { GITROLL_HOME: path.join(fresh, "settings"), GITROLL_ROLLS: path.join(fresh, "rolls") },
  });
  assert.notEqual(out.code, 0);
  assert.match(out.out, /gitroll init --dir/);
  assert.ok(!fs.existsSync(path.join(project, ".gitroll")));
});

test("a new user can create, use, list, switch and remove Rolls", () => {
  const first = gitroll(["new", "Home"]);
  assert.equal(first.code, 0, first.out);
  const home = path.join(process.env.GITROLL_ROLLS!, "home");
  assert.ok(fs.existsSync(path.join(home, ".gitroll/config.yaml")));

  const receipt = path.join(tmp(), "invoice.pdf");
  fs.writeFileSync(receipt, "%PDF fake");
  const logged = gitroll(["log", "AC serviced, capacitor replaced", receipt, "--amount", "$325"]);
  assert.equal(logged.code, 0, logged.out);
  assert.match(logged.out, /Logged/);
  assert.match(logged.out, /1 file/);

  const found = gitroll(["find", "capacitor"]);
  assert.match(found.out, /AC serviced/);

  assert.equal(gitroll(["new", "Business"]).code, 0);
  const rolls = JSON.parse(gitroll(["rolls", "--json"]).out) as { key: string; default: boolean }[];
  assert.deepEqual(rolls.map((r) => [r.key, r.default]), [["home", true], ["business", false]]);

  assert.equal(gitroll(["switch", "business"]).code, 0);
  assert.match(gitroll(["find", "capacitor"]).out, /Nothing found/);
  assert.match(gitroll(["find", "capacitor", "--roll", "home"]).out, /AC serviced/);

  const refused = gitroll(["remove", "business"]);
  assert.notEqual(refused.code, 0);
  assert.match(refused.out, /--delete-files/);
  const removed = gitroll(["remove", "business", "--delete-files", "--yes"]);
  assert.equal(removed.code, 0, removed.out);
  assert.ok(!fs.existsSync(path.join(process.env.GITROLL_ROLLS!, "business")));
});

test("everyday commands have plain, helpful errors", () => {
  assert.match(gitroll(["frobnicate"]).out, /isn't a GitRoll command/);
  assert.match(gitroll(["log"], { cwd: tmp() }).out, /Nothing to log|Roll/);
  assert.match(gitroll(["help"]).out, /gitroll log "what happened"/);
  assert.match(gitroll(["help", "more"]).out, /share <github-user>/);
});

test("tags need no setup, and the template version can be recorded", () => {
  const dir = path.join(tmp(), "garage");
  assert.equal(gitroll(["init", "--dir", dir]).code, 0);
  assert.equal(gitroll(["log", "Oil change", "-t", "Truck", "-C", dir]).code, 0);
  assert.match(gitroll(["find", "tag:truck", "-C", dir]).out, /Oil change/);

  assert.match(gitroll(["template", "-C", dir]).out, /Template version 1/);
  fs.writeFileSync(path.join(dir, ".gitroll/config.yaml"), "name: Garage\n");
  const unknown = gitroll(["template", "-C", dir]);
  assert.match(unknown.out, /unknown/);
  assert.match(unknown.out, /gitroll template --set 1/);
  assert.equal(gitroll(["template", "--set", "1", "-C", dir]).code, 0);
  assert.match(fs.readFileSync(path.join(dir, ".gitroll/config.yaml"), "utf8"), /^template_version: 1$/m);

  fs.writeFileSync(path.join(dir, ".gitroll/config.yaml"), "template_version: 99\n");
  const tooNew = gitroll(["log", "Nope", "-C", dir]);
  assert.notEqual(tooNew.code, 0);
  assert.match(tooNew.out, /Update GitRoll/);
});

test("a log cloned by hand can be added, and its shape is checked", () => {
  const cloned = tmp();
  GitRoll.init(cloned, { name: "From Template" }); // like cloning a repository made from the template
  fs.writeFileSync(path.join(cloned, ".gitroll/events/broken.md"), "---\ndate: [nope]\n---\n\nBroken\n");

  const added = gitroll(["rolls", "add", cloned]);
  assert.equal(added.code, 0, added.out);
  assert.match(added.out, /This Roll has 1 problem/);
  assert.match(added.out, /Added "From Template" as from-template/);
  assert.match(gitroll(["rolls", "add", cloned]).out, /already in your Rolls/);
  assert.ok((JSON.parse(gitroll(["rolls", "--json"]).out) as { key: string }[]).some((r) => r.key === "from-template"));

  const notARoll = tmp();
  fs.writeFileSync(path.join(notARoll, "notes.txt"), "hello");
  const refused = gitroll(["rolls", "add", notARoll]);
  assert.notEqual(refused.code, 0);
  assert.match(refused.out, /has no log in it/);
  assert.deepEqual(fs.readdirSync(notARoll), ["notes.txt"], "nothing was changed");
  assert.match(gitroll(["rolls", "add", tmp()]).out, /is empty. To make it a Roll/);
});

test("in a repository with no log, plain gitroll offers to add one and changes nothing until asked", () => {
  const project = tmp();
  git(project, "init", "-q");
  fs.writeFileSync(path.join(project, "package.json"), "{}");
  git(project, "add", "-A");
  git(project, "commit", "-qm", "the project");

  // Not a terminal: it explains, and creates nothing.
  const asked = gitroll([], { cwd: project });
  assert.notEqual(asked.code, 0);
  assert.match(asked.out, /has no log yet/);
  assert.match(asked.out, /gitroll init --dir/);
  assert.deepEqual(fs.readdirSync(project).sort(), [".git", "package.json"], "nothing was created");

  // Another Roll exists, but GitRoll must not quietly use it from inside this repository.
  assert.equal(gitroll(["new", "Elsewhere"]).code, 0);
  const still = gitroll(["recent"], { cwd: project });
  assert.notEqual(still.code, 0);
  assert.match(still.out, /Git repository with no log in it/);

  // Asked for, from a subfolder: only .gitroll/ is added, and the project is untouched.
  const deep = path.join(project, "src", "nested");
  fs.mkdirSync(deep, { recursive: true });
  const added = gitroll(["init", "--dir", project], { cwd: deep });
  assert.equal(added.code, 0, added.out);
  assert.ok(fs.existsSync(path.join(project, ".gitroll/config.yaml")));
  assert.equal(fs.readFileSync(path.join(project, "package.json"), "utf8"), "{}", "the project is untouched");
  assert.match(gitroll(["recent"], { cwd: deep }).out, /Nothing logged yet/, "the log is found from a subfolder");
});

test("the interactive menu asks one question, and the text carries the rest", () => {
  assert.equal(gitroll(["new", "Menu Roll"]).code, 0);
  const session = gitroll(["menu", "--roll", "menu-roll"], {
    env: { GITROLL_FORCE_INTERACTIVE: "1" },
    input: `1\nFixed the side gate latch #garden\n2\nlatch\n3\nq\n`,
  });
  assert.equal(session.code, 0, session.out);
  assert.match(session.out, /1  Log something/);
  assert.match(session.out, /What happened\?/);
  assert.doesNotMatch(session.out, /Attach photos|Tags\?/, "nothing stands between the thought and the file");
  assert.match(session.out, /Logged\./);
  assert.match(session.out, /Fixed the side gate latch/);

  const found = gitroll(["find", "latch", "--roll", "menu-roll", "--json"]);
  const [entry] = JSON.parse(found.out);
  assert.deepEqual(entry.tags, ["garden"], "a #word somebody wrote is the tag");
});

test("basic mode never prompts: scripts and --plain get plain output", () => {
  const menu = gitroll(["menu"]);
  assert.notEqual(menu.code, 0);
  assert.match(menu.out, /needs an interactive terminal/);

  assert.equal(gitroll(["new", "Script Roll"]).code, 0);
  const piped = gitroll(["log", "--roll", "script-roll"], { input: "Logged from a script\n" });
  assert.equal(piped.code, 0, piped.out);
  const plain = gitroll(["recent", "--roll", "script-roll", "--plain"], { env: { GITROLL_FORCE_INTERACTIVE: "1" } });
  assert.match(plain.out, /Logged from a script/);
  assert.doesNotMatch(plain.out, /\x1b\[/, "no color codes");
});

test("developer commands: templates, an editor, code references and completion", () => {
  const dir = path.join(tmp(), "project");
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "app.ts"), "export const x = 1;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "the project");
  git(dir, "remote", "add", "origin", "git@github.com:acme/app.git");
  assert.equal(gitroll(["init", "--dir", dir]).code, 0);

  assert.match(gitroll(["templates"]).out, /debugging[\s\S]*incident[\s\S]*decision/);

  // $EDITOR gets the template, and what it leaves behind is the event.
  const logged = gitroll(["log", "--template", "incident", "--code", "Checkout timeouts", "--at", "2026-09-15", "-C", dir], {
    env: { EDITOR: process.platform === "darwin" ? "sed -i '' s/Impact/Impact-every-checkout-failed/" : "sed -i s/Impact/Impact-every-checkout-failed/" },
  });
  assert.equal(logged.code, 0, logged.out);
  const [event] = JSON.parse(gitroll(["find", "timeouts", "-C", dir, "--json"]).out) as { path: string; tags: string[]; meta: Record<string, { branch?: string }> }[];
  assert.equal(event.path, ".gitroll/events/2026-09-15-checkout-timeouts.md");
  assert.deepEqual(event.tags, ["incident"]);
  assert.equal(event.meta.source.branch, "main", "--code records the branch the work was on");
  assert.match(fs.readFileSync(path.join(dir, event.path), "utf8"), /## Impact-every-checkout-failed/, "the editor's text is what was saved");

  const shown = gitroll(["show", "timeouts", "-C", dir]).out;
  assert.match(shown, /Code: acme\/app · branch main/);

  // An empty editor logs nothing at all.
  const abandoned = gitroll(["log", "--editor", "-C", dir], { env: { EDITOR: "truncate -s 0" } });
  assert.match(abandoned.out, /Nothing logged/);
  assert.equal(JSON.parse(gitroll(["recent", "-C", dir, "--json"]).out).length, 1);

  assert.match(gitroll(["completion", "bash"]).out, /complete -F _gitroll gitroll/);
  assert.match(gitroll(["completion", "zsh"]).out, /#compdef gitroll/);
  assert.match(gitroll(["completion", "fish"]).out, /__fish_use_subcommand/);
  assert.notEqual(gitroll(["completion", "tcsh"]).code, 0);
  assert.match(gitroll(["__complete", "templates"]).out, /^debugging$/m);
  assert.match(gitroll(["__complete", "tags", "-C", dir]).out, /^incident$/m);
  assert.equal(gitroll(["__complete", "tags"], { cwd: tmp() }).out.trim(), "", "completion never fails, even outside a Roll");
});

test("saved searches, searching every Roll, and the branch in status --json", () => {
  assert.equal(gitroll(["new", "Work"]).code, 0);
  assert.equal(gitroll(["new", "Side"]).code, 0);
  gitroll(["log", "Shipped the parser #release", "--roll", "work"]);
  gitroll(["log", "Shipped the website #release", "--roll", "side"]);

  assert.match(gitroll(["find", "tag:release", "--save", "releases", "--roll", "work"]).out, /Saved that search as @releases/);
  assert.match(gitroll(["searches"]).out, /@releases\s+tag:release/);
  assert.match(gitroll(["find", "@releases", "--roll", "work"]).out, /Shipped the parser/);

  const everywhere = gitroll(["find", "@releases", "--all", "--roll", "work"]).out;
  assert.match(everywhere, /Shipped the parser/);
  assert.match(everywhere, /Shipped the website/, "--all reaches the other Roll");

  const status = JSON.parse(gitroll(["status", "--roll", "work", "--json"]).out) as { branch: string; blocker: string | null; hasCommits: boolean; head: string };
  assert.equal(status.branch, "main");
  assert.equal(status.blocker, null);
  assert.equal(status.hasCommits, true);
  assert.match(status.head, /^[0-9a-f]{7,}$/);

  assert.match(gitroll(["status", "--roll", "work"]).out, /· branch main/);
});

test("a tag written in the text isn't printed a second time underneath it", () => {
  const dir = path.join(tmp(), "roll");
  fs.mkdirSync(dir, { recursive: true });
  assert.equal(gitroll(["new", "Tags", "--dir", dir], { cwd: dir }).code, 0);
  gitroll(["-C", dir, "log", "Checkout times out\n\np99 went to 9s. #incident"]);
  // A tag in the front matter has nowhere else to appear, so it still does.
  gitroll(["-C", dir, "log", "Paid the vendor", "-t", "invoice"]);

  const written = gitroll(["-C", dir, "find", "Checkout"]).out;
  assert.equal(written.match(/#incident/g)?.length, 1, "the tag is in the body, and shown once");
  assert.match(gitroll(["-C", dir, "find", "vendor"]).out, /#invoice/);
});

test("history and restore are one way back, for an edit or a deletion", () => {
  // Deleted-entry recovery and version restoration used to be different
  // features with different names in different places. They are the same
  // question — what did this used to be, and can I have it back.
  const dir = path.join(tmp(), "roll");
  fs.mkdirSync(dir, { recursive: true });
  assert.equal(gitroll(["new", "Back", "--dir", dir], { cwd: dir }).code, 0);
  const at = (...args: string[]) => gitroll([...args, "-C", dir]);

  at("log", "Boiler serviced");
  at("edit", "2026-09-16-boiler-serviced", "--text", "Boiler serviced, and the valve replaced");
  const versions = JSON.parse(at("history", "2026-09-16-boiler-serviced", "--json").out) as unknown[];
  assert.equal(versions.length, 2, "an edit is a version");

  // An entry still in the Roll: restore means its earlier version.
  const back = JSON.parse(at("restore", "2026-09-16-boiler-serviced", "--json").out);
  assert.equal(back.restored, "version");
  assert.match(at("show", "2026-09-16-boiler-serviced").out, /Boiler serviced/);

  // The Roll's own history is what left it, and the same command brings it back.
  assert.match(at("history").out, /Nothing has been removed/);
  at("log", "Logged by mistake");
  at("delete", "2026-09-16-logged-by-mistake", "--yes");
  const removed = at("history");
  assert.match(removed.out, /1 entry removed/);
  assert.match(removed.out, /Logged by mistake/);
  assert.match(removed.out, /gitroll restore/);

  const put = JSON.parse(at("restore", "2026-09-16-logged-by-mistake", "--json").out);
  assert.equal(put.restored, "entry", "the same command, for the thing that left");
  assert.match(at("find", "mistake").out, /Logged by mistake/);
  assert.match(at("history").out, /Nothing has been removed/);
});

test("a folder is a backup, and what goes wrong with one is said in those terms", () => {
  // The first backup should not require an account, a token, or the GitHub CLI.
  // A drive or a share is a perfectly good somewhere-else, and GitRoll makes it
  // into a repository rather than explaining that it needs to be one.
  const dir = path.join(tmp(), "roll");
  fs.mkdirSync(dir, { recursive: true });
  assert.equal(gitroll(["new", "Backed", "--dir", dir], { cwd: dir }).code, 0);
  const at = (...args: string[]) => gitroll([...args, "-C", dir]);
  at("log", "Something worth keeping");

  const backup = path.join(tmp(), "backup.git");
  const first = at("backup", backup);
  assert.equal(first.code, 0, first.out);
  assert.match(first.out, /Made a backup repository/);
  assert.match(first.out, /Synced/);
  assert.ok(fs.existsSync(path.join(backup, "HEAD")), "a bare repository is waiting there");
  assert.match(at("status").out, /Saved and backed up/);

  at("log", "A second thing");
  assert.match(at("sync").out, /Synced/);

  // A drive that isn't plugged in is not a sign-in problem, and mustn't be
  // described as one.
  fs.renameSync(backup, `${backup}-moved`);
  const gone = at("sync");
  assert.notEqual(gone.code, 0);
  assert.match(gone.out, /isn't there, or isn't a backup any more/);
  assert.match(gone.out, /saved on this computer/);
  // The path itself ends in .git; what must not appear is an account or Git's
  // own words for what happened.
  assert.doesNotMatch(gone.out, /GitHub|signed in|sign in|fatal:|error:|remote:/i, "no accounts, and no Git in the answer");

  // A folder with something else in it is refused rather than written into.
  const occupied = tmp();
  fs.writeFileSync(path.join(occupied, "holiday.jpg"), "not a backup");
  const other = path.join(tmp(), "roll2");
  fs.mkdirSync(other, { recursive: true });
  assert.equal(gitroll(["new", "Other", "--dir", other], { cwd: other }).code, 0);
  const refused = gitroll(["backup", occupied, "-C", other]);
  assert.notEqual(refused.code, 0);
  assert.match(refused.out, /already has files in it/);
});

test("a first Roll can be named, and joined on a second computer by that name", () => {
  // The whole first run, in the order somebody actually does it: log something,
  // name it, back it up, pick it up elsewhere.
  const first = tmp();
  const here = { GITROLL_HOME: path.join(first, "settings"), GITROLL_ROLLS: path.join(first, "rolls") };
  const started = gitroll(["log", "Boiler serviced"], { env: here, cwd: first });
  assert.equal(started.code, 0, started.out);
  assert.match(started.out, /gitroll rename/, "the hint names the command that renames");

  const renamed = gitroll(["rename", "House"], { env: here, cwd: first });
  assert.equal(renamed.code, 0, renamed.out);
  // The list has to agree with the Roll: the name you typed is the name you see.
  const rolls = JSON.parse(gitroll(["rolls", "--json"], { env: here, cwd: first }).out) as { key: string; default: boolean }[];
  assert.deepEqual(rolls.map((r) => r.key), ["house"]);
  assert.equal(rolls[0].default, true, "and it is still the default");
  assert.match(gitroll(["find", "Boiler", "--roll", "house"], { env: here, cwd: first }).out, /Boiler serviced/);
  // The folder is left where it is; a path is not a title.
  assert.ok(fs.existsSync(path.join(first, "rolls", "my-roll", ".gitroll/config.yaml")));

  const backup = path.join(tmp(), "house.git");
  assert.equal(gitroll(["backup", backup], { env: here, cwd: first }).code, 0);

  // A second computer: its own settings, joining from the folder backup.
  const second = tmp();
  const there = { GITROLL_HOME: path.join(second, "settings"), GITROLL_ROLLS: path.join(second, "rolls") };
  const joined = gitroll(["join", backup], { env: there, cwd: second });
  assert.equal(joined.code, 0, joined.out);
  assert.match(joined.out, /Joined "House"/);
  const key = JSON.parse(gitroll(["rolls", "--json"], { env: there, cwd: second }).out)[0].key;
  assert.equal(key, "house", "filed under the Roll's own name, not the backup file's");
  assert.ok(fs.existsSync(path.join(second, "rolls", "house", ".gitroll/config.yaml")));
  assert.match(gitroll(["find", "Boiler", "--roll", "house"], { env: there, cwd: second }).out, /Boiler serviced/);

  // And what it writes goes back to the same backup.
  gitroll(["log", "Logged on the second computer", "--roll", "house"], { env: there, cwd: second });
  assert.equal(gitroll(["sync", "--roll", "house"], { env: there, cwd: second }).code, 0);
  assert.equal(gitroll(["sync", "--roll", "house"], { env: here, cwd: first }).code, 0);
  assert.match(gitroll(["find", "second computer", "--roll", "house"], { env: here, cwd: first }).out, /Logged on the second computer/);

  // Two Rolls can't collide under one name.
  const clash = gitroll(["join", backup], { env: there, cwd: second });
  assert.notEqual(clash.code, 0);
  assert.match(clash.out, /already exists/);
});
