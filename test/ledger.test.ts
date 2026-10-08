// The ledger: totals of `amount` and `price` per currency, grouped, and an
// hledger journal. A view over files, never accounting.

import "./helpers.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseEntry } from "../src/core/entry.ts";
import { ledger, priceOf, toHledger, totalsByCurrency } from "../src/core/ledger.ts";
import { GitRoll } from "../src/node/repo.ts";
import { tmp } from "./helpers.ts";

const cli = fileURLToPath(new URL("../src/node/cli.ts", import.meta.url));
function run(roll: GitRoll, args: string[]) {
  return spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", cli, ...args, "-C", roll.root], { encoding: "utf8", cwd: tmp(), timeout: 10_000 });
}
const doc = (p: string, front: string, body = "# Untitled") => parseEntry(p, `---\n${front}\n---\n\n${body}\n`);

const docs = [
  doc(".gitroll/events/2026-08-02-roof.md", "amount: 1240\nprojects: [house]\ntags: [repair]", "# Roof patched"),
  doc(".gitroll/events/2026-09-15-ac.md", "amount: 325\nprojects: [house]", "# AC serviced"),
  doc(".gitroll/events/2026-09-20-train.md", "amount: 41.9\ncurrency: EUR\ntags: [travel]", "# Train; to Lyon"),
  doc(".gitroll/events/2026-09-21-coffee.md", "amount: 0.1\ncurrency: EUR\ntags: [travel]", "# Coffee"),
  doc(".gitroll/events/2026-09-22-tea.md", "amount: 0.2\ncurrency: EUR", "# Tea"),
  doc(".gitroll/notes/inventory/heat-pump.md", "price: 1899\npriceCurrency: USD\npurchaseDate: 2024-06-02\nvendor: Cool Co", "# Heat pump"),
  doc(".gitroll/notes/inventory/kettle.md", "price: £30", "# Kettle"),
  doc(".gitroll/events/2026-09-23-note.md", "tags: [nothing]", "# No money here"),
];

test("a record's price reads schema.org's priceCurrency, money text, or {value, currency}", () => {
  assert.deepEqual(priceOf({ price: 1899, priceCurrency: "usd" }), { value: 1899, currency: "USD" });
  assert.deepEqual(priceOf({ price: "$12.50" }), { value: 12.5, currency: "USD" });
  assert.deepEqual(priceOf({ price: "99.50 EUR", priceCurrency: "GBP" }), { value: 99.5, currency: "EUR" }, "a price that names its currency keeps it");
  assert.deepEqual(priceOf({ price: "1,200", priceCurrency: "JPY" }), { value: 1200, currency: "JPY" });
  assert.deepEqual(priceOf({ price: { value: 5, currency: "chf" } }), { value: 5, currency: "CHF" });
  assert.equal(priceOf({ price: "cheap" }), null);
});

test("totals are kept per currency and never mixed, and add up money without float noise", () => {
  const view = ledger(docs);
  assert.deepEqual(view.totals, [
    { currency: "EUR", total: 42.2, count: 3 },
    { currency: "GBP", total: 30, count: 1 },
    { currency: "USD", total: 3464, count: 3 },
  ]);
  assert.equal(view.entries.length, 7, "only what has an amount or a price");
  assert.equal(view.entries.find((e) => e.title === "Heat pump")!.date, "2024-06-02", "a record is dated by purchaseDate");
  assert.equal(view.entries.at(-1)!.date, null, "undated last");
  assert.deepEqual(totalsByCurrency([{ value: 0.1, currency: "EUR" }, { value: 0.2, currency: "EUR" }]), [{ currency: "EUR", total: 0.3, count: 2 }]);
});

test("grouped by month, year, project, tag or any field", () => {
  const month = ledger(docs, "month");
  assert.deepEqual(month.groups.map((g) => [g.key, g.totals.map((t) => `${t.total} ${t.currency}`)]), [
    ["2024-06", ["1899 USD"]],
    ["2026-08", ["1240 USD"]],
    ["2026-09", ["42.2 EUR", "325 USD"]],
    ["undated", ["30 GBP"]],
  ]);
  assert.deepEqual(ledger(docs, "year").groups.map((g) => g.key), ["2024", "2026", "undated"]);
  assert.deepEqual(ledger(docs, "project").groups.map((g) => [g.key, g.count]), [["house", 2], ["(none)", 5]]);
  assert.deepEqual(ledger(docs, "tag").groups.map((g) => [g.key, g.count]), [["repair", 1], ["travel", 2], ["(none)", 4]]);
  assert.deepEqual(ledger(docs, "vendor").groups.map((g) => g.key), ["Cool Co", "(none)"]);
});

