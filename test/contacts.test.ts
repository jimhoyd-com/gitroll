// Contacts: people as records with vCard's (RFC 6350) field names, their
// history read from backlinks, birthdays and anniversaries every year on the
// calendar, and vCard 4.0 out and 3.0/4.0 in.

import "./helpers.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { calendarItems, upcoming, yearlyDate, yearlyOccurrences } from "../src/core/calendar.ts";
import { contacts, parseContentLine, parseVCards, planVcfImport, toVCard, unescapeText } from "../src/core/contacts.ts";
import { parseEntry } from "../src/core/entry.ts";
import { toICalendar } from "../src/core/ical.ts";
import { GitRoll } from "../src/node/repo.ts";
import { tmp } from "./helpers.ts";

const cli = fileURLToPath(new URL("../src/node/cli.ts", import.meta.url));
function run(roll: GitRoll, args: string[], input?: string) {
  return spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", cli, ...args, "-C", roll.root], { encoding: "utf8", cwd: tmp(), timeout: 10_000, input });
}
function json(roll: GitRoll, args: string[]) {
  const result = run(roll, [...args, "--json"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout);
}
const doc = (p: string, front: string, body = "# Untitled") => parseEntry(p, `---\n${front}\n---\n\n${body}\n`);

const ada = doc(
  ".gitroll/notes/people/ada-lovelace.md",
  'n: Lovelace;Ada;;Countess of\nemail: [ada@example.com, ada@engines.example]\ntel: "+44 20 7946 0000"\norg: Analytical Engines;Research\njobTitle: Programmer, first of many\nbday: 1815-12-10\nnote: "Wrote the notes; all of them.\\nSecond line, with a comma."',
  "# Ada Lovelace",
);
const grace = doc(".gitroll/notes/people/grace.md", "email: grace@example.com\nbday: --0229\nanniversary: 1970-06-15", "# Grace Hopper");
const lunch = doc(".gitroll/events/2026/2026-09-01-lunch.md", "", "# Lunch with Ada\n\nWith [Ada](../../notes/people/ada-lovelace.md).");
const call = doc(".gitroll/events/2026/2026-09-20-call.md", "", "# Call\n\n[Ada](../../notes/people/ada-lovelace.md) rang.");

test("contacts: vCard fields, sorted by name, with history from the events that link to them", () => {
  const view = contacts([grace, ada], [ada, grace, lunch, call]);
  assert.deepEqual(view.contacts.map((c) => c.name), ["Ada Lovelace", "Grace Hopper"]);
  const a = view.contacts[0];
  assert.deepEqual(a.emails, ["ada@example.com", "ada@engines.example"]);
  assert.deepEqual(a.tels, ["+44 20 7946 0000"]);
  assert.equal(a.org, "Analytical Engines, Research");
  assert.equal(a.jobTitle, "Programmer, first of many");
  assert.deepEqual(a.interactions.map((i) => i.title), ["Call", "Lunch with Ada"], "newest first");
  assert.equal(a.lastContacted, "2026-09-20");
  assert.equal(view.contacts[1].lastContacted, null);
});

test("contacts: a link in an event's front matter counts as one in its text", () => {
  const visit = doc(".gitroll/events/2026/2026-10-01-visit.md", 'with: "[Grace](../../notes/people/grace.md)"', "# Visit");
  const g = contacts([grace], [grace, visit]).contacts[0];
  assert.deepEqual(g.interactions.map((i) => i.title), ["Visit"]);
  assert.equal(g.lastContacted, "2026-10-01");
});

test("birthdays and anniversaries come round every year, with --MMDD and 29 February", () => {
  assert.deepEqual(yearlyDate("1815-12-10"), { year: 1815, month: 12, day: 10 });
  assert.deepEqual(yearlyDate("18151210"), { year: 1815, month: 12, day: 10 });
  assert.deepEqual(yearlyDate("--1210"), { year: null, month: 12, day: 10 });
  assert.deepEqual(yearlyDate("--12-10"), { year: null, month: 12, day: 10 });
  assert.deepEqual(yearlyDate("--0229"), { year: null, month: 2, day: 29 });
  assert.equal(yearlyDate("--0230"), null);
  assert.equal(yearlyDate("2023-02-29"), null);
  assert.equal(yearlyDate("someday"), null);
  assert.deepEqual(yearlyOccurrences({ year: null, month: 2, day: 29 }, "2026-01-01", "2028-12-31").map((o) => o.date), ["2026-02-28", "2027-02-28", "2028-02-29"]);
  assert.deepEqual(yearlyOccurrences({ year: 2030, month: 1, day: 1 }, "2026-01-01", "2032-01-01").map((o) => o.date), ["2030-01-01", "2031-01-01", "2032-01-01"], "never before it began");

  const soon = upcoming([ada, grace], [], "2026-12-01", 30);
  assert.deepEqual(soon.map((i) => [i.date, i.title, i.field, i.years, i.recurrence]), [["2026-12-10", "Ada Lovelace", "bday", 211, "every year"]]);
  const leap = calendarItems([grace], [], { from: "2027-01-01", to: "2028-12-31" }).filter((i) => i.field === "bday");
  assert.deepEqual(leap.map((i) => [i.date, i.years]), [["2027-02-28", undefined], ["2028-02-29", undefined]], "29 February is kept on the 28th in other years");
  const anniversary = calendarItems([grace], [], { from: "2026-06-01", to: "2026-06-30" });
  assert.deepEqual(anniversary.map((i) => [i.date, i.field, i.years]), [["2026-06-15", "anniversary", 56]]);
  assert.deepEqual(calendarItems([ada], [], {}).map((i) => i.date), ["1815-12-10"], "unbounded, it is listed once, where it began");

  const ics = toICalendar([ada, grace], [], { now: new Date("2026-10-07T00:00:00Z"), today: "2026-10-07" });
  assert.match(ics, /BEGIN:VEVENT\r\nUID:\.gitroll\/notes\/people\/ada-lovelace\.md#bday\r\nDTSTAMP:20261007T000000Z\r\nDTSTART;VALUE=DATE:18151210\r\nRRULE:FREQ=YEARLY\r\nSUMMARY:Ada Lovelace: bday\r\nTRANSP:TRANSPARENT\r\n/);
  assert.match(ics, /DTSTART;VALUE=DATE:20260228\r\nRRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1\r\n/, "a yearless 29 February starts this year, on the last day of February");
  assert.match(ics, /DTSTART;VALUE=DATE:19700615\r\nRRULE:FREQ=YEARLY\r\nSUMMARY:Grace Hopper: anniversary/);
});

test("vCard 4.0 out: CRLF, escaping, folding at 75 octets, and back in again", () => {
  const long = doc(".gitroll/notes/people/long.md", `note: "${"é".repeat(60)}"\nnickname: [Al, "Big, Al"]\ncategories: [friends, work]\nbday: --0704\nadr: ";;1 Main St, Apt 2;Springfield;IL;62701;USA"`, "# Al");
  const vcf = toVCard([ada, long]);
  assert.ok(vcf.endsWith("END:VCARD\r\n"));
  assert.ok(!/[^\r]\n/.test(vcf), "every line ends in CRLF");
  for (const line of vcf.split("\r\n")) assert.ok(Buffer.byteLength(line) <= 75, `${line} is at most 75 octets`);
  assert.match(vcf, /^BEGIN:VCARD\r\nVERSION:4\.0\r\nFN:Ada Lovelace\r\nN:Lovelace;Ada;;Countess of;\r\n/);
  assert.match(vcf, /EMAIL:ada@example\.com\r\nEMAIL:ada@engines\.example\r\nTEL:\+44 20 7946 0000\r\n/);
  assert.match(vcf, /ORG:Analytical Engines;Research\r\nTITLE:Programmer\\, first of many\r\nBDAY:18151210\r\n/);
  assert.match(vcf, /NOTE:Wrote the notes\\; all of them\.\\nSecond line\\, with a comma\.\r\n/);
  assert.match(vcf, /NICKNAME:Al,Big\\, Al\r\n/);
  assert.match(vcf, /ADR:;;1 Main St\\, Apt 2;Springfield;IL;62701;USA\r\n/);
  assert.match(vcf, /BDAY:--0704\r\n/);
  assert.match(vcf, /\r\n é/, "a long line folds, with a space, never inside a character");

  const plan = planVcfImport(vcf, []);
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(plan.create.map((r) => r.title), ["Ada Lovelace", "Al"]);
  assert.deepEqual(Object.fromEntries(plan.create[0].fields), {
    n: "Lovelace;Ada;;Countess of",
    email: ["ada@example.com", "ada@engines.example"],
    tel: "+44 20 7946 0000",
    org: "Analytical Engines;Research",
    jobTitle: "Programmer, first of many",
    bday: "1815-12-10",
    note: "Wrote the notes; all of them.\nSecond line, with a comma.",
  });
  assert.deepEqual(Object.fromEntries(plan.create[1].fields), {
    nickname: ["Al", "Big, Al"],
    adr: ";;1 Main St, Apt 2;Springfield;IL;62701;USA",
    bday: "--0704",
    categories: ["friends", "work"],
    note: "é".repeat(60),
  });
});

test("vCard 3.0 in: N without FN, bare types, groups, Apple's yearless birthdays, and a second import adds nothing", () => {
  const v3 = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    "N:Hopper;Grace;Brewster;Rear Admiral;",
    "item1.EMAIL;type=INTERNET;type=pref:grace@example.com",
    "TEL;CELL:+1 555 0100",
    'TEL;TYPE="voice,home";VALUE=uri:tel:+1-555-0101',
    "BDAY;X-APPLE-OMIT-YEAR=1604:1604-12-09",
    "ANNIVERSARY:19531015T231000Z",
    "URL:https\\://example.com/grace",
    "NOTE:Line one\\nline",
    "  two",
    "PHOTO;ENCODING=b;TYPE=JPEG:AAAA",
    "END:VCARD",
    "BEGIN:VCARD",
    "VERSION:3.0",
    "UID:urn:uuid:1234",
    "FN:Alan Turing",
    "END:VCARD",
    "BEGIN:VCARD",
    "VERSION:3.0",
    "TEL:+1 555 0102",
    "END:VCARD",
  ].join("\n");
  const plan = planVcfImport(v3, []);
  assert.deepEqual(plan.problems.map((p) => p.card), [3]);
  assert.deepEqual(plan.create.map((r) => [r.title, r.id]), [["Rear Admiral Grace Brewster Hopper", "rear-admiral-grace-brewster-hopper"], ["Alan Turing", "urn:uuid:1234"]]);
  assert.deepEqual(Object.fromEntries(plan.create[0].fields), {
    n: "Hopper;Grace;Brewster;Rear Admiral",
    email: "grace@example.com",
    tel: ["+1 555 0100", "+1-555-0101"],
    bday: "--1209",
    anniversary: "1953-10-15",
    url: "https://example.com/grace",
    note: "Line one\nline two",
  });
  assert.deepEqual(parseContentLine('TEL;TYPE="voice,home";VALUE=uri:tel:+1')!.params, { TYPE: ["voice,home"], VALUE: ["uri"] });
  assert.deepEqual(parseContentLine("TEL;CELL;HOME:1")!.params, { TYPE: ["CELL", "HOME"] });
  assert.equal(parseContentLine("no colon here"), null);
  assert.equal(unescapeText("a\\,b\\;c\\\\d\\Ne"), "a,b;c\\d\ne");
  assert.equal(parseVCards("BEGIN:VCARD\r\nFN:Open").length, 0, "a card never closed isn't read");

  const again = planVcfImport(v3, [doc(".gitroll/notes/people/alan-turing.md", "source: {adapter: vcf, id: \"urn:uuid:1234\"}", "# Alan Turing")]);
  assert.deepEqual(again.skip.map((r) => r.title), ["Alan Turing"]);
  assert.deepEqual(again.create.map((r) => r.title), ["Rear Admiral Grace Brewster Hopper"]);
});

test("the vCard reader takes time in proportion to its input", () => {
  for (const evil of [`BEGIN:VCARD\nX${";a=".repeat(50_000)}\nEND:VCARD`, `BEGIN:VCARD\nNOTE:${"\\".repeat(100_000)}\nEND:VCARD`, `BEGIN:VCARD\n${"N:;\n ".repeat(50_000)}\nEND:VCARD`, `BEGIN:VCARD\nX;a="${"x".repeat(100_000)}\nEND:VCARD`, "BEGIN:VCARD\n".repeat(50_000)]) {
    const t = performance.now();
    parseVCards(evil);
    planVcfImport(evil, []);
    assert.ok(performance.now() - t < 1500, "parsed quickly");
  }
});

test("gitroll contacts, --vcf, import vcf, and birthdays in upcoming and calendar --ics", () => {
  const roll = GitRoll.init(tmp(), { name: "People" });
  const file = path.join(tmp(), "people.vcf");
  fs.writeFileSync(file, toVCard([ada, grace]));
  const dry = json(roll, ["import", "vcf", file, "--dry-run"]);
  assert.deepEqual(dry.create, ["Ada Lovelace", "Grace Hopper"]);
  assert.equal(fs.existsSync(path.join(roll.root, ".gitroll/notes/people")), false, "a dry run writes nothing");
  const first = json(roll, ["import", "vcf", file]);
  assert.deepEqual(first.created, [".gitroll/notes/people/ada-lovelace.md", ".gitroll/notes/people/grace-hopper.md"]);
  assert.equal(roll.git(["log", "-1", "--format=%s"]).trim(), "import: 2 contacts into people");
  const written = fs.readFileSync(path.join(roll.root, ".gitroll/notes/people/grace-hopper.md"), "utf8");
  assert.match(written, /^---\nemail: grace@example\.com\nbday: --0229\nanniversary: 1970-06-15\nsource:\n {2}adapter: vcf\n {2}id: grace-hopper\n---\n\n# Grace Hopper\n$/);
  const again = json(roll, ["import", "vcf", file]);
  assert.deepEqual([again.created, again.skipped.map((s: { title: string }) => s.title)], [[], ["Ada Lovelace", "Grace Hopper"]], "importing twice creates each person once");
  assert.equal(run(roll, ["import", "vcf", "--json"]).status, 1, "vcf needs a file");

  fs.mkdirSync(path.join(roll.root, ".gitroll/events/2026"), { recursive: true });
  fs.writeFileSync(path.join(roll.root, ".gitroll/events/2026/2026-09-01-lunch.md"), "# Lunch\n\nWith [Ada](../../notes/people/ada-lovelace.md).\n");
  roll.commitPending();

  const view = json(roll, ["contacts"]);
  assert.equal(view.collection, "people");
  assert.deepEqual(view.contacts.map((c: { name: string; lastContacted: string | null }) => [c.name, c.lastContacted]), [["Ada Lovelace", "2026-09-01"], ["Grace Hopper", null]]);
  assert.equal(json(roll, ["contacts", "org:analytical"]).contacts.length, 1);
  assert.match(run(roll, ["contacts"]).stdout, /Ada Lovelace {2}ada@example\.com {2}\+44 20 7946 0000 {2}Analytical Engines, Research {2}last contacted 2026-09-01/);
  const vcf = run(roll, ["contacts", "--vcf"]);
  assert.equal(vcf.status, 0, vcf.stderr);
  assert.match(vcf.stdout, /^BEGIN:VCARD\r\nVERSION:4\.0\r\nFN:Ada Lovelace\r\n/);
  assert.equal(planVcfImport(vcf.stdout, []).create.length, 2, "what goes out comes back in");
  assert.equal(json(roll, ["contacts", "--vcf"]).vcf, vcf.stdout);

  const items = json(roll, ["upcoming", "--days", "366"]);
  assert.ok(items.some((i: { field?: string; title: string }) => i.field === "bday" && i.title === "Ada Lovelace"));
  assert.ok(items.some((i: { field?: string; title: string }) => i.field === "bday" && i.title === "Grace Hopper"), "a yearless 29 February is still within a year");
  assert.match(run(roll, ["upcoming", "--days", "366"]).stdout, /Ada Lovelace: bday {2}\(\d+ years, 🔁 every year\)/);
  const all = json(roll, ["calendar"]);
  assert.ok(all.some((i: { date: string; field?: string }) => i.field === "bday" && i.date === "1815-12-10"));
  assert.equal(all.filter((i: { field?: string; title: string }) => i.field === "bday" && i.title === "Grace Hopper").length, 1, "a birthday with no year: the next one");
  assert.match(json(roll, ["calendar", "--ics"]).ics, /RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1/);

  const schema = JSON.parse(spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", cli, "schema", "contacts", "--json"], { encoding: "utf8", cwd: tmp() }).stdout);
  assert.deepEqual(Object.keys(schema.commands[0].options), ["repo", "roll", "collection", "vcf"]);
});
