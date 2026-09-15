import "./helpers.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEntry } from "../src/core/entry.ts";
import { mergeEntry } from "../src/node/merge.ts";

function event(body: string, tags: string[], extra = ""): string {
  return `---
version: 1
id: 01a0a5d3-dd68-7711-9ea0-1f39f4a279b9
type: log
created: 2026-09-01T10:00:00-05:00
occurred: 2026-09-01T10:00:00-05:00
author: jimmy
projects: []
tags:
${tags.map((t) => `  - ${t}`).join("\n") || "  []"}
${extra}---

${body}
`.replace("tags:\n  []", "tags: []");
}

test("edits to different parts of an event combine cleanly", () => {
  const base = event("Line one\nLine two\nLine three", ["house"]);
  const mine = event("Line one, edited here\nLine two\nLine three", ["house", "hvac"]);
  const theirs = event("Line one\nLine two\nLine three, edited elsewhere", [], "amount:\n  value: 325\n  currency: USD\n");
  const { text, conflicted } = mergeEntry(base, mine, theirs);
  const merged = parseEntry(text);
  assert.equal(conflicted, false);
  assert.equal(merged.body, "Line one, edited here\nLine two\nLine three, edited elsewhere");
  assert.deepEqual(merged.tags, ["hvac"], "added here, removed there");
  assert.deepEqual(merged.amount, { value: 325, currency: "USD" });
});

test("the same text changed in both places keeps both versions", () => {
  const base = event("Paid contractor $1,850", []);
  const mine = event("Paid contractor $1,850 by check", []);
  const theirs = event("Paid contractor $1,500", []);
  const { text, conflicted } = mergeEntry(base, mine, theirs);
  const merged = parseEntry(text);
  assert.equal(conflicted, true);
  assert.ok(merged.body.startsWith("Paid contractor $1,850 by check"));
  assert.match(merged.body, /Sync note/);
  assert.match(merged.body, /Paid contractor \$1,500/);
  assert.ok(merged.tags.includes("conflict"));
});

test("an event created on both sides without a common base still merges", () => {
  const { text } = mergeEntry(null, event("Mine", ["a"]), event("Theirs", ["b"]));
  const merged = parseEntry(text);
  assert.deepEqual(merged.tags.sort(), ["a", "b", "conflict"]);
  assert.match(merged.body, /Theirs/);
});
