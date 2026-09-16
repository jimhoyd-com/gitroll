// Dates and time zones: the same Roll must read the same way wherever it's opened.
// Each check runs under several real time zones, including half-hour offsets, +14/-11,
// and daylight-saving changes. (CI runs in UTC, which would hide these bugs.)
//
// An event's date is a plain day — the one in its file name, or the one someone
// typed in the front matter — so most of these questions now have one obvious
// answer. The cases that remain are the ones where a time of day is given.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEntry } from "../src/core/entry.ts";
import type { Entry } from "../src/core/entry.ts";
import { buildEntry, entryPath, sortEntries } from "../src/core/layout.ts";
import { SearchIndex } from "../src/core/search.ts";
import { isoDate, isoLocal } from "../src/core/util.ts";

const ZONES = ["UTC", "America/Los_Angeles", "America/New_York", "Asia/Tokyo", "Asia/Kolkata", "America/St_Johns", "Pacific/Kiritimati", "Pacific/Pago_Pago"];

function inZone<T>(tz: string, fn: () => T): T {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

/** An event as someone might have written it by hand, dated in its front matter. */
const dated = (date: string, path = ".gitroll/events/note.md"): Entry => parseEntry(path, `---\ndate: ${date}\n---\n\n# Hand-edited event\n`);

const onDay = (entries: Entry[], day: string) => new SearchIndex(entries).search(`after:${day} before:${day}`).length;

test("time zones really change inside the test process", () => {
  assert.equal(inZone("UTC", () => new Date("2026-09-15T00:00:00Z").getTimezoneOffset()), 0);
  assert.equal(inZone("Asia/Kolkata", () => new Date("2026-09-15T00:00:00Z").getTimezoneOffset()), -330);
});

test("a new event is dated the author's own day, everywhere", () => {
  const instant = new Date("2026-09-15T00:00:00Z");
  const expected: Record<string, string> = {
    UTC: "2026-09-15",
    "Asia/Kolkata": "2026-09-15",
    "America/St_Johns": "2026-09-14",
    "Pacific/Kiritimati": "2026-09-15",
    "Pacific/Pago_Pago": "2026-09-14",
  };
  for (const [tz, want] of Object.entries(expected)) {
    assert.equal(inZone(tz, () => isoDate(instant)), want, tz);
    assert.equal(inZone(tz, () => buildEntry({ text: "Logged now" }, [], () => false, instant).date), want, tz);
  }
  // The date is the file's name, so the event reads the same wherever it is opened.
  assert.equal(inZone("Asia/Tokyo", () => buildEntry({ text: "Logged now" }, [], () => false, instant).path), ".gitroll/events/2026-09-15-logged-now.md");
});

test("a bare date stays on that day in every time zone", () => {
  for (const tz of ZONES) {
    inZone(tz, () => {
      const e = dated("2026-09-15");
      assert.equal(e.date, "2026-09-15", tz);
      assert.equal(onDay([e], "2026-09-15"), 1, `${tz} finds it on the 15th`);
      assert.equal(onDay([e], "2026-09-14") + onDay([e], "2026-09-16"), 0, `${tz} doesn't put it on another day`);
    });
  }
});

test("a date in the file name needs nothing else", () => {
  for (const tz of ZONES) {
    inZone(tz, () => {
      const e = parseEntry(".gitroll/events/2026-09-15-ac-serviced.md", "# AC serviced\n");
      assert.equal(e.date, "2026-09-15", tz);
      assert.equal(onDay([e], "2026-09-15"), 1, tz);
    });
  }
});

test("an explicit time and offset is kept exactly as written", () => {
  for (const tz of ZONES) {
    inZone(tz, () => {
      const e = dated("2026-09-15T23:30:00+09:00");
      assert.equal(e.date, "2026-09-15T23:30:00+09:00", tz);
      assert.equal(onDay([e], "2026-09-15"), 1, `${tz}: it is on the day its author wrote`);
    });
  }
  // A local timestamp keeps the author's day even when UTC has moved on.
  assert.equal(entryPath("2026-09-30T23:30:00-07:00", "Late one", () => false), ".gitroll/events/2026-09-30-late-one.md");
  assert.match(isoLocal(new Date("2026-09-15T00:00:00Z")), /^\d{4}-\d{2}-\d{2}T/);
});

test("a date GitRoll can't read is reported rather than guessed at", () => {
  for (const ok of ["2026-09-15", "2026-09-15T14:30", "2026-09-15T21:30:00Z", "2026-09-15T14:30:00-07:00"]) {
    assert.doesNotThrow(() => dated(ok), ok);
  }
  for (const bad of ["Sept 15", "15/09/2026", "2026-9-15", "2026-02-30", "2026-09-15T25:00:00Z", "yesterday"]) {
    assert.throws(() => dated(bad), /invalid date/, bad);
  }
  // A file name that isn't a real date simply doesn't supply one.
  assert.equal(parseEntry(".gitroll/events/2026-02-30-impossible.md", "# Impossible\n").date, null);
});

test("events sort newest first, with undated ones last", () => {
  const a = dated("2026-09-15", ".gitroll/events/a.md");
  const b = dated("2026-09-15T23:30:00+09:00", ".gitroll/events/b.md");
  const c = dated("2026-08-01", ".gitroll/events/c.md");
  const undated = parseEntry(".gitroll/events/notes.md", "# Notes\n");
  for (const tz of ZONES) {
    const order = inZone(tz, () => sortEntries([undated, c, a, b]).map((e) => e.path));
    assert.deepEqual(order, [b.path, a.path, c.path, undated.path], `${tz}: newest first, undated last`);
  }
});

test("month and year searches cover every day in them", () => {
  const entries = [dated("2026-11-01", ".gitroll/events/a.md"), dated("2026-11-30", ".gitroll/events/b.md"), dated("2026-12-01", ".gitroll/events/c.md")];
  inZone("America/Los_Angeles", () => {
    // November 1, 2026 has 25 hours in Los Angeles; the month search still covers it.
    assert.equal(new SearchIndex(entries).search("on:2026-11").length, 2);
    assert.equal(new SearchIndex(entries).search("on:2026").length, 3);
  });
});

test("an undated event is never swept into a date search", () => {
  const undated = parseEntry(".gitroll/events/notes.md", "# Notes\n");
  assert.equal(new SearchIndex([undated]).search("on:2026").length, 0);
  assert.equal(new SearchIndex([undated]).search("has:date").length, 0);
  assert.equal(new SearchIndex([undated]).search("notes").length, 1);
});
