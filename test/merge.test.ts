import "./helpers.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEntry } from "../src/core/entry.ts";
import { mergeEntry } from "../src/node/merge.ts";

const PATH = ".gitroll/events/2026-09-01-tiling.md";

const event = (body: string, front = "") => `${front ? `---\n${front}---\n\n` : ""}${body}\n`;

test("edits to different parts of an event combine cleanly", () => {
  const base = event("# Tiling\n\nLine one\nLine two\nLine three");
  const mine = event("# Tiling\n\nLine one, edited here\nLine two\nLine three", "tags: [hvac]\n");
  const theirs = event("# Tiling\n\nLine one\nLine two\nLine three, edited elsewhere");
  const { text, conflicted } = mergeEntry(base, mine, theirs);
  const merged = parseEntry(PATH, text);
  assert.equal(conflicted, false);
  assert.match(merged.body, /Line one, edited here/);
  assert.match(merged.body, /Line three, edited elsewhere/);
  assert.deepEqual(merged.tags, ["hvac"]);
});

test("the same lines changed in both places keeps both versions", () => {
  const base = event("Paid contractor $1,850");
  const mine = event("Paid contractor $1,850 by check");
  const theirs = event("Paid contractor $1,500");
  const { text, conflicted } = mergeEntry(base, mine, theirs);
  const merged = parseEntry(PATH, text);
  assert.equal(conflicted, true);
  assert.ok(merged.body.startsWith("Paid contractor $1,850 by check"), "this device's version is left intact");
  assert.match(merged.body, /Sync note/);
  assert.match(merged.body, /Paid contractor \$1,500/, "the other version is kept, not dropped");
  assert.ok(merged.tags.includes("conflict"));
});

test("an event created on both sides without a common base still merges", () => {
  const { text } = mergeEntry(null, event("# Mine\n\nMine"), event("# Theirs\n\nTheirs"));
  const merged = parseEntry(PATH, text);
  assert.match(merged.body, /Mine/);
  assert.match(merged.body, /Theirs/);
});

test("identical edits on both sides aren't a conflict", () => {
  const same = event("# Same\n\nSame text");
  const { text, conflicted } = mergeEntry(event("# Same\n\nOld text"), same, same);
  assert.equal(conflicted, false);
  assert.equal(text, same);
});
