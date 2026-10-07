// Inventory (schema.org field names), places that nest, derived restock
// to-dos, CSV (RFC 4180) out and in, and QR labels.

import "./helpers.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { cellOf, parseCsv, planCsvImport, recordsToCsv, toCsv, valueOfCell } from "../src/core/csv.ts";
import { parseEntry } from "../src/core/entry.ts";
import { inventory, restockTodos } from "../src/core/inventory.ts";
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

const places = [
  doc(".gitroll/notes/places/house.md", "kind: home", "# House"),
  doc(".gitroll/notes/places/garage.md", 'within: "[House](house.md)"', "# Garage"),
  doc(".gitroll/notes/places/shelf-2.md", 'within: "[Garage](garage.md)"', "# Shelf 2"),
  doc(".gitroll/notes/places/loop-a.md", 'within: "[B](loop-b.md)"', "# Loop A"),
  doc(".gitroll/notes/places/loop-b.md", 'within: "[A](loop-a.md)"', "# Loop B"),
];
const items = [
  doc(".gitroll/notes/inventory/heat-pump.md", 'brand: Daikin\nmodel: FTXS35\nserialNumber: E123456\npurchaseDate: 2024-06-02\nprice: 1899\npriceCurrency: USD\nwarranty: 2026-12-01\nlocation: "[Garage](../places/garage.md)"\nquantity: 1', "# Garage heat pump"),
  doc(".gitroll/notes/inventory/filters.md", 'price: 12.5\nquantity: 2\nreorderAt: 2\nlocation: "[Shelf 2](../places/shelf-2.md)"', "# HVAC filters"),
  doc(".gitroll/notes/inventory/rug.md", "price: €200\nlocation: Attic\nwarranty: 2031-01-01", "# Rug"),
  doc(".gitroll/notes/inventory/odd.md", 'location: "[Loop](../places/loop-a.md)"', "# Odd"),
];

test("inventory: items with schema.org fields, places followed outwards, value per currency, warranties ending soon", () => {
  const view = inventory(items, [...places, ...items], { by: "location", today: "2026-10-07" });
  const pump = view.items[0];
  assert.equal(pump.brand, "Daikin");
  assert.equal(pump.serialNumber, "E123456");
  assert.deepEqual(pump.location, { text: "[Garage](../places/garage.md)", path: ".gitroll/notes/places/garage.md", trail: ["House", "Garage"] });
  assert.deepEqual(view.items[1].location!.trail, ["House", "Garage", "Shelf 2"]);
  assert.deepEqual(view.items[1].value, { value: 25, currency: "USD" }, "price × quantity");
  assert.deepEqual(view.items[2].location!.trail, ["Attic"], "plain text is a place too");
  assert.deepEqual(view.items[3].location!.trail, ["Loop B", "Loop A"], "a loop of within: links stops");
  assert.deepEqual(view.totals, [{ currency: "EUR", total: 200, count: 1 }, { currency: "USD", total: 1924, count: 2 }]);
  assert.deepEqual(view.warranties, [{ path: ".gitroll/notes/inventory/heat-pump.md", title: "Garage heat pump", warranty: "2026-12-01" }]);
  assert.deepEqual(view.restock, [{ path: ".gitroll/notes/inventory/filters.md", title: "HVAC filters", quantity: 2, reorderAt: 2 }]);
  assert.deepEqual(view.groups!.map((g) => [g.key, g.count]), [["Attic", 1], ["House › Garage", 1], ["House › Garage › Shelf 2", 1], ["Loop B › Loop A", 1]]);
});

test("a record running low is a derived restock to-do, in any collection, and never written", () => {
  const todos = restockTodos([...items, doc(".gitroll/notes/pantry/rice.md", "quantity: 0\nreorderAt: 1", "# Rice"), doc(".gitroll/notes/pantry/salt.md", "quantity: 3\nreorderAt: 1", "# Salt")]);
  assert.deepEqual(todos.map((t) => [t.path, t.text, t.derived, t.line, t.done]), [
    [".gitroll/notes/inventory/filters.md", "Restock HVAC filters (2 left, reorder at 2)", true, 0, false],
    [".gitroll/notes/pantry/rice.md", "Restock Rice (0 left, reorder at 1)", true, 0, false],
  ]);
});

