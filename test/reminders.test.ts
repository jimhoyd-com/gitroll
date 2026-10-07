// Reminders: the Obsidian Reminder plugin's ⏰ (and its (@…) form) on to-do
// lines, `remind:` (an RFC 5545 duration from `start`, or an ISO 8601 date-time)
// on events and notes, `gitroll upcoming`, `gitroll reminders`, `gitroll remind`,
// and VALARMs in `gitroll calendar --ics`.

import "./helpers.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { addDays, taskDates } from "../src/core/calendar.ts";
import { parseEntry } from "../src/core/entry.ts";
import { escapeText, toICalendar, utcStamp } from "../src/core/ical.ts";
import { formatDuration, parseDuration, readRemind, reminderTime, reminderTitle, reminders, taskReminder, upcomingWithReminders } from "../src/core/reminders.ts";
import { completeTodo, todosIn } from "../src/core/todos.ts";
import { isoDate, isoDateIn, isTimeZone, zonedInstant } from "../src/core/util.ts";
import { commandSchema } from "../src/node/cli-contract.ts";
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
const note = (p: string, front: string, body = "# Untitled") => parseEntry(p, `---\n${front}\n---\n\n${body}\n`);
const todoFile = (lines: string[]) => todosIn(`# To do\n\n${lines.map((l) => `- ${l}`).join("\n")}\n`, ".gitroll/notes/todo.md");
/** A local time, so these hold in any time zone the tests are run in. */
const local = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min);

test("a to-do's reminder is read in the Reminder plugin's ⏰ form and its (@…) form", () => {
  assert.equal(taskReminder("Call the dentist ⏰ 2026-11-01 09:30")?.at, "2026-11-01T09:30:00");
  assert.equal(taskReminder("Call the dentist ⏰️ 2026-11-01 09:30")?.at, "2026-11-01T09:30:00", "with the emoji variation selector");
  assert.equal(taskReminder("Call the dentist (@2026-11-01 18:05)")?.at, "2026-11-01T18:05:00");
  assert.equal(taskReminder("Call the dentist (@2026-11-01)")?.at, "2026-11-01T09:00:00", "a day alone is at 09:00, the plugin's default");
  assert.equal(taskReminder("Pay ⏰ 2026-11-01")?.at, "2026-11-01T09:00:00");
  for (const none of ["Call (@ someone)", "Call ⏰ soon", "Call ⏰ 2026-02-30 09:00", "Call (@2026-11-01 09:00", "Email bob@2026-11-01.example", "Call ⏰ 2026-11-01 25:00x"]) {
    assert.equal(taskReminder(none)?.at ?? null, none.includes("25:00") ? "2026-11-01T09:00:00" : null, none);
  }
  assert.equal(taskDates("Renew passport 📅 2026-11-01 ⏰ 2026-10-25 09:00").text, "Renew passport", "⏰ ends the words like any Tasks field");
  assert.equal(taskDates("Water plants 🔁 every week ⏰ 2026-10-25 09:00").recurrenceText, "every week");
  assert.equal(reminderTitle("Call the dentist (@2026-11-01 09:00) #health"), "Call the dentist #health");
});

test("an RFC 5545 duration is read and written by its grammar, and never by backtracking", () => {
  for (const [input, out] of [["-PT1H", "-PT1H"], ["-P1D", "-P1D"], ["P1DT2H30M", "P1DT2H30M"], ["-P2W", "-P2W"], ["+PT15M", "PT15M"], ["PT0S", "PT0S"], ["-pt90m", "-PT1H30M"], ["PT1H5S", "PT1H0M5S"]]) {
    assert.equal(formatDuration(parseDuration(input)!), out, input);
  }
  for (const bad of ["", "P", "PT", "1H", "P1W2D", "PT1D", "P1H", "PT1M1H", "P1DT", "-P-1D", "PTH", "P1D1D"]) assert.equal(parseDuration(bad), null, bad);
  // Hostile input takes time in proportion to its length.
  const started = performance.now();
  assert.equal(parseDuration(`P${"1".repeat(200_000)}`), null);
  assert.equal(taskReminder("(@".repeat(100_000)), null);
  assert.equal(taskReminder(`⏰ ${"2026-".repeat(50_000)}`), null);
  assert.ok(performance.now() - started < 1000, "linear time");
});