test("--hledger writes a journal: an expense per entry, balanced by assets:unknown", () => {
  const journal = toHledger(ledger(docs).entries);
  assert.match(journal, /^; Transactions from a GitRoll log\. GitRoll is the source of these, not an accounting system/);
  assert.ok(journal.includes("2026-09-15 AC serviced\n    ; source: .gitroll/events/2026-09-15-ac.md\n    expenses:house  325 USD\n    assets:unknown\n"));
  assert.ok(journal.includes("2026-09-20 Train, to Lyon\n"), "a semicolon would start a comment");
  assert.ok(journal.includes("    expenses:travel  41.9 EUR\n"));
  assert.ok(journal.includes("    expenses:unknown  0.2 EUR\n"));
  assert.ok(journal.includes("2024-06-02 Heat pump\n"));
  assert.ok(journal.includes("; Undated, so not in this journal:\n;   Kettle  30 GBP"));
  for (const block of journal.split("\n\n").filter((b) => /^\d{4}-/.test(b))) {
    const postings = block.split("\n").filter((l) => /^ {4}[a-z]/.test(l));
    assert.equal(postings.length, 2, block);
    assert.match(postings[0], /^ {4}expenses:[^\s:;]+ {2}-?\d+(\.\d+)? [A-Z]{3}$/);
    assert.equal(postings[1], "    assets:unknown");
  }
});

test("gitroll ledger with a query, --by and --hledger", () => {
  const roll = GitRoll.init(tmp(), { name: "Ledger" });
  roll.addEntry({ text: "AC serviced", date: "2026-09-15", amount: { value: 325, currency: "USD" }, projects: ["house"] });
  roll.addEntry({ text: "Train", date: "2026-09-20", amount: { value: 41.9, currency: "EUR" } });
  fs.mkdirSync(path.join(roll.root, ".gitroll/notes/inventory"), { recursive: true });
  fs.writeFileSync(path.join(roll.root, ".gitroll/notes/inventory/kettle.md"), "---\nprice: 30\npriceCurrency: GBP\n---\n\n# Kettle\n");
  const json = (args: string[]) => {
    const r = run(roll, [...args, "--json"]);
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  assert.deepEqual(json(["ledger"]).totals.map((t: { currency: string }) => t.currency), ["EUR", "GBP", "USD"]);
  assert.deepEqual(json(["ledger", "project:house"]).totals, [{ currency: "USD", total: 325, count: 1 }]);
  assert.deepEqual(json(["ledger", "--by", "month"]).groups.map((g: { key: string }) => g.key), ["2026-09", "undated"]);
  const text = run(roll, ["ledger", "--by", "month"]);
  assert.match(text.stdout, /2026-09 +41\.90 EUR · 325\.00 USD/);
  assert.match(text.stdout, /nothing is converted/);
  const journal = run(roll, ["ledger", "--hledger"]);
  assert.match(journal.stdout, /2026-09-15 AC serviced\n.*\n {4}expenses:house {2}325 USD\n {4}assets:unknown/);
  assert.equal(run(roll, ["ledger", "--by", "a b", "--json"]).status, 1);
});

test("a record's price isn't counted again when an event with an amount links to it: that event is the purchase", () => {
  const bike = doc(".gitroll/notes/inventory/bike.md", "price: 2400", "# Bike");
  const lamp = doc(".gitroll/notes/inventory/lamp.md", "price: 40", "# Lamp");
  const saw = doc(".gitroll/notes/inventory/tools/saw.md", "price: 25", "# Saw");
  const bought = doc(".gitroll/events/2026-09-01-bought.md", "amount: 2400", "# Bought the bike\n\nThe [bike](../notes/inventory/bike.md).");
  const sawPaid = doc(".gitroll/events/2026-09-02-saw.md", 'amount: 25\nfor: "[Saw](../notes/inventory/tools/saw.md)"', "# Saw");
  const mention = doc(".gitroll/events/2026-09-03-lamp.md", "tags: [home]", "# Moved the [lamp](../notes/inventory/lamp.md)");
  const all = [bike, lamp, saw, bought, sawPaid, mention];
  const view = ledger(all);
  assert.deepEqual(view.entries.map((e) => e.path).sort(), [bought.path, sawPaid.path, lamp.path].sort(), "a text link and a front matter link alike; a link with no amount isn't a purchase");
  assert.deepEqual(view.totals, [{ currency: "USD", total: 2465, count: 3 }]);
  assert.deepEqual(ledger([bike, lamp], undefined, all).entries.map((e) => e.path), [lamp.path], "a search of the records still knows what paid for them");
  assert.deepEqual(ledger([bike]).entries.map((e) => e.path), [bike.path], "with nothing that paid for it, a price counts as before");
});
