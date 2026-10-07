// Series: one numeric field over time, from the dated events and notes that
// have it. A view over files, like the ledger: nothing is written.

import "./helpers.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseEntry } from "../src/core/entry.ts";
import { isoWeek, numericFields, readingOf, series, sparkline } from "../src/core/series.ts";
import { commandSchema } from "../src/node/cli-contract.ts";
import { GitRoll } from "../src/node/repo.ts";
import { tmp } from "./helpers.ts";

const cli = fileURLToPath(new URL("../src/node/cli.ts", import.meta.url));
function run(roll: GitRoll, args: string[]) {
  return spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", cli, ...args, "-C", roll.root], { encoding: "utf8", cwd: tmp(), timeout: 10_000 });
}
const doc = (p: string, front: string, body = "# Untitled") => parseEntry(p, `---\n${front}\n---\n\n${body}\n`);

const docs = [
  doc(".gitroll/events/2026-03-30-oil.md", "Odometer: 48,900\ntags: [car]", "# Oil change"),
  doc(".gitroll/events/2026-01-05-tyres.md", "odometer: 47210\ntags: [car]", "# New tyres"),
  doc(".gitroll/events/2026-03-02-fuel.md", "odometer: 48500.5\ntags: [car]", "# Fuel"),
  doc(".gitroll/notes/car/inspection.md", "date: 2026-05-14\nodometer: 50100", "# Inspection"),
  doc(".gitroll/notes/car/undated.md", "odometer: 49000", "# Someone's guess"),
  doc(".gitroll/events/2026-04-01-typo.md", "odometer: about fifty thousand", "# Typo"),
  doc(".gitroll/events/2026-04-02-nothing.md", "tags: [car]", "# Washed it"),
];

test("readings are dated numbers, sorted by date, and a field is matched in any case", () => {
  const s = series(docs, "ODOMETER");
  assert.deepEqual(
    s.points.map((p) => [p.date, p.value]),
    [
      ["2026-01-05", 47210],
      ["2026-03-02", 48500.5],
      ["2026-03-30", 48900],
      ["2026-05-14", 50100],
    ],
  );
  assert.equal(s.points[3].path, ".gitroll/notes/car/inspection.md", "a note dated by date: is a reading");
  assert.equal(s.points[0].title, "New tyres");
  assert.equal(s.points[0].currency, null);
});

test("what has the field but can't be placed is counted, with the reason; what lacks it isn't", () => {
  const s = series(docs, "odometer");
  assert.equal(s.skipped.notNumeric, 1);
  assert.equal(s.skipped.undated, 1);
  assert.deepEqual(
    s.skipped.items.map((i) => [i.path, i.reason]),
    [
      [".gitroll/events/2026-04-01-typo.md", "not a number"],
      [".gitroll/notes/car/undated.md", "no date"],
    ],
  );
});

test("the summary: first, last, min, max, change, and a rate only over a long enough span", () => {
  const [s] = series(docs, "odometer").summaries;
  assert.equal(s.count, 4);
  assert.equal(s.first.value, 47210);
  assert.equal(s.last.value, 50100);
  assert.equal(s.min.value, 47210);
  assert.equal(s.max.value, 50100);
  assert.equal(s.change, 2890);
  assert.equal(s.days, 129);
  assert.equal(s.perDay, Number((2890 / 129).toPrecision(12)));
  assert.ok(Math.abs(s.perMonth! - (2890 / 129) * 30.436875) < 1e-6);

  const short = series(docs.slice(1, 3), "odometer").summaries[0];
  assert.equal(short.days, 56);
  const sameDay = series([doc(".gitroll/events/2026-01-01-a.md", "weight: 72.4"), doc(".gitroll/events/2026-01-01-b.md", "weight: 72.1")], "weight").summaries[0];
  assert.equal(sameDay.days, 0);
  assert.equal(sameDay.perDay, null, "no rate from readings on one day");
  assert.equal(sameDay.perMonth, null);
  assert.equal(sameDay.change, -0.3, "no float noise");
  const weeks = series([doc(".gitroll/events/2026-01-01-a.md", "weight: 72"), doc(".gitroll/events/2026-01-15-b.md", "weight: 71")], "weight").summaries[0];
  assert.equal(weeks.perDay, Number((-1 / 14).toPrecision(12)));
  assert.equal(weeks.perMonth, null, "under 28 days, no monthly rate");
});

