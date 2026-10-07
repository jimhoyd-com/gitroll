// Fields, records and collections.
//
// Every front matter key is a field: searchable as key:value, comparable as
// key>=value, present as has:key, sortable, and settable without disturbing
// anything else in the file. A folder under notes/ is a collection of records.

import "./helpers.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseEntry } from "../src/core/entry.ts";
import { collections, columnsOf, compareValue, fieldType, fieldYaml, matchesValue, parseSort, recordsIn, setFields, sortByFields } from "../src/core/fields.ts";
import { parseQuery, searchEntries, serialize, tokenize } from "../src/core/search.ts";
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
function failure(roll: GitRoll, args: string[], code: string) {
  const result = run(roll, [...args, "--json"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stderr).error.code, code, result.stderr);
}

const doc = (p: string, front: string, body = "# Untitled") => parseEntry(p, `---\n${front}\n---\n\n${body}\n`);

const books = [
  doc(".gitroll/notes/books/dune.md", "rating: 3\nstatus: Reading\nauthors: [Frank Herbert]\nfinished: 2026-01-04\nprice: $9.99", "# Dune"),
  doc(".gitroll/notes/books/ubik.md", "rating: 5\nstatus: read\nauthors: [Philip K. Dick]\nfinished: 2026-09-20\nlent: true", "# Ubik"),
  doc(".gitroll/notes/books/the-word.md", 'rating: "4"\nauthors: [Ursula K. Le Guin, Someone Else]', "# The Word for World Is Forest"),
  doc(".gitroll/notes/books/no-fields.md", "tags: [x]", "# No fields"),
];
const paths = (xs: { path: string }[]) => xs.map((x) => x.path.split("/").pop()).sort();

test("a field's type is read from its YAML, with no schema", () => {
  const [dune, ubik, word] = books;
  assert.equal(fieldType(dune.meta.rating), "number");
  assert.equal(fieldType(dune.meta.finished), "date");
  assert.equal(fieldType(dune.meta.price), "amount");
  assert.equal(fieldType(dune.meta.status), "text");
  assert.equal(fieldType(ubik.meta.lent), "boolean");
  assert.equal(fieldType(word.meta.rating), "text", "quoted is text");
  assert.equal(fieldType(word.meta.authors), "list");
  assert.equal(fieldType("2026-02-30"), "text", "an impossible date is not a date");
});

test("key:value matches text in any case, numbers exactly, dates by prefix and any list element", () => {
  assert.ok(matchesValue("Reading", "read"));
  assert.ok(matchesValue(3, "3"));
  assert.ok(!matchesValue(13, "3"), "a number is equal or it isn't");
  assert.ok(matchesValue("2026-01-04", "2026-01"));
  assert.ok(matchesValue(["Frank Herbert"], "herbert"));
  assert.ok(matchesValue(true, "yes"));
  assert.ok(!matchesValue(undefined, "x"));
  assert.deepEqual(paths(searchEntries(books, "authors:guin")), ["the-word.md"]);
  assert.deepEqual(paths(searchEntries(books, "Status:READ")), ["dune.md", "ubik.md"], "keys in any case; text contains");
  assert.deepEqual(paths(searchEntries(books, "lent:true")), ["ubik.md"]);
});

test("comparisons use the field's own type, and other types never match", () => {
  assert.ok(compareValue(5, ">=", "4"));
  assert.ok(!compareValue(3, ">=", "4"));
  assert.ok(compareValue("$9.99", "<", "10"));
  assert.ok(compareValue("2026-01-04", "<", "2026-02"), "before February starts");
  assert.ok(!compareValue("2026-02-14", "<", "2026-02"));
  assert.ok(compareValue("2026-02-14", "<=", "2026-02"), "up to the end of February");
  assert.ok(!compareValue("2026-02-14", ">", "2026-02"));
  assert.ok(compareValue("2026-03-01", ">", "2026-02"));
  assert.ok(!compareValue(true, ">", "0"));
  assert.ok(!compareValue(5, ">", "soon"), "a number is not compared with a word");
  assert.ok(compareValue(["a", "m"], ">", "k"), "any element of a list");
  assert.deepEqual(paths(searchEntries(books, "rating>=4")), ["the-word.md", "ubik.md"], "a quoted \"4\" is text, compared as text");
  assert.deepEqual(paths(searchEntries(books, "rating>4")), ["ubik.md"]);
  assert.deepEqual(paths(searchEntries(books, "rating:>4")), ["ubik.md"], "the amount:>500 spelling works for any field");
  assert.deepEqual(paths(searchEntries(books, "finished<2026-06")), ["dune.md"]);
  assert.deepEqual(paths(searchEntries(books, "finished>=2026-01 rating<5")), ["dune.md"]);
  assert.deepEqual(paths(searchEntries(books, "has:finished")), ["dune.md", "ubik.md"]);
  assert.deepEqual(paths(searchEntries(books, "has:lent")), ["ubik.md"]);
  assert.deepEqual(paths(searchEntries(books, "has:Price")), ["dune.md"]);
});

