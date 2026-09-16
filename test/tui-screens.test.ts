// The screens are pictures of state, so they can be asked for a picture without
// an app, a Roll or a terminal. These are the rules that are easy to break by
// accident and invisible until someone's terminal is the wrong size.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { LoadedEntry } from "../src/core/layout.ts";
import { list, note, row } from "../src/node/tui/screens/chrome.ts";
import { find, preview } from "../src/node/tui/screens/find.ts";
import { timeline } from "../src/node/tui/screens/timeline.ts";
import { Input, width } from "../src/node/tui/text.ts";

const plain = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
const names = (slug: string) => ({ house: "The House", garden: "Garden" })[slug] ?? slug;

const entry = (over: Partial<LoadedEntry> = {}): LoadedEntry =>
  ({
    id: ".gitroll/events/2026-09-16-something.md",
    path: ".gitroll/events/2026-09-16-something.md",
    title: "Something happened",
    body: "Something happened",
    date: "2026-09-16T10:00:00-05:00",
    projects: [],
    tags: [],
    attachments: [],
    meta: {},
    ...over,
  }) as LoadedEntry;

test("a row keeps its labels on the right and never runs past the width", () => {
  const long = entry({ title: "A title far longer than the terminal it has to fit inside, going on and on", projects: ["house"], amount: { value: 84, currency: "USD" } });
  for (const w of [40, 60, 100]) {
    const drawn = row(long, w, names);
    assert.ok(width(drawn) <= w, `${w}: ${width(drawn)}`);
    assert.match(drawn, /The House · 84 USD$/, "the labels survive, whatever gets cut");
  }
});

test("the timeline hugs the prompt, and scrolls only far enough to show the chosen entry", () => {
  const entries = Array.from({ length: 20 }, (_, i) => entry({ title: `Entry ${i}` }));
  const few = timeline({ entries: entries.slice(0, 3), selected: -1, scroll: null, names, width: 60, rows: 10 });
  assert.equal(few.lines.length, 10);
  assert.deepEqual(few.lines.slice(0, 7), Array(7).fill(""), "blank above, so the newest sits on the prompt");
  assert.match(plain(few.lines), /Entry 0$/, "newest last");

  // Newest is 0, so choosing 19 is the oldest: the far end of the list.
  const far = timeline({ entries, selected: 19, scroll: null, names, width: 60, rows: 5 });
  assert.match(plain(far.lines), /▸ .*Entry 19/);
  assert.equal(far.lines.length, 5);
});

test("a list window follows the selection without jumping further than it must", () => {
  const rows = Array.from({ length: 10 }, (_, i) => `row ${i}`);
  assert.equal(list(rows, 0, 0, 20, 4).scroll, 0);
  assert.equal(list(rows, 5, 0, 20, 4).scroll, 2, "scrolls just enough to bring row 5 into four lines");
  assert.equal(list(rows, 5, 4, 20, 4).scroll, 4, "and leaves a window that already shows it alone");
  assert.equal(list(rows, 9, 0, 20, 4).scroll, 6, "the end of the list is the end of the scrolling");
});

test("search puts the preview beside the results only when there's room for both", () => {
  const results = [entry({ title: "Fixed the gate", projects: ["garden"] })];
  const view = { query: new Input("gate"), results, total: 3, selected: 0, scroll: 0, names, rows: 12 };
  const wide = plain(find({ ...view, width: 120 }).lines);
  assert.match(wide, /Fixed the gate.*│/, "side by side");
  const narrow = plain(find({ ...view, width: 70 }).lines);
  assert.doesNotMatch(narrow, /│/, "and stacked when narrow");
  assert.match(narrow, /Fixed the gate/);
});

test("an empty search says what was searched, wrapped to the terminal", () => {
  const lines = find({ query: new Input("warranty"), results: [], total: 3, selected: 0, scroll: 0, names, width: 50, rows: 12 }).lines;
  assert.match(plain(lines), /Nothing found/);
  assert.match(plain(lines), /not what is inside those files/);
  for (const line of lines) assert.ok(width(line) <= 50, line);
});

test("a note never runs off the edge, and a preview stops where it's told", () => {
  for (const w of [24, 50, 100]) for (const line of note("A sentence long enough to need breaking at several widths, without a word being cut in half.", w)) assert.ok(width(line) <= w);
  const long = entry({ body: "line\n".repeat(50), projects: ["house"] });
  assert.equal(preview(long, 40, 6, names).length, 6);
  assert.deepEqual(preview(undefined, 40, 6, names), []);
});