test("remind: is a duration from start or an ISO 8601 date-time; anything else is reported", () => {
  assert.deepEqual(readRemind("-PT1H"), { kind: "duration", duration: { sign: -1, weeks: 0, days: 0, seconds: 3600 } });
  assert.deepEqual(readRemind("2026-11-01T08:00"), { kind: "time", at: "2026-11-01T08:00:00" });
  assert.deepEqual(readRemind("2026-11-01 08:00"), { kind: "time", at: "2026-11-01T08:00:00" });
  assert.deepEqual(readRemind("2026-11-01"), { kind: "time", at: "2026-11-01T09:00:00" });
  assert.deepEqual(readRemind("2026-11-01T08:00:00-05:00"), { kind: "time", at: "2026-11-01T08:00:00-05:00" }, "an offset is kept");
  assert.equal(readRemind("an hour before").kind, "problem");
  assert.equal(readRemind("-1h").kind, "problem");
  assert.equal(reminderTime("2026-11-01 09:00"), "2026-11-01 09:00");
  assert.equal(reminderTime("2026-11-01T09:00"), "2026-11-01 09:00");
  assert.equal(reminderTime("2026-11-01"), "2026-11-01 09:00");
  const zoned = new Date("2026-11-01T14:00:00Z");
  assert.equal(reminderTime("2026-11-01T14:00Z"), `${isoDate(zoned)} ${String(zoned.getHours()).padStart(2, "0")}:${String(zoned.getMinutes()).padStart(2, "0")}`, "an offset becomes this computer's local time");
  for (const bad of ["tomorrow", "2026-11-31 09:00", "2026-11-01 9am", ""]) assert.equal(reminderTime(bad), null, bad);
});

test("reminders: due ones first until what they're about is dealt with, then what's coming", () => {
  const now = local(2026, 10, 7, 12, 0);
  const todos = todoFile([
    "[ ] Call mom ⏰ 2026-10-07 09:00",
    "[x] Already done ⏰ 2026-10-06 09:00",
    "[ ] Pay rent (@2026-10-09)",
    "[ ] Far off ⏰ 2026-12-25 09:00",
  ]);
  const entries = [
    note(".gitroll/notes/dentist.md", "start: 2026-10-08T10:00:00\nremind: [-PT1H, -P1D]", "# Dentist"),
    note(".gitroll/notes/yesterday.md", "start: 2026-10-06T10:00:00\nremind: -PT1H", "# Yesterday's meeting"),
    note(".gitroll/notes/insurance.md", "remind: 2026-10-01T08:00", "# Insurance"),
    note(".gitroll/notes/yoga.md", "start: 2026-10-05T18:00:00\nrrule: FREQ=WEEKLY\nremind: -PT30M", "# Yoga"),
    note(".gitroll/notes/broken.md", "remind: [soon, -PT1H]", "# Broken"),
  ];
  const list = reminders(entries, todos, { now, to: "2026-11-01" });
  const shown = list.map((r) => `${r.due ? "due " : ""}${r.at || "?"} ${r.title}`);
  assert.deepEqual(shown, [
    "due 2026-10-01T08:00:00 Insurance",
    "due 2026-10-07T09:00:00 Call mom",
    "due 2026-10-07T10:00:00 Dentist",
    "2026-10-08T09:00:00 Dentist",
    "2026-10-09T09:00:00 Pay rent",
    "2026-10-12T17:30:00 Yoga",
    "2026-10-19T17:30:00 Yoga",
    "2026-10-26T17:30:00 Yoga",
    "? Broken",
    "? Broken",
  ]);
  assert.match(list.at(-2)!.problem!, /soon/);
  assert.match(list.at(-1)!.problem!, /no start/);
  const dentist = list.find((r) => r.title === "Dentist")!;
  assert.equal(dentist.id, ".gitroll/notes/dentist.md#remind-2@2026-10-07T10:00:00");
  assert.equal(dentist.about, "2026-10-08T10:00:00");
  assert.equal(dentist.remind, "-P1D");

  assert.deepEqual(reminders(entries, todos, { now, dueOnly: true }).map((r) => r.title), ["Insurance", "Call mom", "Dentist"]);
  // The day after the dentist, its reminders are over; the to-do's stays until it is ticked off.
  assert.deepEqual(reminders(entries, todos, { now: local(2026, 10, 9, 8), dueOnly: true }).map((r) => r.title), ["Insurance", "Call mom"]);

  const items = upcomingWithReminders(entries, todos, "2026-10-07", 30, now);
  assert.deepEqual(items.slice(0, 3).map((i) => [i.kind, i.title, i.due]), [["reminder", "Insurance", true], ["reminder", "Call mom", true], ["reminder", "Dentist", true]]);
  assert.ok(items.some((i) => i.kind === "event" && i.title === "Dentist"), "the calendar is still there");
});

