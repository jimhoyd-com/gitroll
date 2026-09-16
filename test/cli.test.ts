import "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { GitRoll } from "../src/node/repo.ts";
import { escapePath } from "../src/node/tui/text.ts";
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
  // Ask is part of the app now, and says what it needs rather than failing blankly.
  assert.match(gitroll(["help"]).out, /gitroll ask "question"/);
  assert.match(gitroll(["ai"]).out, /On this computer[\s\S]*gitroll ai ollama/);
  assert.match(gitroll(["ask", "anything", "--roll", "nope"]).out, /There's no Roll/);
});

test("projects need no setup, and the template version can be recorded", () => {
  const dir = path.join(tmp(), "garage");
  assert.equal(gitroll(["init", "--dir", dir]).code, 0);
  assert.equal(gitroll(["log", "Oil change", "-p", "Truck", "-C", dir]).code, 0);
  assert.match(gitroll(["projects", "-C", dir]).out, /truck\s+1 event/);

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

test("interactive menu: log step by step, then find it", () => {
  assert.equal(gitroll(["new", "Menu Roll"]).code, 0);
  const photo = path.join(tmp(), "gate photo.jpg");
  fs.writeFileSync(photo, "fake jpeg");
  const escaped = escapePath(photo); // as a terminal escapes a dragged path
  const session = gitroll(["menu", "--roll", "menu-roll"], {
    env: { GITROLL_FORCE_INTERACTIVE: "1" },
    input: `1\nFixed the side gate latch\n${escaped}\nGarden\n2\nlatch\n3\nq\n`,
  });
  assert.equal(session.code, 0, session.out);
  assert.match(session.out, /1  Log something/);
  assert.match(session.out, /Logged\./);
  assert.match(session.out, /Fixed the side gate latch/);
  assert.match(session.out, /1 file/);

  const found = gitroll(["find", "latch", "--roll", "menu-roll", "--json"]);
  const [entry] = JSON.parse(found.out);
  assert.deepEqual(entry.projects, ["garden"]);
  assert.equal(entry.attachments[0].path, ".gitroll/files/gate-photo.jpg");
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
  const logged = gitroll(["log", "--template", "incident", "--code", "Checkout timeouts", "-C", dir], {
    env: { EDITOR: "sed -i s/Impact/Impact-every-checkout-failed/" },
  });
  assert.equal(logged.code, 0, logged.out);
  const [event] = JSON.parse(gitroll(["find", "timeouts", "-C", dir, "--json"]).out) as { path: string; tags: string[]; meta: Record<string, { branch?: string }> }[];
  assert.equal(event.path, `.gitroll/events/${new Date().toISOString().slice(0, 10)}-checkout-timeouts.md`);
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
