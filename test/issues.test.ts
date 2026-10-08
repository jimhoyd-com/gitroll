// Pins and issues. A pinned event or note (`pinned: true`) is listed first;
// an issue (`issue: open`) stays open until `resolved:` says otherwise or a
// later event's `resolves:` links to it, which is read the other way round,
// like a backlink, and never written on the issue.

import "./helpers.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseEntry } from "../src/core/entry.ts";
import { isIssue, issueOf, issues, resolvedIssues, resolvesLinks, resolvesValue, withoutResolved } from "../src/core/issues.ts";
import { upcomingWithReminders } from "../src/core/reminders.ts";
import { toICalendar } from "../src/core/ical.ts";
import { isPinned, pinnedFirst } from "../src/core/pins.ts";
import { SearchIndex } from "../src/core/search.ts";
import * as core from "../src/core/index.ts";
import { GitRoll } from "../src/node/repo.ts";
import { git, tmp } from "./helpers.ts";

const cli = fileURLToPath(new URL("../src/node/cli.ts", import.meta.url));
function run(roll: GitRoll, args: string[]) {
  return spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", cli, ...args, "-C", roll.root], { encoding: "utf8", cwd: tmp(), timeout: 10_000 });
}
function json(roll: GitRoll, args: string[]) {
  const result = run(roll, [...args, "--json"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout);
}
const doc = (p: string, front: string, body = "# Untitled") => parseEntry(p, `${front ? `---\n${front}\n---\n\n` : ""}${body}\n`);

test("pins: pinned: true is pinned, listed first in the order each part was in, and found with is:pinned", () => {
  const a = doc(".gitroll/events/2026-10-01-a.md", "", "# A");
  const b = doc(".gitroll/events/2026-09-01-b.md", "pinned: true", "# B");
  const c = doc(".gitroll/notes/wifi.md", "Pinned: true", "# Wi-Fi");
  const d = doc(".gitroll/events/2026-08-01-d.md", 'pinned: "yes"', "# D");
  assert.deepEqual([a, b, c, d].map(isPinned), [false, true, true, false], "the key in any case; only true pins");
  assert.deepEqual(pinnedFirst([a, b, c, d]).map((e) => e.title), ["B", "Wi-Fi", "A", "D"]);
  const none = [a, d];
  assert.equal(pinnedFirst(none), none, "nothing pinned: the same list");
  assert.deepEqual(new SearchIndex([a, b, c, d]).search("is:pinned").map((e) => e.title), ["B", "Wi-Fi"]);
  assert.deepEqual(new SearchIndex([a, b, c, d]).search("is:pinned is:note").map((e) => e.title), ["Wi-Fi"]);
  assert.equal(typeof core.pinnedFirst, "function");
});

const clunk = doc(".gitroll/events/2026/2026-09-20-clunk.md", "date: 2026-09-20\nissue: open\nprojects: [car]", "# Clunk from the front wheel");
const garage = doc(".gitroll/events/2026/2026-09-25-garage.md", "", "# Took it to the garage\n\nAbout the [clunk](2026-09-20-clunk.md).");
const fixed = doc(".gitroll/events/2026-10-02-fixed.md", 'resolves: "[Clunk](2026/2026-09-20-clunk.md)"', "# New sway bar link");
const leak = doc(".gitroll/events/2026-09-01-leak.md", "issue: true\nresolved: 2026-09-04", "# Leak under the sink");
const squeak = doc(".gitroll/notes/house/squeak.md", "issue: Open", "# Squeaky stair");
const flaky = doc(".gitroll/events/2026-10-05-flaky.md", "issue: true", "# Flaky Wi-Fi");
const notOne = doc(".gitroll/events/2026-10-06-fine.md", "issue: false", "# Fine");

test("issues: issue: open or true, open until resolved: or a resolves: link, with age and activity", () => {
  assert.deepEqual([clunk, leak, squeak, flaky, notOne, garage].map(isIssue), [true, true, true, true, false, false]);
  assert.deepEqual(resolvesLinks(fixed), [clunk.path]);
  const docs = [clunk, garage, fixed, leak, squeak, flaky, notOne];
  const today = "2026-10-07";

  // Before the event that resolves it, the clunk is open.
  const open = issueOf(clunk, [clunk, garage], today)!;
  assert.equal(open.status, "open");
  assert.equal(open.age, 17);
  assert.deepEqual(open.activity.map((a) => a.title), ["Took it to the garage"]);
  assert.equal(open.lastActivity, "2026-09-25");

  const after = issueOf(clunk, docs, today)!;
  assert.equal(after.status, "resolved");
  assert.equal(after.resolved, "2026-10-02");
  assert.equal(after.age, 12, "open from the 20th to the day it was resolved");
  assert.deepEqual(after.resolvedBy.map((r) => r.path), [fixed.path]);
  assert.deepEqual(after.activity.map((a) => a.title), ["New sway bar link", "Took it to the garage"], "a resolves: link is activity too");
  assert.equal(issueOf(notOne, docs, today), null);

  const sink = issueOf(leak, docs, today)!;
  assert.deepEqual([sink.status, sink.resolved, sink.age, sink.resolvedBy], ["resolved", "2026-09-04", 3, []]);
  const stair = issueOf(squeak, docs, today)!;
  assert.deepEqual([stair.kind, stair.status, stair.opened, stair.age], ["note", "open", null, null], "a note has no date to count from");

  const list = issues(docs, docs, today);
  assert.deepEqual([list.open, list.resolved], [2, 2]);
  assert.deepEqual(list.issues.map((i) => i.title), ["Flaky Wi-Fi", "Squeaky stair"], "open only, newest activity first; undated last");
  assert.deepEqual(issues(docs, docs, today, { all: true }).issues.map((i) => i.title), ["Flaky Wi-Fi", "Clunk from the front wheel", "Leak under the sink", "Squeaky stair"]);
  assert.deepEqual(issues([clunk, leak], docs, today, { all: true }).issues.length, 2, "only the candidates given");
  assert.deepEqual(new SearchIndex(docs).search("is:issue").map((e) => e.title), ["Clunk from the front wheel", "Leak under the sink", "Squeaky stair", "Flaky Wi-Fi"]);

  // A note's resolves: isn't a resolution: resolving is something that happened.
  const aNote = doc(".gitroll/notes/x.md", 'resolves: "[Flaky](../events/2026-10-05-flaky.md)"', "# X");
  assert.equal(issueOf(flaky, [...docs, aNote], today)!.status, "open");
  // A list of links resolves each.
  const both = doc(".gitroll/events/2026-10-07-both.md", 'resolves: ["[Flaky](2026-10-05-flaky.md)", "[Stair](../notes/house/squeak.md)"]', "# Both");
  assert.deepEqual(issues([flaky, squeak], [...docs, both], today), { open: 0, resolved: 2, issues: [] });

  assert.equal(resolvesValue(".gitroll/events/2026-10-07-x.md", clunk), "[Clunk from the front wheel](2026/2026-09-20-clunk.md)");
  assert.equal(resolvesValue(".gitroll/events/x.md", doc(".gitroll/notes/a [b].md", "", "# A [b] (c)")), "[A b (c)](../notes/a%20%5Bb%5D.md)");
  assert.equal(typeof core.issues, "function");
});

test("gitroll pin and unpin: one field, the same file, idempotent, refused when stale; recent and find list pinned first", () => {
  const roll = GitRoll.init(tmp(), { name: "Pins" });
  roll.save({ text: "Older", date: "2026-09-01" });
  roll.save({ text: "Newer", date: "2026-10-01" });
  roll.saveNote({ title: "Wi-Fi", text: "Network: home" });
  const older = roll.entries().find((e) => e.title === "Older")!;
  const pinned = json(roll, ["pin", "older"]);
  assert.equal(pinned.changed, true);
  assert.equal(pinned.entry.path, older.path, "the file keeps its name");
  assert.equal(pinned.entry.meta.pinned, true);
  assert.match(git(roll.root, "log", "-1", "--format=%s"), /^pin: Older/);
  assert.equal(json(roll, ["pin", "older"]).changed, false, "pinning twice writes nothing");

  assert.deepEqual(json(roll, ["recent"]).map((e: { title: string }) => e.title), ["Older", "Newer"]);
  assert.deepEqual(json(roll, ["find", "is:pinned"]).map((e: { title: string }) => e.title), ["Older"]);
  assert.deepEqual(json(roll, ["find", "e", "--sort=-date"]).map((e: { title: string }) => e.title).slice(0, 2), ["Newer", "Older"], "--sort is the order asked for");
  const text = run(roll, ["recent"]).stdout;
  assert.match(text, /^Pinned\n/);
  assert.ok(text.indexOf("Older") < text.indexOf("Everything else") && text.indexOf("Everything else") < text.indexOf("Newer"), text);

  json(roll, ["pin", "notes/wi-fi"]);
  assert.deepEqual(json(roll, ["find", "is:pinned"]).map((e: { title: string }) => e.title), ["Older", "Wi-Fi"]);

  const stale = run(roll, ["unpin", "older", "--expect", "0".repeat(64), "--json"]);
  assert.equal(stale.status, 1);
  assert.equal(JSON.parse(stale.stderr).error.code, "CONFLICT");
  const unpinned = json(roll, ["unpin", "older"]);
  assert.equal(unpinned.changed, true);
  assert.equal(unpinned.entry.meta.pinned, undefined);
  assert.doesNotMatch(fs.readFileSync(path.join(roll.root, older.path), "utf8"), /pinned/, "unpinning takes the key out");
  assert.equal(json(roll, ["unpin", "older"]).changed, false);
  assert.doesNotMatch(run(roll, ["recent"]).stdout, /Pinned/);
});

test("gitroll issues and gitroll close: lists open issues, and resolves one by logging an event that links to it", () => {
  const roll = GitRoll.init(tmp(), { name: "Car" });
  assert.match(run(roll, ["issues"]).stdout, /^No open issues\.\nAn issue is an event or note with issue: open/);
  const clunkPath = roll.save({ text: "Clunk from the front wheel", date: "2026-09-20", projects: ["car"] }).entry.path;
  roll.setFields(clunkPath, [["issue", { yaml: "open" }]]);
  roll.save({ text: `Took it to the garage\n\nAbout the [clunk](${path.basename(clunkPath)}).`, date: "2026-09-25" });
  roll.save({ text: "Not an issue", date: "2026-09-26" });

  const view = json(roll, ["issues"]);
  assert.deepEqual([view.open, view.resolved], [1, 0]);
  assert.equal(view.issues[0].path, clunkPath);
  assert.equal(view.issues[0].lastActivity, "2026-09-25");
  assert.deepEqual(view.issues[0].activity.map((a: { title: string }) => a.title), ["Took it to the garage"]);
  assert.match(run(roll, ["issues"]).stdout, /^Clunk from the front wheel {2}open \d+ days {2}1 event, last 2026-09-25 {2}2026-09-20-clunk-from-the-front-wheel$/m);
  assert.equal(json(roll, ["issues", "garage"]).issues.length, 0, "a query narrows which issues are read");

  const refused = run(roll, ["close", "not an issue", "--json"]);
  assert.equal(refused.status, 1);
  assert.match(JSON.parse(refused.stderr).error.message, /isn't marked as an issue.*gitroll set .* issue=open/);

  const closed = json(roll, ["close", "clunk", "--note", "New sway bar link", "--at", "2026-10-02"]);
  assert.equal(closed.changed, true);
  assert.equal(closed.issue.status, "resolved");
  assert.equal(closed.issue.resolved, "2026-10-02");
  assert.equal(closed.issue.age, 12);
  assert.equal(closed.entry.title, "Resolved: Clunk from the front wheel");
  assert.deepEqual(closed.entry.projects, ["car"], "with the issue's projects");
  assert.equal(closed.entry.meta.resolves, "[Clunk from the front wheel](2026-09-20-clunk-from-the-front-wheel.md)");
  assert.match(closed.entry.body, /New sway bar link/);
  assert.match(git(roll.root, "log", "-1", "--format=%s"), /^close: Clunk from the front wheel/);
  assert.match(git(roll.root, "show", "--stat", "--format=", "HEAD"), /1 file changed/, "the issue itself isn't touched");

  const again = json(roll, ["close", "clunk"]);
  assert.deepEqual([again.changed, again.entry], [false, null], "already resolved: nothing written");
  assert.match(run(roll, ["close", "clunk"]).stdout, /^Already resolved on 2026-10-02, by 2026-10-02-resolved-clunk-from-the-front-wheel: nothing to change\./);

  const after = json(roll, ["issues"]);
  assert.deepEqual([after.open, after.resolved, after.issues.length], [0, 1, 0]);
  assert.match(run(roll, ["issues"]).stdout, /^No open issues\.\n1 resolved issue isn't listed; see it with --all\./);
  assert.match(run(roll, ["issues", "--all"]).stdout, /Clunk from the front wheel {2}resolved 2026-10-02 after 12 days/);

  // resolved: on the issue itself works the same way.
  const leak = roll.save({ text: "Leak under the sink", date: "2026-09-01" }).entry.path;
  roll.setFields(leak, [["issue", { value: true }]]);
  assert.equal(json(roll, ["issues"]).open, 1);
  roll.setFields(leak, [["resolved", { yaml: "2026-09-04" }]]);
  assert.equal(json(roll, ["issues"]).open, 0);
  assert.equal(json(roll, ["issues", "--all", "leak"]).issues[0].age, 3);

  const schema = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", cli, "schema", "close"], { encoding: "utf8", cwd: tmp(), timeout: 10_000 });
  assert.deepEqual(Object.keys(JSON.parse(schema.stdout).commands[0].options), ["repo", "roll", "note", "at"]);
  assert.equal(run(roll, ["issues", "--note", "x", "--json"]).status, 1, "only --all");
});

test("a resolved issue's to-dos, reminders and repeats leave the calendar; its file keeps them", () => {
  const tires = doc(".gitroll/notes/bike/tires.md", "issue: open\nstart: 2026-10-01\nrrule: FREQ=WEEKLY\nremind: -PT1H", "# Tires lose pressure\n\n- [ ] Buy a pump 📅 2026-10-09 ⏰ 2026-10-08 18:00");
  const settled = doc(".gitroll/notes/bike/tires.md", "issue: open\nresolved: 2026-10-06\nstart: 2026-10-01\nrrule: FREQ=WEEKLY\nremind: -PT1H", "# Tires lose pressure\n\n- [ ] Buy a pump 📅 2026-10-09 ⏰ 2026-10-08 18:00");
  const chain = doc(".gitroll/notes/bike/chain.md", "start: 2026-10-01\nrrule: FREQ=WEEKLY", "# Lube the chain");
  const todo = { path: tires.path, line: 9, text: "Buy a pump 📅 2026-10-09 ⏰ 2026-10-08 18:00", done: false };
  const now = new Date("2026-10-07T12:00:00");
  const items = (docs: typeof tires[], todos: (typeof todo)[]) => {
    const kept = withoutResolved(docs, todos);
    return upcomingWithReminders(kept.docs, kept.todos, "2026-10-07", 14, now).map((i) => `${i.kind} ${i.title}`);
  };
  const open = items([tires, chain], [todo]);
  assert.ok(open.includes("occurrence Tires lose pressure") && open.includes("todo Buy a pump") && open.includes("reminder Tires lose pressure"));
  const done = items([settled, chain], [todo]);
  assert.deepEqual(done.filter((i) => /Tires|pump/.test(i)), [], "nothing from the resolved issue");
  assert.ok(done.includes("occurrence Lube the chain"), "what isn't an issue is untouched");
  assert.deepEqual([...resolvedIssues([settled, chain, clunk, fixed])].sort(), [clunk.path, settled.path].sort());
  assert.equal(withoutResolved([settled], [todo]).docs[0].meta.issue, "open", "the rest of its front matter is as it was");
  assert.doesNotMatch(toICalendar(withoutResolved([settled], [todo]).docs, [], { today: "2026-10-07" }), /RRULE|VALARM/);
});
