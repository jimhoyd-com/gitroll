import assert from "node:assert/strict";
import { test } from "node:test";
import { planIngest } from "../src/core/adapter.ts";
import { webhookAdapter } from "../src/core/adapters/webhook.ts";
import { parseEntry, serializeEntry } from "../src/core/entry.ts";
import { uuidv7 } from "../src/core/id.ts";
import { SearchIndex, parseQuery, serialize, tokenize } from "../src/core/search.ts";
import { normalizeData, parseTypeDef, typeRegistry } from "../src/core/types.ts";
import { normalizeTimestamp, parseAmount } from "../src/core/util.ts";

test("uuidv7 is valid and time-sortable", () => {
  const a = uuidv7(1_000);
  const b = uuidv7(2_000);
  assert.ok(a < b);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("entries round-trip and preserve fields GitRoll doesn't know", () => {
  const source = `---
version: 1
id: 0199abc
created: 2026-09-15T09:43:18-05:00
author: jimmy
projects:
  - bathroom-remodel
tags:
  - Contractor
data:
  vendor: Carlos Tile
mileage: 42100
---

Carlos completed the shower tile.
`;
  const e = parseEntry(source);
  assert.equal(e.type, "log");
  assert.equal(e.occurred, e.created);
  assert.deepEqual(e.tags, ["contractor"]);
  assert.equal(e.data.vendor, "Carlos Tile");
  assert.equal(e.extra.mileage, 42100);
  assert.deepEqual(parseEntry(serializeEntry(e)), e);
  assert.throws(() => parseEntry("no front matter"), /front matter/);
  assert.throws(() => parseEntry("---\nid: x\n---\n"), /created/);
});

test("timestamps, amounts and custom types", () => {
  assert.equal(normalizeTimestamp("2026-09-14T15:30:00-05:00"), "2026-09-14T15:30:00-05:00");
  assert.deepEqual(parseAmount("$1,850"), { value: 1850, currency: "USD" });
  assert.deepEqual(parseAmount("99.50 eur"), { value: 99.5, currency: "EUR" });
  assert.equal(parseAmount("lots"), null);

  const vehicle = parseTypeDef("vehicle-service", "label: Vehicle service\nicon: 🚗\namount: expected\nfields:\n  - key: odometer\n    kind: number\n");
  assert.equal(typeRegistry([vehicle]).get("vehicle-service")?.label, "Vehicle service");
  assert.deepEqual(normalizeData(vehicle, { odometer: "42,100", note: "kept" }), { odometer: 42100, note: "kept" });
  assert.throws(() => parseTypeDef("Bad Id", "label: x"));

  const withDefaults = parseTypeDef("oil-change", "label: Oil change\ndefaults:\n  text: Changed the oil.\n  tags: [car]\n  amount: { value: 60, currency: usd }\n  data: { shop: Jiffy, bad key: x, nested: { a: 1 } }\nscript: rm -rf /\n");
  assert.deepEqual(withDefaults.defaults, { text: "Changed the oil.", tags: ["car"], amount: { value: 60, currency: "USD" }, data: { shop: "Jiffy" } });
});

test("search: text, filters, amounts, dates and has:", () => {
  const tokens = tokenize('project:house "shower tile" #payment https://example.com');
  assert.deepEqual(tokens, [
    { key: "project", value: "house" },
    { value: "shower tile" },
    { key: "tag", value: "payment" },
    { value: "https://example.com" },
  ]);
  assert.equal(serialize(tokens), 'project:house "shower tile" tag:payment https://example.com');
  assert.equal(parseQuery("person:jimmy").authors[0], "jimmy");

  const base = { version: 1, created: "2026-09-02T10:00:00-05:00", author: "jimmy", attachments: [], extra: {}, tags: [] as string[] };
  const entries = [
    { ...base, id: "a", type: "expense", occurred: "2026-09-02T10:00:00-05:00", projects: ["bathroom-remodel"], body: "Paid Carlos", amount: { value: 1500, currency: "USD" }, data: { vendor: "Carlos" }, tags: ["payment"] },
    { ...base, id: "b", type: "expense", occurred: "2026-09-15T10:00:00-05:00", projects: ["bathroom-remodel"], body: "Paid Carlos the rest", amount: { value: 1850, currency: "USD" }, data: { vendor: "Carlos" }, attachments: [{ hash: "sha256:x", name: "receipt.pdf", type: "application/pdf" }] },
    { ...base, id: "c", type: "maintenance", occurred: "2026-08-01T10:00:00-05:00", projects: ["house"], body: "AC serviced", data: { vendor: "Cool Air" } },
  ];
  const index = new SearchIndex(entries, { projectNames: new Map([["bathroom-remodel", "Bathroom Remodel"]]) });
  const ids = (q: string) => index.search(q).map((e) => e.id);
  assert.deepEqual(ids("carlos"), ["a", "b"]);
  assert.deepEqual(ids("bathroom"), ["a", "b"]);
  assert.deepEqual(ids("type:expense amount:>1600"), ["b"]);
  assert.deepEqual(ids("after:2026-09-10 has:receipt"), ["b"]);
  assert.deepEqual(ids("vendor:cool"), ["c"]);
  assert.deepEqual(ids("#payment"), ["a"]);
  assert.deepEqual(ids("project:house project:bathroom-remodel"), ["a", "b", "c"]);
  assert.deepEqual(ids("on:2026-08"), ["c"]);
});

test("webhook adapter requires ids so ingestion is idempotent", () => {
  const drafts = webhookAdapter.toEvents([{ id: "inv-1", type: "expense", text: "Paid plumber", amount: "$425", project: "house" }], { options: {} });
  assert.equal(drafts[0].amount?.value, 425);
  assert.equal(planIngest([], [...drafts, ...drafts]).create.length, 1);
  assert.throws(() => webhookAdapter.toEvents({ text: "no id" }, { options: {} }), /id/);
});