test("with a time zone, local times and today are the person's, whatever the computer's clock says", () => {
  // 02:30 UTC on 8 October is still 7 October, 22:30, in Toronto.
  const now = new Date(Date.UTC(2026, 9, 8, 2, 30));
  assert.equal(isoDateIn(now, "America/Toronto"), "2026-10-07");
  assert.equal(isoDateIn(now, "Asia/Tokyo"), "2026-10-08");
  assert.equal(isoDateIn(now, "UTC"), "2026-10-08");
  assert.ok(isTimeZone("America/Toronto") && isTimeZone("UTC"));
  assert.ok(!isTimeZone("Mars/Olympus") && !isTimeZone("") && !isTimeZone(5));

  // Toronto's clocks: EDT (-04:00), the skipped hour in March, and the repeated hour in November.
  const wall = (y: number, mo: number, d: number, h: number, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);
  assert.equal(zonedInstant(wall(2026, 10, 7, 21), "America/Toronto"), Date.UTC(2026, 9, 8, 1));
  assert.equal(zonedInstant(wall(2026, 1, 7, 21), "America/Toronto"), Date.UTC(2026, 0, 8, 2));
  assert.equal(zonedInstant(wall(2026, 3, 8, 2, 30), "America/Toronto"), Date.UTC(2026, 2, 8, 7, 30), "a skipped time is the one after it");
  assert.equal(zonedInstant(wall(2026, 11, 1, 1, 30), "America/Toronto"), Date.UTC(2026, 10, 1, 5, 30), "a repeated time is the first");

  const todos = todoFile(["[ ] Call mom ⏰ 2026-10-07 22:00", "[ ] Call dad ⏰ 2026-10-07 23:00"]);
  const due = (timeZone: string) => reminders([], todos, { now, timeZone, dueOnly: true }).map((r) => r.title);
  assert.deepEqual(due("America/Toronto"), ["Call mom"], "22:00 has come in Toronto and 23:00 hasn't");
  assert.deepEqual(due("UTC"), ["Call mom", "Call dad"]);
  assert.deepEqual(due("Asia/Tokyo"), ["Call mom", "Call dad"]);

  const items = upcomingWithReminders([], todos, isoDateIn(now, "America/Toronto"), 30, now, "America/Toronto");
  assert.deepEqual(items.map((i) => [i.title, i.due ?? false]), [["Call mom", true], ["Call dad", false]]);

  assert.equal(reminderTime("2026-10-08T02:30:00Z", "America/Toronto"), "2026-10-07 22:30");
  assert.equal(reminderTime("2026-10-08 09:00", "America/Toronto"), "2026-10-08 09:00", "a local time stays as written");

  const ics = toICalendar([note(".gitroll/notes/x.md", "remind: 2026-10-07T22:00", "# Bins")], [], { timeZone: "America/Toronto" });
  assert.match(ics, /TRIGGER;VALUE=DATE-TIME:20261008T020000Z/);
});

