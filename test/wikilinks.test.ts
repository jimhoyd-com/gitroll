// Wiki links. `[[Ada Lovelace]]` names a document rather than its path: it is
// resolved against every event and note (path, file name, title, aliases, in
// that order) and then counts as a link wherever a relative link does.

import "./helpers.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { linksAsText, parseEntry } from "../src/core/entry.ts";
import { linkText } from "../src/core/calendar.ts";
import { backlinks, frontMatterLinks } from "../src/core/relations.ts";
import { WikiIndex, aliasesOf, wikiLinksIn, wikiProblems, wikiValue, withWikiLinks } from "../src/core/wikilinks.ts";
import { validateRepo } from "../src/core/validate.ts";
import * as core from "../src/core/index.ts";
import { GitRoll } from "../src/node/repo.ts";
import { git, tmp } from "./helpers.ts";

const cli = fileURLToPath(new URL("../src/node/cli.ts", import.meta.url));
function json(roll: GitRoll, args: string[]) {
  const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", cli, ...args, "-C", roll.root, "--json"], { encoding: "utf8", cwd: tmp(), timeout: 10_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout);
}
const doc = (p: string, front: string, body = "# Untitled") => parseEntry(p, `${front ? `---\n${front}\n---\n\n` : ""}${body}\n`);

test("wiki links in text: name, |label, #heading, ![[embed]]; none in code, across lines or with brackets inside", () => {
  const links = wikiLinksIn("Met [[Ada Lovelace|Ada]] about [[Engine#Notes]] and ![[Diagram]].\n`[[code]]`\n```\n[[fenced]]\n```\n[[broken\nacross]] [[a[b]] [[ ]]");
  assert.deepEqual(links, [
    { target: "Ada Lovelace", label: "Ada", heading: null, embed: false },
    { target: "Engine", label: null, heading: "Notes", embed: false },
    { target: "Diagram", label: null, heading: null, embed: true },
  ]);
  assert.deepEqual(wikiValue(' [[Acme]] '), { target: "Acme", label: null, heading: null, embed: false });
  assert.equal(wikiValue("[[Acme]] and more"), null);
  assert.equal(wikiValue("[Acme](acme.md)"), null);
  assert.equal(linksAsText("Call [[Ada Lovelace|Ada]] at [[Acme#Reception]] and [Bob](bob.md)"), "Call Ada at Acme and Bob");
  assert.equal(linkText("[[Acme|ACME Corp]]"), "ACME Corp");
  assert.equal(core.withWikiLinks, withWikiLinks, "exported from @gitroll/core");
});

test("a name resolves by path, then file name, then title, then alias; the first tier that names any decides", () => {
  const ada = doc(".gitroll/notes/people/ada-lovelace.md", "aliases: [Ada, Countess of Lovelace]", "# Ada Lovelace");
  const adaEvent = doc(".gitroll/events/2026-01-01-ada.md", "", "# Ada's birthday party");
  const acme = doc(".gitroll/notes/orgs/acme.md", "alias: ACME Corp", "# Acme");
  const acme2 = doc(".gitroll/notes/clients/acme.md", "", "# Acme Industries");
  const index = new WikiIndex([ada, adaEvent, acme, acme2]);
  assert.deepEqual(aliasesOf(ada), ["Ada", "Countess of Lovelace"]);
  assert.deepEqual(index.resolve("people/ada-lovelace"), { path: ada.path });
  assert.deepEqual(index.resolve("notes/people/ada-lovelace.md"), { path: ada.path });
  assert.deepEqual(index.resolve("ADA LOVELACE"), { path: ada.path }, "a title, ignoring case");
  assert.deepEqual(index.resolve("countess  of lovelace"), { path: ada.path }, "an alias, ignoring runs of space");
  assert.deepEqual(index.resolve("2026-01-01-ada"), { path: adaEvent.path }, "a file name");
  assert.deepEqual(index.resolve("Ada"), { path: ada.path }, "only an alias says Ada");
  assert.deepEqual(index.resolve("acme"), { ambiguous: [acme2.path, acme.path] }, "two file names are equally good");
  assert.deepEqual(index.resolve("clients/acme"), { path: acme2.path }, "a path settles it");
  assert.deepEqual(index.resolve("ACME Corp"), { path: acme.path });
  assert.equal(index.resolve("Babbage"), null);
});