test("--by keeps the last reading in each period, and the summary still covers every reading", () => {
  const readings = [
    doc(".gitroll/events/2026-03-02-a.md", "meter: 10"),
    doc(".gitroll/events/2026-03-20-b.md", "meter: 5"),
    doc(".gitroll/events/2026-03-28-c.md", "meter: 12"),
    doc(".gitroll/events/2026-04-03-d.md", "meter: 20"),
  ];
  const month = series(readings, "meter", "month");
  assert.deepEqual(
    month.points.map((p) => [p.period, p.value, p.readings]),
    [
      ["2026-03", 12, 3],
      ["2026-04", 20, 1],
    ],
  );
  assert.equal(month.summaries[0].min.value, 5, "the lowest reading, though no period ended on it");
  assert.deepEqual(series(readings, "meter", "year").points.map((p) => [p.period, p.value]), [["2026", 20]]);
  assert.deepEqual(series(readings, "meter", "week").points.map((p) => p.period), ["2026-W10", "2026-W12", "2026-W13", "2026-W14"]);
  assert.deepEqual(series(readings, "meter", "day").points.length, 4);
  assert.equal(isoWeek("2027-01-01"), "2026-W53", "a week belongs to its Thursday's year");
  assert.equal(isoWeek("2026-12-28"), "2026-W53");
  assert.equal(isoWeek("2025-12-29"), "2026-W01");
});

test("money is only compared within one currency, never converted", () => {
  const bills = [
    doc(".gitroll/events/2026-01-31-a.md", "bill: $80"),
    doc(".gitroll/events/2026-02-28-b.md", "bill: 95.50 EUR"),
    doc(".gitroll/events/2026-03-31-c.md", "bill: {value: 90, currency: usd}"),
    doc(".gitroll/events/2026-04-30-d.md", "bill: 7"),
  ];
  const s = series(bills, "bill");
  assert.deepEqual(
    s.summaries.map((x) => [x.currency, x.count, x.change]),
    [
      [null, 1, 0],
      ["EUR", 1, 0],
      ["USD", 2, 10],
    ],
  );
  assert.deepEqual(s.points.map((p) => p.currency), ["USD", "EUR", "USD", null]);
  const amounts = series([doc(".gitroll/events/2026-01-01-a.md", "amount: 12\ncurrency: GBP"), doc(".gitroll/events/2026-02-01-b.md", "amount: 15\ncurrency: GBP")], "amount");
  assert.deepEqual(amounts.summaries.map((x) => [x.currency, x.change]), [["GBP", 3]], "an event's amount carries its currency");
  const monthly = series(bills, "bill", "year");
  assert.deepEqual(monthly.points.map((p) => [p.period, p.currency, p.value]), [
    ["2026", "EUR", 95.5],
    ["2026", "USD", 90],
    ["2026", null, 7],
  ]);
});

test("what counts as a number", () => {
  assert.deepEqual(readingOf(5), { value: 5, currency: null });
  assert.deepEqual(readingOf("48,210"), { value: 48210, currency: null });
  assert.deepEqual(readingOf("£12.50"), { value: 12.5, currency: "GBP" });
  assert.deepEqual(readingOf({ value: 3, currency: "chf" }), { value: 3, currency: "CHF" });
  for (const v of [true, "2026-01-01", [1, 2], "12 kWh", "fifty", { sealed: true }, Number.NaN, ""]) assert.equal(readingOf(v), null, JSON.stringify(v));
});