test("the query grammar keeps its old names and round-trips comparisons", () => {
  const q = parseQuery('rating>=4 expires<2026-11-01 vendor:carlos amount:>500 tag:x on:2026-09 "plain words"');
  assert.deepEqual(q.compares, [
    { key: "rating", op: ">=", value: "4" },
    { key: "expires", op: "<", value: "2026-11-01" },
  ]);
  assert.deepEqual(q.fields, [{ key: "vendor", value: "carlos" }]);
  assert.deepEqual(q.amounts, [{ op: ">", value: 500 }]);
  assert.deepEqual(q.tags, ["x"]);
  assert.equal(q.after, "2026-09-01");
  assert.deepEqual(q.terms, ["plain words"]);
  assert.equal(serialize(tokenize('rating>=4 title:"the word"')), 'rating>=4 title:"the word"');
  assert.deepEqual(tokenize("https://example.com"), [{ value: "https://example.com" }]);
  // An operator with nothing after it is a word, not a comparison with "=".
  assert.deepEqual(tokenize("rating>= x"), [{ value: "rating>=" }, { value: "x" }]);
});

test("search parsing stays linear on long hostile input", () => {
  const started = Date.now();
  for (const s of ["a".repeat(50_000), `a${">".repeat(50_000)}`, `k:${"<".repeat(50_000)}`, `${"a-".repeat(25_000)}=`, `$${"1,".repeat(25_000)}x`, `"a ${"\"a ".repeat(25_000)}`, `a:"${"b ".repeat(25_000)}`, `${"0".repeat(50_000)}x`, `0${" ".repeat(50_000)}x`]) {
    parseQuery(s);
    searchEntries(books, `${s} price<${s}`);
    compareValue(s, "<", s);
    fieldType(s);
  }
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started}ms`);
});

test("sorting by fields puts records without the field last, either way", () => {
  assert.deepEqual(parseSort("-rating,title"), [
    { key: "rating", descending: true },
    { key: "title", descending: false },
  ]);
  assert.deepEqual(parseSort("rating:desc"), [{ key: "rating", descending: true }]);
  assert.throws(() => parseSort("ra ting"));
  const up = sortByFields(books, parseSort("finished"));
  assert.deepEqual(up.map((b) => b.title), ["Dune", "Ubik", "The Word for World Is Forest", "No fields"]);
  const down = sortByFields(books, parseSort("-finished"));
  assert.deepEqual(down.map((b) => b.title), ["Ubik", "Dune", "The Word for World Is Forest", "No fields"]);
  const byRating = sortByFields(books, parseSort("-rating"));
  assert.deepEqual(byRating.slice(0, 2).map((b) => b.title), ["Ubik", "Dune"], "numbers before text, whatever the direction");
});

test("a folder under notes/ is a collection, and its README is not a record", () => {
  const notes = [...books, doc(".gitroll/notes/books/README.md", "kind: about", "# Books\n\nEverything I've read since 2020.\n\nMore."), doc(".gitroll/notes/wifi.md", "ssid: home"), doc(".gitroll/notes/films/sci-fi/alien.md", "year: 1979")];
  assert.deepEqual(collections(notes), [
    { name: "books", path: ".gitroll/notes/books", records: 4, description: "Everything I've read since 2020." },
    { name: "films/sci-fi", path: ".gitroll/notes/films/sci-fi", records: 1, description: null },
  ]);
  const records = recordsIn(notes, "Books");
  assert.equal(records.length, 4);
  assert.equal(recordsIn(notes, "/books//").length, 4);
  assert.equal(recordsIn(notes, `${"/".repeat(50_000)}x`).length, 0);
  assert.deepEqual(columnsOf(records), ["rating", "status", "authors", "finished", "price", "lent", "tags"]);
});

const ANNOTATED = `---
# How I rate things
Rating: 4 # reread it
custom:
  nested: [1, 2]   # keep me
tags: [sf]
---

# Dune

Body text,   spacing kept.
`;

test("set changes the fields named and nothing else", () => {
  const next = setFields(ANNOTATED, [
    ["rating", { yaml: "5" }],
    ["expires", { yaml: "2026-11-01" }],
    ["code", { yaml: '"007"' }],
  ]);
  assert.match(next, /^# How I rate things$/m, "a comment before the keys survives");
  assert.match(next, /^Rating: 5 # reread it$/m, "the existing key, in its own case, with its comment");
  assert.match(next, /nested: \[ 1, 2 \]|nested: \[1, 2\]/);
  assert.match(next, /# keep me/);
  assert.ok(next.endsWith("---\n\n# Dune\n\nBody text,   spacing kept.\n"), "the body byte for byte");
  const e = parseEntry("notes/x.md", next);
  assert.equal(e.meta.Rating, 5);
  assert.equal(e.meta.expires, "2026-11-01");
  assert.equal(e.meta.code, "007", "quoted stays text");
  assert.deepEqual(e.meta.custom, { nested: [1, 2] });

  const removed = setFields(next, [], ["RATING", "missing"]);
  assert.doesNotMatch(removed, /Rating/);
  assert.match(removed, /# keep me/);

  const plain = "# Plain\n\nNo front matter.\n";
  const added = setFields(plain, [["done", { yaml: "true" }]]);
  assert.equal(added, "---\ndone: true\n---\n\n# Plain\n\nNo front matter.\n");
  assert.equal(setFields(added, [], ["done"]), plain, "removing the last field removes the block");
  assert.throws(() => setFields(plain, [["x", { yaml: "{a: 1}" }]]), /mapping/);
});

test("records, set and add from the command line", () => {
  const roll = GitRoll.init(tmp(), { name: "Fields" });
  const first = json(roll, ["add", "books", "The Dispossessed", "--field", "rating=5", "--field", "authors=[Le Guin]", "--field", "status=reading"]);
  assert.equal(first.entry.path, ".gitroll/notes/books/the-dispossessed.md");
  assert.equal(first.entry.title, "The Dispossessed");
  assert.equal(first.replayed, undefined);
  json(roll, ["add", "books", "Dune", "--field", "rating=3", "--field", "finished=2026-01-04"]);
  json(roll, ["add", "books", "Ubik"]);
  fs.writeFileSync(path.join(roll.root, ".gitroll/notes/books/README.md"), "# Books\n\nWhat I read.\n");

  assert.deepEqual(json(roll, ["records"]), [{ name: "books", path: ".gitroll/notes/books", records: 3, description: "What I read." }]);
  const table = json(roll, ["records", "books", "--sort=-rating"]);
  assert.deepEqual(table.columns, ["rating", "finished", "authors", "status"], "in the order first seen, records by title");
  assert.equal(table.total, 3);
  assert.deepEqual(table.records.map((r: { title: string }) => r.title), ["The Dispossessed", "Dune", "Ubik"]);
  assert.deepEqual(table.records[2].fields, { rating: null, authors: null, status: null, finished: null }, "blank where a record has no such field");
  const filtered = json(roll, ["records", "books", "rating>=4", "--fields", "rating"]);
  assert.deepEqual(filtered.records, [{ path: ".gitroll/notes/books/the-dispossessed.md", title: "The Dispossessed", fields: { rating: 5 } }]);
  assert.equal(json(roll, ["records", "books", "--limit", "1", "--offset", "1", "--sort", "title"]).records[0].title, "The Dispossessed");
  const text = run(roll, ["records", "books"]);
  assert.match(text.stdout, /Title\s+rating\s+finished\s+authors\s+status/);
  failure(roll, ["records", "films"], "NOT_FOUND");

  assert.deepEqual(json(roll, ["find", "rating>=3", "--sort", "rating", "--fields", "title"]).map((e: { title: string }) => e.title), ["Dune", "The Dispossessed"]);

  // set: a YAML comment and a key GitRoll doesn't know survive, and only the change is committed.
  const file = path.join(roll.root, ".gitroll/notes/books/dune.md");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("rating: 3", "rating: 3 # generous\nshelf: { room: study }"));
  json(roll, ["save"]);
  const commits = Number(roll.git(["rev-list", "--count", "HEAD"]).trim());
  const revision = json(roll, ["show", "notes/books/dune"]).revision;
  failure(roll, ["set", "notes/books/dune", "rating=4", "--expect", "0".repeat(64)], "CONFLICT");
  const set = json(roll, ["set", "notes/books/dune", "rating=4", 'isbn="0441013597"', "--unset", "finished", "--expect", revision]);
  assert.equal(set.changed, true);
  const after = fs.readFileSync(file, "utf8");
  assert.match(after, /^rating: 4 # generous$/m);
  assert.match(after, /^shelf: \{ room: study \}$/m);
  assert.match(after, /^isbn: "0441013597"$/m);
  assert.doesNotMatch(after, /finished/);
  assert.match(after, /\n# Dune\n/);
  assert.equal(Number(roll.git(["rev-list", "--count", "HEAD"]).trim()), commits + 1);
  assert.match(roll.git(["log", "-1", "--format=%s"]), /^set: Dune/);
  assert.equal(json(roll, ["set", "notes/books/dune", "rating=4"]).changed, false);
  assert.equal(Number(roll.git(["rev-list", "--count", "HEAD"]).trim()), commits + 1, "no change, no commit");
  assert.equal(json(roll, ["set", "title:ubik", "rating=2"]).entry.path, ".gitroll/notes/books/ubik.md", "a query that finds exactly one");
  failure(roll, ["set", "notes/books/dune", "rating"], "INVALID_ARGUMENT");
  failure(roll, ["set", "notes/books/dune"], "INVALID_ARGUMENT");
  failure(roll, ["set", "notes/books/dune", "date=2026-02-30"], "USER_ERROR");
  assert.match(fs.readFileSync(file, "utf8"), /rating: 4/, "a refused set writes nothing");
});

test("add with an idempotency key replays the same request and refuses a different one", () => {
  const roll = GitRoll.init(tmp(), { name: "Keys" });
  const args = ["add", "books", "Dune", "--field", "rating=5", "--idempotency-key", "book-1"];
  const first = json(roll, args);
  assert.equal(first.replayed, false);
  const head = roll.git(["rev-parse", "HEAD"]);
  const again = json(roll, args);
  assert.equal(again.replayed, true);
  assert.equal(again.entry.path, first.entry.path);
  assert.equal(roll.git(["rev-parse", "HEAD"]), head, "no second commit");
  failure(roll, ["add", "books", "Dune", "--field", "rating=4", "--idempotency-key", "book-1"], "CONFLICT");
  assert.equal(roll.notes().length, 1);
  assert.deepEqual(json(roll, ["records", "books"]).columns, ["rating"], "the key's bookkeeping isn't a column");
  failure(roll, ["add", "books", "Other", "--field", "nope"], "INVALID_ARGUMENT");
});

test("a field's value reads back as the YAML that writes it again", () => {
  for (const v of [5, 4.5, true, "reading", "2026-11-01", "Le Guin, Ursula", ["a", "b"], "5", "true", "a # not a comment", " padded", "", "two\nlines"]) {
    const yaml = fieldYaml(v);
    assert.ok(yaml, `${JSON.stringify(v)} can be written`);
    assert.deepEqual(parseEntry("notes/t.md", setFields("# T\n", [["k", { yaml }]])).meta.k, v, `${JSON.stringify(v)} as ${yaml}`);
  }
  assert.equal(fieldYaml("5"), '"5"', "text that looks like a number is quoted");
  assert.equal(fieldYaml("reading"), "reading", "plain text is not");
  assert.equal(fieldYaml(null), "");
  assert.equal(fieldYaml({ value: 12, currency: "USD" }), null, "a mapping isn't one line of YAML to edit");
});