test("withWikiLinks: text links join links (backlinks follow), front matter values resolve through fieldLink", () => {
  const ada = doc(".gitroll/notes/people/ada.md", 'org: "[[Acme]];Research"\nlocation: "[[Garage]]"', "# Ada");
  const acme = doc(".gitroll/notes/organizations/acme.md", "", "# Acme");
  const garage = doc(".gitroll/notes/places/garage.md", "", "# Garage");
  const lunch = doc(".gitroll/events/2026-10-14-lunch.md", "", "# Lunch\n\nWith [[Ada]], then [[Ada|her]] again, and [[Nobody]]. Also [[2026-10-14-lunch]].");
  const plain = doc(".gitroll/events/2026-10-15-plain.md", "", "# Plain");
  const docs = withWikiLinks([ada, acme, garage, lunch, plain]);
  assert.equal(docs[4], plain, "a document without wiki links isn't copied");
  assert.deepEqual(docs[3].links, [ada.path], "once, never itself, and nothing for a name that matches nothing");
  assert.deepEqual(lunch.links, [], "the parsed entry isn't changed");
  assert.deepEqual(backlinks(ada.path, docs).map((d) => d.path), [lunch.path]);
  assert.deepEqual(frontMatterLinks(docs[0]), [garage.path], "location resolves; org with units is read by orgReference");
  assert.deepEqual(core.organizations([docs[1]], docs).organizations[0].members.map((m) => [m.name, m.units]), [["Ada", "Research"]]);
  assert.deepEqual(wikiProblems([ada, acme, garage, lunch, plain]), [{ path: lunch.path, target: "Nobody", ambiguous: null }]);
});

test("a Roll read from disk resolves wiki links; check warns on one that names nothing and errs on one that names two", () => {
  const roll = GitRoll.init(tmp(), { name: "Home" });
  const ada = roll.saveRecord({ collection: "people", title: "Ada Lovelace", fields: [["aliases", { yaml: "[Ada]" }]] }).entry.path;
  const logged = json(roll, ["log", "Lunch with [[Ada]] and [[Charles Babbage]]", "--at", "2026-10-14"]);
  assert.deepEqual(logged.entry.links, [ada], "the entry a write returns has them resolved too");
  assert.deepEqual(json(roll, ["related", ada]).backlinks, [logged.entry.path]);
  assert.equal(json(roll, ["contacts"]).contacts[0].lastContacted, "2026-10-14");

  const problems = validateRepo({ paths: git(roll.root, "ls-files").split("\n").filter(Boolean), read: (p) => fs.readFileSync(path.join(roll.root, p), "utf8") });
  assert.deepEqual(problems.map((p) => [p.severity, p.error]), [["warning", "[[Charles Babbage]] doesn't name any event or note in this Roll"]]);
  roll.saveRecord({ collection: "clients", title: "Ada Lovelace" });
  roll.save({ text: "Invoice for [[Ada Lovelace]]", date: "2026-10-15" });
  const twice = validateRepo({ paths: git(roll.root, "ls-files").split("\n").filter(Boolean), read: (p) => fs.readFileSync(path.join(roll.root, p), "utf8") });
  const clash = twice.find((p) => p.severity === "error");
  assert.match(clash!.error, /^\[\[Ada Lovelace\]\] could be any of \.gitroll\/notes\/clients\/ada-lovelace\.md, \.gitroll\/notes\/people\/ada-lovelace\.md; link one by its path/);
});
