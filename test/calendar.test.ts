// The calendar: iCalendar field names (start, end, location, rrule), Obsidian
// Tasks dates on to-do lines (📅, 🔁), due-ish fields, `gitroll upcoming`, and
// `gitroll calendar --ics`.

import "./helpers.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RRuleError, addDays, calendarItems, formatRRule, nextDue, occurrences, parseRRule, parseRecurrence, taskDates, upcoming } from "../src/core/calendar.ts";
import { parseEntry } from "../src/core/entry.ts";
import { escapeText, foldLine, toICalendar } from "../src/core/ical.ts";
import { completeTodo, todosIn } from "../src/core/todos.ts";
import { isoDate } from "../src/core/util.ts";
import { GitRoll } from "../src/node/repo.ts";
import { tmp } from "./helpers.ts";

const cli = fileURLToPath(new URL("../src/node/cli.ts", import.meta.url));
function run(roll: GitRoll, args: string[]) {
  return spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", cli, ...args, "-C", roll.root], { encoding: "utf8", cwd: tmp(), timeout: 10_000 });
}
function json(roll: GitRoll, args: string[]) {
  const result = run(roll, [...args, "--json"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout);
}
const all = (start: string, rule: string, to = "2200-01-01") => occurrences(start, parseRRule(rule), "0000-01-01", to);

test("an RRULE is read in the supported subset, and anything else is refused rather than guessed", () => {
  assert.deepEqual(parseRRule("FREQ=MONTHLY;INTERVAL=6"), { freq: "MONTHLY", interval: 6 });
  assert.deepEqual(parseRRule("RRULE:freq=weekly;byday=FR,MO;count=4"), { freq: "WEEKLY", interval: 1, count: 4, byday: [0, 4] });
  assert.deepEqual(parseRRule("FREQ=DAILY;UNTIL=20261231T235959Z").until, { day: "2026-12-31", time: "235959", utc: true });
  for (const bad of ["", "INTERVAL=2", "FREQ=HOURLY", "FREQ=MONTHLY;BYMONTHDAY=1", "FREQ=MONTHLY;BYDAY=MO", "FREQ=DAILY;COUNT=2;UNTIL=20260101", "FREQ=DAILY;INTERVAL=0", "FREQ=DAILY;UNTIL=20260230", "FREQ=WEEKLY;BYDAY=XX"]) {
    assert.throws(() => parseRRule(bad), RRuleError, bad);
  }
  assert.equal(formatRRule(parseRRule("FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261231"), "2026-10-05T09:00:00Z"), "FREQ=WEEKLY;UNTIL=20261231T235959Z;BYDAY=MO,WE");
  assert.equal(formatRRule(parseRRule("FREQ=YEARLY;UNTIL=20301231T120000Z"), "2026-10-05"), "FREQ=YEARLY;UNTIL=20301231");
});

test("monthly on the 31st skips short months, and yearly on 29 February waits for a leap year (RFC 5545)", () => {
  assert.deepEqual(all("2026-01-31", "FREQ=MONTHLY;COUNT=5"), ["2026-01-31", "2026-03-31", "2026-05-31", "2026-07-31", "2026-08-31"]);
  assert.deepEqual(all("2026-01-30", "FREQ=MONTHLY;COUNT=3"), ["2026-01-30", "2026-03-30", "2026-04-30"]);
  assert.deepEqual(all("2024-02-29", "FREQ=YEARLY;COUNT=3"), ["2024-02-29", "2028-02-29", "2032-02-29"]);
  assert.deepEqual(all("2096-02-29", "FREQ=YEARLY;COUNT=2"), ["2096-02-29", "2104-02-29"], "2100 is not a leap year");
  assert.deepEqual(all("2026-10-01", "FREQ=MONTHLY;INTERVAL=3;COUNT=4"), ["2026-10-01", "2027-01-01", "2027-04-01", "2027-07-01"]);
  assert.deepEqual(all("2026-12-31", "FREQ=DAILY;COUNT=3"), ["2026-12-31", "2027-01-01", "2027-01-02"]);
});

test("COUNT counts from the start, UNTIL is inclusive, and a window only trims what is shown", () => {
  assert.deepEqual(all("2026-01-01", "FREQ=DAILY;INTERVAL=2;UNTIL=20260109"), ["2026-01-01", "2026-01-03", "2026-01-05", "2026-01-07", "2026-01-09"]);
  assert.deepEqual(occurrences("2026-01-01", parseRRule("FREQ=MONTHLY;COUNT=3"), "2026-02-15", "2030-01-01"), ["2026-03-01"]);
  assert.deepEqual(occurrences("2026-01-01", parseRRule("FREQ=WEEKLY"), "2026-01-10", "2026-01-31"), ["2026-01-15", "2026-01-22", "2026-01-29"]);
  assert.deepEqual(all("2026-01-31", "FREQ=MONTHLY;UNTIL=20260430"), ["2026-01-31", "2026-03-31"]);
  assert.deepEqual(all("2026-01-01T09:30:00-05:00", "FREQ=YEARLY;COUNT=2"), ["2026-01-01T09:30:00-05:00", "2027-01-01T09:30:00-05:00"], "a time is kept");
  assert.equal(all("2026-01-01", "FREQ=DAILY", "2026-12-31").length, 365, "an endless rule stops at the window");
});

test("weekly BYDAY walks Monday-based weeks, honours INTERVAL, and never goes before the start", () => {
  // 2026-10-07 is a Wednesday.
  assert.deepEqual(all("2026-10-07", "FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=4"), ["2026-10-07", "2026-10-09", "2026-10-12", "2026-10-14"]);
  assert.deepEqual(all("2026-10-07", "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;COUNT=4"), ["2026-10-09", "2026-10-19", "2026-10-23", "2026-11-02"]);
  assert.deepEqual(all("2026-10-11", "FREQ=WEEKLY;BYDAY=SU;COUNT=2"), ["2026-10-11", "2026-10-18"], "Sunday ends a Monday week");
});

test("Obsidian Tasks dates: 📅 and 🔁 read from a to-do, and the next date moves on as Tasks does", () => {
  assert.deepEqual(taskDates("Renew passport 📅 2026-11-01"), { due: "2026-11-01", recurrence: null, recurrenceText: null, text: "Renew passport" });
  const t = taskDates("Replace filter 🔁 every 3 months 📅 2026-10-01 ⏫");
  assert.equal(t.due, "2026-10-01");
  assert.deepEqual(t.recurrence, { every: 3, unit: "month", whenDone: false, text: "every 3 months" });
  assert.equal(t.text, "Replace filter");
  assert.equal(taskDates("Bad 📅 2026-02-30").due, null);
  assert.equal(parseRecurrence("every week on Monday"), null, "a phrasing GitRoll doesn't read is left alone");
  assert.deepEqual(parseRecurrence("every day when done"), { every: 1, unit: "day", whenDone: true, text: "every day when done" });
  const month = parseRecurrence("every month")!;
  assert.equal(nextDue("2026-01-31", month, "2026-02-03"), "2026-02-28", "the last day of a shorter month");
  assert.equal(nextDue("2024-01-31", month, "2024-02-03"), "2024-02-29");
  assert.equal(nextDue("2024-02-29", parseRecurrence("every year")!, "x"), "2025-02-28");
  assert.equal(nextDue("2026-12-30", parseRecurrence("every 2 days")!, "x"), "2027-01-01");
  assert.equal(nextDue("2026-10-01", parseRecurrence("every week when done")!, "2026-10-05"), "2026-10-12");
});

test("ticking off a recurring to-do adds the next one below it, and nothing else changes", () => {
  const source = "# Chores\r\n\r\n  * [ ] Replace filter 📅 2026-01-31 🔁 every month #home\r\n- [ ] Plain one 📅 2026-02-01\r\n";
  const { source: after, next } = completeTodo(source, 3, true, "2026-02-02");
  assert.equal(after, "# Chores\r\n\r\n  * [x] Replace filter 📅 2026-01-31 🔁 every month #home\r\n  * [ ] Replace filter 📅 2026-02-28 🔁 every month #home\r\n- [ ] Plain one 📅 2026-02-01\r\n");
  assert.deepEqual(next, { path: "", line: 4, text: "Replace filter 📅 2026-02-28 🔁 every month #home", done: false });
  assert.deepEqual(todosIn(after).map((t) => [t.line, t.done]), [[3, true], [4, false], [5, false]]);

  const plain = completeTodo(source, 4, true, "2026-02-02");
  assert.equal(plain.next, null);
  assert.equal(plain.source, source.replace("- [ ] Plain", "- [x] Plain"), "a to-do that doesn't repeat is a one-character edit");
  assert.equal(completeTodo(after, 3, false, "2026-02-02").next, null, "undoing adds nothing");
  const doneDate = completeTodo("- [ ] Water plants 📅 2026-03-01 🔁 every week ✅ 2026-02-20\n", 1, true, "2026-03-01");
  assert.equal(doneDate.source.split("\n")[1], "- [ ] Water plants 📅 2026-03-08 🔁 every week", "the copy has no done date");
});

const ev = (p: string, front: string, body = "# Untitled") => parseEntry(p, `---\n${front}\n---\n\n${body}\n`);

test("upcoming lists starts and their repeats, events dated ahead, dated to-dos and due-ish fields, by date", () => {
  const docs = [
    ev(".gitroll/events/2026-11-04-dentist.md", "start: 2026-11-04T09:30:00-05:00\nend: 2026-11-04T10:30:00-05:00\nlocation: Main St Dental", "# Dentist"),
    ev(".gitroll/notes/hvac-filter.md", "rrule: FREQ=MONTHLY;INTERVAL=1\nstart: 2026-09-01", "# Replace HVAC filter"),
    ev(".gitroll/notes/inventory/heat-pump.md", "warranty: 2026-10-20\nexpires: 2030-01-01", "# Heat pump"),
    ev(".gitroll/events/2026-10-15-trip.md", "tags: [x]", "# Trip"),
    ev(".gitroll/events/2026-10-01-past.md", "tags: [x]", "# Past"),
    ev(".gitroll/notes/broken.md", "start: 2026-10-10\nrrule: FREQ=MONTHLY;BYSETPOS=1", "# Broken rule"),
  ];
  const todos = [
    { path: ".gitroll/notes/todo.md", line: 3, text: "Renew passport 📅 2026-10-30", done: false },
    { path: ".gitroll/notes/todo.md", line: 4, text: "Overdue thing 📅 2026-10-01", done: false },
    { path: ".gitroll/notes/todo.md", line: 5, text: "Finished 📅 2026-10-12", done: true },
  ];
  const items = upcoming(docs, todos, "2026-10-07", 30);
  assert.deepEqual(items.map((i) => [i.date.slice(0, 10), i.kind, i.title]), [
    ["2026-10-01", "todo", "Overdue thing"],
    ["2026-10-10", "event", "Broken rule"],
    ["2026-10-15", "event", "Trip"],
    ["2026-10-20", "field", "Heat pump"],
    ["2026-10-30", "todo", "Renew passport"],
    ["2026-11-01", "occurrence", "Replace HVAC filter"],
    ["2026-11-04", "event", "Dentist"],
  ]);
  assert.equal(items[0].overdue, true);
  assert.match(items[1].problem!, /BYSETPOS/);
  assert.equal(items[3].field, "warranty");
  assert.equal(items[6].location, "Main St Dental");
  assert.equal(calendarItems(docs, [], { from: "2026-12-01", to: "2026-12-31" }).length, 1, "only the December filter change");
});

const unfold = (ics: string) => ics.replace(/\r\n /g, "");

test("calendar --ics is RFC 5545: CRLF, folded at 75 octets, escaped, an RRULE not an expansion, a UID per item", () => {
  const long = "Dentist; then lunch, maybe — with a very long title that has to be folded somewhere ünïcödé 🦷🦷🦷 and more\\words";
  const docs = [
    ev(".gitroll/events/2026-11-04-dentist.md", `start: 2026-11-04T09:30:00-05:00\nend: 2026-11-04T10:30:00-05:00\nlocation: "[Main St, Dental](../notes/places/dental.md)"\ntitle: "${long.replace(/\\/g, "\\\\")}"`),
    ev(".gitroll/notes/hvac-filter.md", "rrule: FREQ=MONTHLY;INTERVAL=3;UNTIL=20271231\nstart: 2026-10-01", "# Replace HVAC filter"),
    ev(".gitroll/notes/standup.md", "rrule: FREQ=WEEKLY;BYDAY=MO\nstart: 2026-10-05T09:00:00", "# Standup"),
    ev(".gitroll/notes/inventory/heat-pump.md", "warranty: 2029-06-02", "# Heat pump"),
    ev(".gitroll/events/2026-11-20-party.md", "end: 2026-11-21", "# Party"),
    ev(".gitroll/events/2020-01-01-old.md", "tags: [x]", "# Old"),
  ];
  const todos = [
    { path: ".gitroll/notes/todo.md", line: 3, text: "Replace filter 📅 2026-10-01 🔁 every 3 months", done: false },
    { path: ".gitroll/notes/todo.md", line: 4, text: "Replace filter 📅 2026-12-01", done: false },
  ];
  const ics = toICalendar(docs, todos, { name: "Home, sweet", now: new Date("2026-10-07T12:00:00Z"), today: "2026-10-07" });
  assert.ok(ics.endsWith("\r\n"));
  assert.doesNotMatch(ics.replace(/\r\n/g, ""), /[\r\n]/, "every line ends in CRLF");
  for (const line of ics.split("\r\n")) assert.ok(new TextEncoder().encode(line).length <= 75, `too long: ${line}`);
  const lines = unfold(ics).split("\r\n").filter(Boolean);
  assert.deepEqual(lines.slice(0, 4), ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//GitRoll//GitRoll//EN", "CALSCALE:GREGORIAN"]);
  assert.equal(lines.at(-1), "END:VCALENDAR");
  assert.ok(lines.includes("NAME:Home\\, sweet"));
  assert.equal(lines.filter((l) => l === "BEGIN:VEVENT").length, 5, "dentist, filter, standup, warranty, party (not the old event)");
  assert.equal(lines.filter((l) => l === "BEGIN:VTODO").length, 2);
  assert.ok(lines.includes("DTSTART:20261104T143000Z"), "a time with an offset is written in UTC");
  assert.ok(lines.includes("DTEND:20261104T153000Z"));
  assert.ok(lines.includes("DTSTART:20261005T090000"), "a time without a zone floats");
  assert.ok(lines.includes("DTSTART;VALUE=DATE:20261001"));
  assert.ok(lines.includes("DTEND;VALUE=DATE:20261122"), "an all-day end is exclusive in iCalendar");
  assert.ok(lines.includes("RRULE:FREQ=MONTHLY;INTERVAL=3;UNTIL=20271231"));
  assert.ok(lines.includes("RRULE:FREQ=WEEKLY;BYDAY=MO"));
  assert.ok(lines.includes("RRULE:FREQ=MONTHLY;INTERVAL=3"), "the 🔁 to-do repeats too");
  assert.ok(lines.includes("LOCATION:Main St\\, Dental"));
  assert.ok(lines.includes(`SUMMARY:${escapeText(long)}`));
  assert.ok(lines.includes("SUMMARY:Heat pump: warranty"));
  assert.ok(lines.includes("DUE;VALUE=DATE:20261201"));
  const uids = lines.filter((l) => l.startsWith("UID:"));
  assert.equal(new Set(uids).size, uids.length, "UIDs are unique");
  assert.ok(uids.includes("UID:.gitroll/notes/hvac-filter.md#start"));
  assert.equal(lines.filter((l) => l.startsWith("DTSTAMP:")).length, 7);
  assert.ok(lines.includes("DTSTAMP:20261007T120000Z"));
  assert.equal(lines.filter((l) => l.startsWith("BEGIN:")).length, lines.filter((l) => l.startsWith("END:")).length);
});

test("escaping and folding follow RFC 5545 to the octet", () => {
  assert.equal(escapeText("a\\b;c,d\ne\r\nf\tg"), "a\\\\b\\;c\\,d\\ne\\nfg");
  const line = `SUMMARY:${"é".repeat(60)}`;
  const folded = foldLine(line);
  for (const part of folded.split("\r\n")) assert.ok(new TextEncoder().encode(part).length <= 75);
  assert.equal(folded.replace(/\r\n /g, ""), line, "unfolding gives the line back");
  assert.ok(!folded.split("\r\n").some((p) => p.includes("�")), "no character is split");
  assert.equal(foldLine("x".repeat(75)), "x".repeat(75));
  assert.equal(foldLine("x".repeat(76)), `${"x".repeat(75)}\r\n x`);
});

test("gitroll upcoming, calendar --ics and done on a recurring to-do", () => {
  const roll = GitRoll.init(tmp(), { name: "Calendar" });
  const today = isoDate();
  const soon = addDays(today, 3);
  const later = addDays(today, 45);
  fs.mkdirSync(path.join(roll.root, ".gitroll/notes"), { recursive: true });
  fs.writeFileSync(path.join(roll.root, ".gitroll/notes/todo.md"), `# To do\n\n- [ ] Renew passport 📅 ${soon}\n- [ ] Replace filter 📅 ${soon} 🔁 every 2 weeks\n- [ ] Far off 📅 ${later}\n`);
  fs.writeFileSync(path.join(roll.root, ".gitroll/notes/insurance.md"), `---\nrenewal: ${addDays(today, 10)}\n---\n\n# Insurance\n`);
  roll.commitPending();

  const items = json(roll, ["upcoming"]);
  assert.deepEqual(items.map((i: { title: string }) => i.title), ["Renew passport", "Replace filter", "Insurance"]);
  assert.equal(json(roll, ["upcoming", "--days", "60"]).length, 4);
  assert.equal(run(roll, ["upcoming", "--days", "soon", "--json"]).status, 1);
  assert.match(run(roll, ["upcoming"]).stdout, /Renew passport/);

  const ics = run(roll, ["calendar", "--ics"]);
  assert.equal(ics.status, 0, ics.stderr);
  assert.match(ics.stdout, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics.stdout, /RRULE:FREQ=WEEKLY;INTERVAL=2\r\n/);
  assert.equal(json(roll, ["calendar"]).length, 4);

  const done = json(roll, ["done", "Replace filter"]);
  assert.equal(done.todo.done, true);
  assert.equal(done.next.text, `Replace filter 📅 ${addDays(soon, 14)} 🔁 every 2 weeks`);
  assert.equal(done.next.line, 5);
  const text = fs.readFileSync(path.join(roll.root, ".gitroll/notes/todo.md"), "utf8");
  assert.match(text, new RegExp(`- \\[x\\] Replace filter 📅 ${soon} 🔁 every 2 weeks\\n- \\[ \\] Replace filter 📅 ${addDays(soon, 14)} 🔁 every 2 weeks\\n- \\[ \\] Far off`));
  assert.equal(roll.git(["status", "--porcelain"]).trim(), "", "ticked and added in one commit");
});
