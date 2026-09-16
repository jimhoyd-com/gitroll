// The screens are pictures of state, so they can be asked for a picture without
// an app, a Roll or a terminal. These are the rules that are easy to break by
// accident and invisible until someone's terminal is the wrong size.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { LoadedEntry } from "../src/core/layout.ts";
import { list, note, row } from "../src/node/tui/screens/chrome.ts";
import { entry as entryScreen } from "../src/node/tui/screens/entry.ts";
import { find, preview } from "../src/node/tui/screens/find.ts";
import { help } from "../src/node/tui/screens/help.ts";
import { timeline } from "../src/node/tui/screens/timeline.ts";
import { Input, width } from "../src/node/tui/text.ts";

const plain = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

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
  const long = entry({ title: "A title far longer than the terminal it has to fit inside, going on and on", amount: { value: 84, currency: "USD" } });
  for (const w of [40, 60, 100]) {
    const drawn = row(long, w);
    assert.ok(width(drawn) <= w, `${w}: ${width(drawn)}`);
    assert.match(drawn, /84\.00 USD$/, "the amount survives whatever gets cut, and reads as money");
  }
});

test("the timeline hugs the prompt, and scrolls only far enough to show the chosen entry", () => {
  const entries = Array.from({ length: 20 }, (_, i) => entry({ title: `Entry ${i}` }));
  const few = timeline({ entries: entries.slice(0, 3), selected: -1, scroll: null, width: 60, rows: 10 });
  assert.equal(few.lines.length, 10);
  assert.deepEqual(few.lines.slice(0, 7), Array(7).fill(""), "blank above, so the newest sits on the prompt");
  assert.match(plain(few.lines), /Entry 0$/, "newest last");

  // Newest is 0, so choosing 19 is the oldest: the far end of the list.
  const far = timeline({ entries, selected: 19, scroll: null, width: 60, rows: 5 });
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
  const results = [entry({ title: "Fixed the gate" })];
  const view = { query: new Input("gate"), results, total: 3, selected: 0, scroll: 0, rows: 12 };
  const wide = plain(find({ ...view, width: 120 }).lines);
  assert.match(wide, /Fixed the gate.*│/, "side by side");
  const narrow = plain(find({ ...view, width: 70 }).lines);
  assert.doesNotMatch(narrow, /│/, "and stacked when narrow");
  assert.match(narrow, /Fixed the gate/);
});

test("an empty search says what was searched, wrapped to the terminal", () => {
  const lines = find({ query: new Input("warranty"), results: [], total: 3, selected: 0, scroll: 0, width: 50, rows: 12 }).lines;
  assert.match(plain(lines), /Nothing found/);
  assert.match(plain(lines), /not what is inside those files/);
  for (const line of lines) assert.ok(width(line) <= 50, line);
});

test("a note never runs off the edge, and a preview stops where it's told", () => {
  for (const w of [24, 50, 100]) for (const line of note("A sentence long enough to need breaking at several widths, without a word being cut in half.", w)) assert.ok(width(line) <= w);
  const long = entry({ body: "line\n".repeat(50) });
  assert.equal(preview(long, 40, 6).length, 6);
  assert.deepEqual(preview(undefined, 40, 6), []);
});

test("the help screen's headings are bold, not the word \"[1m\"", () => {
  const { lines } = help("/home/someone/GitRoll/home", 0, 90, 40);
  const shown = lines.join("\n");
  // Whatever is left once the real escapes are removed is what a terminal shows.
  assert.doesNotMatch(shown.replace(/\x1b\[[0-9;]*m/g, ""), /\[[0-9;]*m/, "no styling left on screen as text");
  assert.match(shown, /\x1b\[1m GitRoll, in a terminal/, "the heading really is bold");
  assert.match(plain(lines), /This Roll lives in \/home\/someone\/GitRoll\/home/);
  for (const line of lines) assert.ok(width(line) <= 90, line);
});

test("an entry keeps the shape it was written in", () => {
  // A Roll is plain Markdown someone can read. The screen that reads it back
  // used to hand every line break to clean(), which turns control characters
  // into spaces, so a heading, two paragraphs and a list arrived as one line.
  const written = "# Two paragraphs\n\nFirst paragraph here.\n\nSecond paragraph here.\n\n- one\n- two";
  const { lines } = entryScreen({
    entry: entry({ body: written, title: "Two paragraphs" }),
    hasFile: () => true,
    attachIndex: 0,
    attaching: null,
    scroll: 0,
    width: 60,
    rows: 30,
  });
  const shown = plain(lines);
  assert.match(shown, /# Two paragraphs\n\s*\n First paragraph here\./, "the heading keeps its own line, and the blank line after it");
  assert.match(shown, /\n - one\n - two/, "and so does every item of a list");
  assert.doesNotMatch(shown, /one - two/, "never run together");
  for (const line of lines) assert.ok(width(line) <= 60, line);
});