test("CSV is RFC 4180: quotes, commas and line breaks survive a round trip", () => {
  const rows = [["title", "note", "n"], ['He said "hi"', "a, b", "1"], ["Two\nlines", " padded ", ""], ["crlf\r\nhere", "", "x"]];
  const text = toCsv(rows);
  assert.equal(text, 'title,note,n\r\n"He said ""hi""","a, b",1\r\n"Two\nlines"," padded ",\r\n"crlf\r\nhere",,x\r\n');
  assert.deepEqual(parseCsv(text), rows);
  assert.deepEqual(parseCsv("﻿a,b\nc,d"), [["a", "b"], ["c", "d"]], "LF and a byte-order mark are accepted");
  assert.deepEqual(parseCsv('a,""\r\n'), [["a", ""]]);
  assert.throws(() => parseCsv('a,"open'), /never closed/);
  assert.equal(cellOf(["Le Guin", "a, b"]), '[Le Guin, "a, b"]');
  assert.deepEqual(valueOfCell('[Le Guin, "a, b"]'), ["Le Guin", "a, b"]);
  assert.equal(valueOfCell("00123"), "00123", "leading zeros stay text");
  assert.equal(valueOfCell("12.5"), 12.5);
  assert.equal(valueOfCell("true"), true);
  assert.equal(valueOfCell("2026-11-01"), "2026-11-01");
  assert.equal(valueOfCell("[not a list"), "[not a list");

  const records = [doc(".gitroll/notes/books/a.md", 'rating: 5\nnote: "said \\"hi\\", then\\nleft"\nauthors: [Le Guin, "Delany, Samuel"]\nsource: {adapter: csv, id: a}', "# A, the book")];
  const csv = recordsToCsv(records);
  assert.deepEqual(parseCsv(csv), [["title", "rating", "note", "authors"], ["A, the book", "5", 'said "hi", then\nleft', '[Le Guin, "Delany, Samuel"]']]);
  const plan = planCsvImport(csv, []);
  assert.deepEqual(plan.create[0].fields, [["rating", 5], ["note", 'said "hi", then\nleft'], ["authors", ["Le Guin", "Delany, Samuel"]]]);
});

test("planning an import: the title or name column, one record per row, skipped once imported", () => {
  const csv = "SKU,Name,Price,Bad Column!,quantity\n00123,Kettle,30,x,2\n00124,,5,,\n00125,Kettle,1,,\n00126,Toaster,,,\n";
  const plan = planCsvImport(csv, [doc(".gitroll/notes/inventory/toaster.md", "source: {adapter: csv, id: toaster}", "# Toaster")]);
  assert.equal(plan.titleColumn, "Name");
  assert.deepEqual(plan.create.map((r) => [r.title, r.id, r.fields]), [["Kettle", "kettle", [["SKU", "00123"], ["Price", 30], ["quantity", 2]]]]);
  assert.deepEqual(plan.skip.map((r) => [r.row, r.title]), [[4, "Kettle"], [5, "Toaster"]]);
  assert.deepEqual(plan.problems.map((p) => p.row), [1, 3]);
  assert.equal(planCsvImport("Item,Cost\nLamp,4\n", []).create[0].title, "Lamp", "with no title or name column, the first one");
});