test("ticking off a repeating to-do moves its ⏰ by as many days as its 📅", () => {
  const source = "# To do\n\n- [ ] Pay the bill 📅 2026-10-20 ⏰ 2026-10-19 18:00 🔁 every month\n";
  const { next } = completeTodo(source, 3, true, "2026-10-20");
  assert.equal(next!.text, "Pay the bill 📅 2026-11-20 ⏰ 2026-11-19 18:00 🔁 every month");
  const plugin = completeTodo("- [ ] Pay 📅 2026-10-20 (@2026-10-20 07:00) 🔁 every week\n", 1, true, "2026-10-20");
  assert.equal(plugin.next!.text, "Pay 📅 2026-10-27 (@2026-10-27 07:00) 🔁 every week");
});

test("calendar --ics carries each reminder as a VALARM, valid and folded", () => {
  const title = "A very long appointment title that will certainly need folding — ünïcödé included, twice over";
  const entries = [
    note(".gitroll/notes/dentist.md", "start: 2026-10-08T10:00:00\nrrule: FREQ=MONTHLY\nremind: [-PT1H, 2026-10-07T20:00]", `# ${title}`),
    note(".gitroll/notes/flight.md", "start: 2026-10-08T10:00:00-05:00\nremind: 2026-10-08T06:00:00-05:00", "# Flight"),
    note(".gitroll/notes/renewal.md", "start: 2026-11-01\nremind: -P2D", "# Renewal"),
    note(".gitroll/notes/insurance.md", "remind: 2026-10-01T08:00:00Z", "# Insurance"),
  ];
  const todos = todoFile(["[ ] Tax 📅 2026-10-20 ⏰ 2026-10-19 18:00 🔁 every month", "[ ] Call mom ⏰ 2026-10-07 09:00", "[x] Done ⏰ 2026-10-07 09:00"]);
  const ics = toICalendar(entries, todos, { now: new Date("2026-10-07T12:00:00Z") });

  // RFC 5545 §3.1: CRLF, no physical line over 75 octets, folded lines continue with a space.
  assert.ok(ics.endsWith("\r\n"));
  const physical = ics.slice(0, -2).split("\r\n");
  for (const line of physical) assert.ok(Buffer.byteLength(line) <= 75, line);
  assert.ok(physical.some((l) => l.startsWith(" ")), "the long title was folded");
  const lines = ics.replace(/\r\n /g, "").split("\r\n").filter(Boolean);
  assert.ok(lines.includes(`DESCRIPTION:${escapeText(title)}`), "unfolded, the alarm's text is whole");

  // Every VALARM is inside a VEVENT or VTODO, and says what and when.
  const stack: string[] = [];
  const alarms: string[][] = [];
  for (const line of lines) {
    if (line.startsWith("BEGIN:")) {
      const name = line.slice(6);
      if (name === "VALARM") {
        assert.ok(["VEVENT", "VTODO"].includes(stack.at(-1)!), "a VALARM sits in an event or to-do");
        alarms.push([]);
      }
      stack.push(name);
    } else if (line.startsWith("END:")) assert.equal(stack.pop(), line.slice(4));
    else if (stack.at(-1) === "VALARM") alarms.at(-1)!.push(line);
  }
  assert.equal(stack.length, 0);
  for (const a of alarms) {
    assert.ok(a.includes("ACTION:DISPLAY"), a.join());
    assert.equal(a.filter((l) => l.startsWith("TRIGGER")).length, 1);
    assert.ok(a.some((l) => l.startsWith("DESCRIPTION:")));
  }
  const triggers = alarms.map((a) => a.find((l) => l.startsWith("TRIGGER"))!);
  assert.deepEqual(triggers, [
    "TRIGGER:-PT1H", // a duration, relative to DTSTART, so it repeats with the RRULE
    "TRIGGER:-PT14H", // a local time beside a local start: relative, so it holds in any time zone
    "TRIGGER;VALUE=DATE-TIME:20261008T110000Z", // a time with an offset: absolute, in UTC
    "TRIGGER:-P2D", // from an all-day start
    "TRIGGER;VALUE=DATE-TIME:20261001T080000Z", // a note with no start: a VTODO with an absolute alarm
    "TRIGGER;RELATED=END:-PT6H", // a to-do's ⏰, relative to its DUE day
    `TRIGGER;VALUE=DATE-TIME:${utcStamp(local(2026, 10, 7, 9))}`, // no 📅: absolute, a local time read here
  ]);
  assert.match(ics, /BEGIN:VTODO\r\nUID:\.gitroll\/notes\/insurance\.md#remind\r\n/);
  assert.match(ics, /UID:\.gitroll\/notes\/todo\.md#todo-call-mom\r\nDTSTAMP:[0-9TZ]+\r\nSUMMARY:Call mom\r\nSTATUS:NEEDS-ACTION\r\n/, "an undated to-do with a reminder, without an invented DUE");
  assert.doesNotMatch(ics, /SUMMARY:Done/);
});

test("gitroll remind, reminders, upcoming and calendar --ics", () => {
  const roll = GitRoll.init(tmp(), { name: "Reminders" });
  const today = isoDate();
  const yesterday = addDays(today, -1);
  const soon = addDays(today, 3);

  const added = json(roll, ["remind", "Call the dentist", "--at", `${soon} 09:30`]);
  assert.equal(added.at, `${soon} 09:30`);
  assert.equal(added.todo.text, `Call the dentist ⏰ ${soon} 09:30`);
  assert.equal(added.entry.path, ".gitroll/notes/todo.md");
  assert.match(fs.readFileSync(path.join(roll.root, ".gitroll/notes/todo.md"), "utf8"), new RegExp(`- \\[ \\] Call the dentist ⏰ ${soon} 09:30\\n`));
  assert.match(roll.git(["log", "-1", "--format=%s"]), /^todo: Call the dentist/);
  json(roll, ["remind", "Water the plants", "--at", `${yesterday}T08:00`]);
  json(roll, ["note", "Car"]);
  assert.equal(json(roll, ["remind", "Book the MOT", "--at", soon, "--to", "car"]).todo.text, `Book the MOT ⏰ ${soon} 09:00`);

  for (const bad of [["remind", "No time"], ["remind", "Bad time", "--at", "soon"], ["remind", "--at", `${soon} 09:00`]]) {
    const r = run(roll, [...bad, "--json"]);
    assert.equal(r.status, 1, bad.join(" "));
    assert.equal(JSON.parse(r.stderr).error.code, "INVALID_ARGUMENT");
  }

  const list = json(roll, ["reminders"]);
  assert.deepEqual(list.map((r: { title: string; due: boolean }) => [r.title, r.due]), [["Water the plants", true], ["Book the MOT", false], ["Call the dentist", false]]);
  assert.match(list[0].id, /^\.gitroll\/notes\/todo\.md#todo-water-the-plants@/);
  assert.deepEqual(json(roll, ["reminders", "--due"]).map((r: { title: string }) => r.title), ["Water the plants"]);
  assert.match(run(roll, ["reminders"]).stdout, /Water the plants\s+\(due now\)/);

  const upcoming = json(roll, ["upcoming"]);
  assert.deepEqual(upcoming[0], { date: `${yesterday}T08:00:00`, kind: "reminder", title: "Water the plants", path: ".gitroll/notes/todo.md", line: 4, text: `Water the plants ⏰ ${yesterday} 08:00`, due: true });

  json(roll, ["done", "Water the plants"]);
  assert.deepEqual(json(roll, ["reminders", "--due"]), [], "ticking it off deals with it");

  const ics = run(roll, ["calendar", "--ics"]).stdout;
  assert.equal(ics.match(/BEGIN:VALARM/g)?.length, 2);

  const schema = commandSchema("remind").commands[0];
  assert.deepEqual(Object.keys(schema.options).sort(), ["at", "repo", "roll", "to"]);
  assert.equal(schema.effect, "local write");
  assert.ok(commandSchema("reminders").commands[0].options.due);
});
