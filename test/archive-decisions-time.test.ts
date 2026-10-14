// Archived, decisions and time. `archived:` keeps a document but out of the
// lists of what is current; `decision:` marks a decision, replaced by a later
// accepted one whose `supersedes:` links to it; `duration:` is time spent,
// added up like the ledger adds up amounts.

import "./helpers.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseEntry } from "../src/core/entry.ts";
import { asksForArchived, current, isArchived } from "../src/core/archive.ts";
import { decisionOf, decisions, isDecision } from "../src/core/decisions.ts";
import { withoutResolved } from "../src/core/issues.ts";
import { SearchIndex } from "../src/core/search.ts";
import { durationSeconds, formatSeconds, timeSpent, toTimeclock } from "../src/core/time.ts";
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

test("archived: a date or true archives, in any case; false and empty don't; a query asks for archived ones", () => {
  const a = doc(".gitroll/notes/a.md", "archived: 2026-10-14", "# A");
  const b = doc(".gitroll/notes/b.md", "Archived: true", "# B");
  const c = doc(".gitroll/notes/c.md", "archived: false", "# C");
  const d = doc(".gitroll/notes/d.md", 'archived: ""', "# D");
  const e = doc(".gitroll/notes/e.md", "", "# E");
  assert.deepEqual([a, b, c, d, e].map(isArchived), [true, true, false, false, false]);
  assert.deepEqual(current([a, b, c, d, e]).map((x) => x.title), ["C", "D", "E"]);
  for (const q of ["is:archived", "has:archived", "archived:2026", "archived>=2026-01-01", "Archived:true"]) assert.equal(asksForArchived(q), true, q);
  for (const q of ["", "tag:x", "archive", "is:pinned"]) assert.equal(asksForArchived(q), false, q);
  assert.deepEqual(current([a, b, e], "is:archived").map((x) => x.title), ["A", "B", "E"], "asked for, nothing is left out");
  assert.deepEqual(new SearchIndex([a, b, c, e]).search("is:archived").map((x) => x.title), ["A", "B"]);
  assert.equal(core.isArchived, isArchived, "exported from @gitroll/core");
});

test("archived documents leave the calendar altogether: dated fields, repeats and to-dos", () => {
  const ada = doc(".gitroll/notes/people/ada.md", "bday: 1815-12-10\narchived: 2026-10-14", "# Ada\n\n- [ ] Send a card 📅 2026-12-01");
  const bob = doc(".gitroll/notes/people/bob.md", "bday: 1990-01-02", "# Bob");
  const { docs, todos } = withoutResolved([ada, bob], [{ path: ada.path, line: 3, text: "Send a card 📅 2026-12-01", done: false, title: "Ada" }]);
  assert.deepEqual(docs.map((d) => d.title), ["Bob"]);
  assert.deepEqual(todos, []);
});