test("gitroll inventory, todos, records --csv, import csv and label", () => {
  const roll = GitRoll.init(tmp(), { name: "Stuff" });
  for (const d of [...places, ...items]) {
    fs.mkdirSync(path.join(roll.root, path.dirname(d.path)), { recursive: true });
    fs.writeFileSync(path.join(roll.root, d.path), `---\n${Object.entries(d.meta).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n")}\n---\n\n# ${d.title}\n`);
  }
  roll.commitPending();

  const view = json(roll, ["inventory", "--by", "location"]);
  assert.equal(view.items.length, 4);
  assert.equal(view.restock.length, 1);
  assert.equal(json(roll, ["inventory", "brand:daikin"]).items.length, 1);
  assert.equal(json(roll, ["inventory", "--collection", "places"]).items.length, 5);
  assert.match(run(roll, ["inventory"]).stdout, /Garage heat pump {2}Daikin FTXS35 {2}×1 {2}1,899\.00 USD/);

  const todos = json(roll, ["todos"]);
  assert.deepEqual(todos.map((t: { text: string; derived?: boolean }) => [t.text, t.derived]), [["Restock HVAC filters (2 left, reorder at 2)", true]]);
  assert.match(run(roll, ["todos"]).stdout, /Restock HVAC filters .*derived/);
  assert.equal(run(roll, ["done", "Restock", "--json"]).status, 1, "a derived to-do can't be ticked off");

  const csv = run(roll, ["records", "inventory", "--csv"]);
  assert.equal(csv.status, 0, csv.stderr);
  const table = parseCsv(csv.stdout);
  assert.equal(table[0][0], "title");
  assert.equal(table.length, 5);
  assert.ok(csv.stdout.includes('"[Garage](../places/garage.md)"') || csv.stdout.includes("[Garage](../places/garage.md)"));
  assert.equal(json(roll, ["records", "inventory", "--csv"]).csv, csv.stdout);

  const file = path.join(tmp(), "pantry.csv");
  fs.writeFileSync(file, 'name,quantity,reorderAt,note\r\nRice,0,1,"long grain, 5kg"\r\nSalt,3,1,"says ""fine"""\r\n');
  const dry = json(roll, ["import", "csv", "pantry", file, "--dry-run"]);
  assert.deepEqual(dry.create, ["Rice", "Salt"]);
  assert.equal(fs.existsSync(path.join(roll.root, ".gitroll/notes/pantry")), false, "a dry run writes nothing");
  const first = json(roll, ["import", "csv", "pantry", file]);
  assert.deepEqual(first.created, [".gitroll/notes/pantry/rice.md", ".gitroll/notes/pantry/salt.md"]);
  assert.equal(roll.git(["status", "--porcelain"]).trim(), "", "committed");
  assert.equal(roll.git(["log", "-1", "--format=%s"]).trim(), "import: 2 records into pantry");
  const rice = fs.readFileSync(path.join(roll.root, ".gitroll/notes/pantry/rice.md"), "utf8");
  assert.match(rice, /^---\nquantity: 0\nreorderAt: 1\nnote: long grain, 5kg\nsource:\n {2}adapter: csv\n {2}id: rice\n---\n\n# Rice\n$/);
  const again = json(roll, ["import", "csv", "pantry", file]);
  assert.deepEqual(again.created, []);
  assert.deepEqual(again.skipped.map((s: { title: string }) => s.title), ["Rice", "Salt"], "importing twice creates each record once");
  assert.equal(json(roll, ["todos"]).filter((t: { derived?: boolean }) => t.derived).length, 2);
  const back = parseCsv(run(roll, ["records", "pantry", "--csv"]).stdout);
  assert.deepEqual(back, [["title", "quantity", "reorderAt", "note"], ["Rice", "0", "1", "long grain, 5kg"], ["Salt", "3", "1", 'says "fine"']]);
  assert.equal(run(roll, ["import", "csv", "pantry", "--json"]).status, 1, "csv needs a collection and a file");

  const labelled = json(roll, ["label", "heat-pump"]);
  assert.equal(labelled.data, ".gitroll/notes/inventory/heat-pump.md");
  assert.equal(labelled.version, 3);
  assert.match(labelled.text, /█/);
  const svg = run(roll, ["label", "heat-pump", "--svg"]);
  assert.match(svg.stdout, /^<svg [^>]*viewBox="0 0 37 37"/);
});