test("the numeric fields a series can be drawn of, most used first", () => {
  const fields = numericFields([...docs, doc(".gitroll/events/2026-01-06-w.md", "weight: 72.4\namount: 5")]);
  assert.deepEqual(fields, [
    { name: "Odometer", count: 4 },
    { name: "amount", count: 1 },
    { name: "weight", count: 1 },
  ], "one field in any case, named as first written; undated and non-numeric values don't count");
});

test("a sparkline is one block per value, bucketed when there are too many", () => {
  assert.equal(sparkline([1, 2, 3, 4, 5, 6, 7, 8]), "▁▂▃▄▅▆▇█");
  assert.equal(sparkline([3, 3, 3]), "▄▄▄");
  assert.equal(sparkline([]), "");
  const long = sparkline(Array.from({ length: 500 }, (_, i) => i), 40);
  assert.equal([...long].length, 40);
  assert.equal([...long].at(-1), "█");
});

test("gitroll series: plain text with a sparkline, JSON, a query, --by, and argument errors", () => {
  const root = path.join(tmp(), "Roll");
  fs.mkdirSync(root, { recursive: true });
  const roll = GitRoll.init(root, { name: "Car" });
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  write(".gitroll/events/2026-01-05-tyres.md", "---\nodometer: 47210\ntags: [car]\n---\n\n# New tyres\n");
  write(".gitroll/events/2026-03-30-oil.md", "---\nodometer: 48900\ntags: [car]\n---\n\n# Oil change\n");
  write(".gitroll/events/2026-03-31-van.md", "---\nodometer: 120000\ntags: [van]\n---\n\n# Van service\n");
  write(".gitroll/notes/car/inspection.md", "---\ndate: 2026-05-14\nodometer: 50100\ntags: [car]\n---\n\n# Inspection\n");
  write(".gitroll/notes/car/guess.md", "---\nodometer: lots\ntags: [car]\n---\n\n# Guess\n");

  const json = run(roll, ["series", "odometer", "tag:car", "--json"]);
  assert.equal(json.status, 0, json.stderr);
  const view = JSON.parse(json.stdout);
  assert.deepEqual(view.points.map((p: { value: number }) => p.value), [47210, 48900, 50100], "the query filters like find");
  assert.equal(view.summaries[0].change, 2890);
  assert.deepEqual(view.skipped, { notNumeric: 1, undated: 0, items: [{ path: ".gitroll/notes/car/guess.md", title: "Guess", reason: "not a number" }] });

  const text = run(roll, ["series", "odometer", "tag:car"]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /odometer {2}[▁-█]{3}/);
  assert.match(text.stdout, /2026-05-14 {2}50,100 {2}Inspection/);
  assert.match(text.stdout, /Change {2}\+2,890/);
  assert.match(text.stdout, /a month/);
  assert.match(text.stdout, /Skipped 1 with odometer: 1 not a number\./);

  const monthly = JSON.parse(run(roll, ["series", "odometer", "--by", "month", "--json"]).stdout);
  assert.deepEqual(monthly.points.map((p: { period: string; value: number }) => [p.period, p.value]), [
    ["2026-01", 47210],
    ["2026-03", 120000],
    ["2026-05", 50100],
  ]);
  assert.match(run(roll, ["series", "odometer", "--by", "month"]).stdout, /2026-03 .*\(last of 2\)/);

  assert.match(run(roll, ["series", "weight"]).stdout, /Nothing dated has a number in weight\./);
  const badBy = run(roll, ["series", "odometer", "--by", "fortnight", "--json"]);
  assert.equal(badBy.status, 1);
  assert.equal(JSON.parse(badBy.stderr).error.code, "INVALID_ARGUMENT");
  assert.equal(JSON.parse(run(roll, ["series", "--json"]).stderr).error.code, "INVALID_ARGUMENT", "a field is required");
  assert.equal(JSON.parse(run(roll, ["series", "a:b", "--json"]).stderr).error.code, "INVALID_ARGUMENT");

  const schema = commandSchema("series");
  assert.equal(schema.commands[0].name, "series");
  assert.deepEqual(Object.keys(schema.commands[0].options).sort(), ["by", "repo", "roll"]);
});