test("gitroll archive and unarchive: one field, then off recent, find, notes, records, todos, upcoming and contacts until asked", () => {
  const roll = GitRoll.init(tmp(), { name: "Home" });
  roll.saveRecord({ collection: "people", title: "Old Landlord", fields: [["bday", { yaml: "1960-11-20" }]] });
  roll.saveRecord({ collection: "people", title: "Ada Lovelace" });
  fs.appendFileSync(path.join(roll.root, ".gitroll/notes/people/old-landlord.md"), "\n- [ ] Return the keys\n");
  git(roll.root, "add", "-A");
  git(roll.root, "commit", "-qm", "to-do");
  const event = roll.save({ text: "Moved out", date: "2026-09-01" }).entry.path;

  const archived = json(roll, ["archive", "notes/people/old-landlord"]);
  assert.equal(archived.changed, true);
  assert.match(String(archived.entry.meta.archived), /^\d{4}-\d{2}-\d{2}/);
  assert.match(git(roll.root, "log", "-1", "--format=%s"), /^archive: Old Landlord/);
  const again = json(roll, ["archive", "notes/people/old-landlord"]);
  assert.equal(again.changed, false, "already archived: the first day is kept");

  assert.deepEqual(json(roll, ["find", "landlord"]), []);
  assert.equal(json(roll, ["find", "landlord is:archived"]).length, 1);
  assert.deepEqual(json(roll, ["notes"]).map((n: { title: string }) => n.title), ["Ada Lovelace"]);
  const table = json(roll, ["records", "people"]);
  assert.deepEqual([table.total, table.archived], [1, 1]);
  assert.match(run(roll, ["records", "people"]).stdout, /1 archived record isn't listed; add is:archived to see it\./);
  assert.equal(json(roll, ["records", "people", "is:archived"]).records[0].title, "Old Landlord");
  assert.deepEqual(json(roll, ["todos"]), []);
  assert.equal(json(roll, ["todos", "--all"]).length, 1, "--all still lists its to-dos");
  assert.ok(!json(roll, ["upcoming", "--days", "400"]).some((i: { title: string }) => /Landlord/.test(i.title)));
  assert.deepEqual(json(roll, ["contacts"]).contacts.map((c: { name: string }) => c.name), ["Ada Lovelace"]);

  json(roll, ["archive", event]);
  assert.deepEqual(json(roll, ["recent"]), []);
  assert.equal(json(roll, ["show", event]).path, event, "show still reads it");

  const back = json(roll, ["unarchive", "notes/people/old-landlord"]);
  assert.equal(back.changed, true);
  assert.doesNotMatch(fs.readFileSync(path.join(roll.root, ".gitroll/notes/people/old-landlord.md"), "utf8"), /archived/);
  assert.equal(json(roll, ["unarchive", "notes/people/old-landlord"]).changed, false);
  assert.equal(json(roll, ["records", "people"]).total, 2);
});

test("decisions: MADR's statuses; an accepted decision's supersedes: replaces an earlier one, read like a backlink", () => {
  const nas = doc(".gitroll/events/2025-03-01-nas.md", "decision: accepted", "# Back up to the NAS");
  const b2 = doc(".gitroll/events/2026-10-01-b2.md", 'decision: Accepted\nsupersedes: "[NAS](2025-03-01-nas.md)"', "# Back up to B2");
  const isp = doc(".gitroll/events/2026-10-05-isp.md", "decision: proposed\nsupersedes: \"[B2](2026-10-01-b2.md)\"", "# Switch ISP");
  const old = doc(".gitroll/notes/rule.md", "decision: true\nsuperseded: 2026-01-01", "# House rule");
  const no = doc(".gitroll/notes/x.md", "decision: maybe", "# Not one");
  const all = [nas, b2, isp, old, no];
  assert.deepEqual(all.map(isDecision), [true, true, true, true, false]);
  assert.equal(decisionOf(nas, all)!.status, "superseded");
  assert.deepEqual(decisionOf(nas, all)!.supersededBy.map((d) => d.title), ["Back up to B2"]);
  assert.equal(decisionOf(nas, all)!.superseded, "2026-10-01");
  assert.equal(decisionOf(b2, all)!.status, "accepted", "a proposal replaces nothing until it is accepted");
  assert.deepEqual(decisionOf(b2, all)!.supersedes, [{ path: nas.path, title: "Back up to the NAS" }]);
  assert.equal(decisionOf(old, all)!.status, "superseded");
  const view = decisions(all, all);
  assert.deepEqual([view.current, view.proposed, view.other], [1, 1, 2]);
  assert.deepEqual(view.decisions.map((d) => d.title), ["Switch ISP", "Back up to B2"]);
  assert.equal(decisions(all, all, { all: true }).decisions.length, 4);
  assert.deepEqual(new SearchIndex(all).search("is:decision").length, 4);
});

test("gitroll decide and decisions: logs one, links what it replaces, and leaves the old file alone", () => {
  const roll = GitRoll.init(tmp(), { name: "Home" });
  assert.match(run(roll, ["decisions"]).stdout, /^No decisions in force or proposed\./);
  const first = json(roll, ["decide", "Back up to the NAS", "Cheap and local", "--at", "2025-03-01"]);
  assert.equal(first.decision.status, "accepted");
  assert.equal(first.entry.meta.decision, "accepted");
  assert.match(git(roll.root, "log", "-1", "--format=%s"), /^decide: Back up to the NAS/);

  const refused = run(roll, ["decide", "B2", "--supersedes", "nothing like it", "--json"]);
  assert.equal(refused.status, 1);
  const plain = roll.save({ text: "Not a decision", date: "2026-09-01" }).entry.path;
  const notOne = run(roll, ["decide", "B2", "--supersedes", plain, "--json"]);
  assert.match(JSON.parse(notOne.stderr).error.message, /isn't marked as a decision/);

  const second = json(roll, ["decide", "Back up to B2", "--supersedes", "NAS", "--at", "2026-10-01", "-p", "house"]);
  assert.equal(second.entry.meta.supersedes, "[Back up to the NAS](2025-03-01-back-up-to-the-nas.md)");
  assert.deepEqual(second.entry.projects, ["house"]);
  assert.match(git(roll.root, "show", "--stat", "--format=", "HEAD"), /1 file changed/, "the old decision isn't touched");
  json(roll, ["decide", "Switch ISP", "--proposed"]);

  const view = json(roll, ["decisions"]);
  assert.deepEqual([view.current, view.proposed, view.other], [1, 1, 1]);
  assert.deepEqual(view.decisions.map((d: { status: string }) => d.status), ["proposed", "accepted"]);
  assert.match(run(roll, ["decisions"]).stdout, /1 replaced, deprecated or rejected decision isn't listed; see it with --all\./);
  assert.match(run(roll, ["decisions", "--all"]).stdout, /Back up to the NAS {2}superseded 2026-10-01 by Back up to B2/);
});

test("durations: ISO 8601 and the short forms people type; a bare number or a negative one isn't read", () => {
  const cases: [unknown, number | null][] = [
    ["PT1H30M", 5400], ["pt45m", 2700], ["P1D", 86_400], ["P1W", 604_800], ["1h30m", 5400], ["1h 30m", 5400], ["90m", 5400],
    ["45 min", 2700], ["1.5h", 5400], ["2 hours", 7200], ["1:30", 5400], ["0:45:30", 2730], ["1h, 15m", 4500],
    [90, null], ["90", null], ["-PT1H", null], ["soon", null], ["1x", null], ["", null], [null, null],
  ];
  for (const [v, want] of cases) assert.equal(durationSeconds(v), want, String(v));
  assert.deepEqual([5400, 2700, 7200, 0].map(formatSeconds), ["1h 30m", "45m", "2h", "0m"]);
});

test("time: totals overall and by period, project or field; unread durations are reported, not guessed; timeclock out", () => {
  const docs = [
    doc(".gitroll/events/2026-10-10-fence.md", "projects: [house]\nduration: PT1H30M", "# Fence"),
    doc(".gitroll/events/2026-10-12-gate.md", "projects: [house, garden]\nduration: 45m\nclient: Ada", "# Gate"),
    doc(".gitroll/events/2026-10-20-call.md", 'duration: "1:00"', "# Call"),
    doc(".gitroll/events/2026-10-21-odd.md", "duration: 90", "# Odd"),
    doc(".gitroll/notes/undated.md", "duration: 15m", "# Undated"),
  ];
  const all = timeSpent(docs);
  assert.deepEqual(all.total, { seconds: 5400 + 2700 + 3600 + 900, count: 4 });
  assert.deepEqual(all.skipped, [{ path: ".gitroll/events/2026-10-21-odd.md", title: "Odd", duration: "90" }]);
  assert.deepEqual(timeSpent(docs, "project").groups.map((g) => [g.key, g.seconds]), [["house", 8100], ["garden", 2700], ["(none)", 4500]], "most time first, (none) last");
  assert.deepEqual(timeSpent(docs, "week").groups.map((g) => g.key), ["2026-W41", "2026-W42", "2026-W43", "undated"]);
  assert.deepEqual(timeSpent(docs, "client").groups.map((g) => g.key), ["Ada", "(none)"]);
  const clock = toTimeclock(all.entries);
  assert.match(clock, /^i 2026-10-10 00:00:00 house {2}Fence\no 2026-10-10 01:30:00$/m);
  assert.match(clock, /^; Undated, so not clocked:\n; {3}Undated {2}15m/m);
});

test("gitroll log --duration and gitroll time", () => {
  const roll = GitRoll.init(tmp(), { name: "Home" });
  const logged = json(roll, ["log", "Rehung the gate", "-p", "house", "--duration", "1h30m", "--at", "2026-10-10"]);
  assert.equal(logged.entry.meta.duration, "1h30m");
  json(roll, ["log", "Call", "--duration", "1:30", "--at", "2026-10-11"]);
  assert.match(fs.readFileSync(path.join(roll.root, ".gitroll/events/2026-10-11-call.md"), "utf8"), /^duration: "1:30"$/m, "quoted, so YAML reads it as written");
  const bad = run(roll, ["log", "x", "--duration", "90", "--json"]);
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stderr).error.code, "INVALID_ARGUMENT");
  const view = json(roll, ["time", "--by", "project"]);
  assert.deepEqual(view.total, { seconds: 10_800, count: 2 });
  assert.deepEqual(view.groups.map((g: { key: string }) => g.key), ["house", "(none)"]);
  assert.match(run(roll, ["time"]).stdout, /Total {2}3h {2}2 entries/);
  assert.match(run(roll, ["time", "--timeclock"]).stdout, /^i 2026-10-10 00:00:00 house {2}Rehung the gate$/m);
  assert.equal(typeof json(roll, ["time", "--timeclock"]).timeclock, "string");
});
