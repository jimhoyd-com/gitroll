// Dates and time zones: the same Roll must read the same way wherever it's opened.
// Each check runs under several real time zones, including half-hour offsets, +14/-11,
// and daylight-saving changes. (CI runs in UTC, which would hide these bugs.)
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEntry, serializeEntry } from "../src/core/entry.ts";
import type { Entry } from "../src/core/entry.ts";
import { buildEntry, entryPath, sortEntries } from "../src/core/layout.ts";
import { SearchIndex } from "../src/core/search.ts";
import { isoLocal, normalizeTimestamp } from "../src/core/util.ts";

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

/** An event file as someone might have written it by hand, with the given `occurred` value. */
function withOccurred(occurred: string, created = "2026-09-15T10:00:00-07:00"): Entry {
  const built = buildEntry({ text: "Hand-edited event", occurred: "2026-01-01T00:00:00+00:00" }, "Test", []);
  const text = serializeEntry({ ...built, created })
    .replace(/^occurred: .*$/m, `occurred: ${occurred}`)
    .replace(/^created: .*$/m, `created: ${created}`);
  return parseEntry(text);
}

const onDay = (entries: Entry[], day: string) => new SearchIndex(entries).search(`after:${day} before:${day}`).length;

test("time zones really change inside the test process", () => {
  assert.equal(inZone("UTC", () => new Date("2026-09-15T00:00:00Z").getTimezoneOffset()), 0);
  assert.equal(inZone("Asia/Kolkata", () => new Date("2026-09-15T00:00:00Z").getTimezoneOffset()), -330);
});

test("new timestamps record local time with the right offset, including half-hour and extreme zones", () => {
  const instant = new Date("2026-09-15T00:00:00Z");
  const expected: Record<string, string> = {
    UTC: "2026-09-15T00:00:00+00:00",
    "Asia/Kolkata": "2026-09-15T05:30:00+05:30",
    "America/St_Johns": "2026-09-14T21:30:00-02:30",
    "Pacific/Kiritimati": "2026-09-15T14:00:00+14:00",
    "Pacific/Pago_Pago": "2026-09-14T13:00:00-11:00",
  };
  for (const [tz, want] of Object.entries(expected)) {
    const got = inZone(tz, () => isoLocal(instant));
    assert.equal(got, want, tz);
    assert.equal(Date.parse(got), instant.getTime(), `${tz} keeps the exact instant`);
  }
});

test("a date typed by hand stays on that day in every time zone", () => {
  for (const tz of ZONES) {
    inZone(tz, () => {
      const e = withOccurred("2026-09-15");
      assert.equal(e.occurred, "2026-09-15T12:00:00", tz);
      assert.equal(new Date(e.occurred).getDate(), 15, `${tz} shows the 15th`);
      assert.equal(onDay([e], "2026-09-15"), 1, `${tz} finds it on the 15th`);
      assert.equal(onDay([e], "2026-09-14") + onDay([e], "2026-09-16"), 0, `${tz} doesn't put it on another day`);
      assert.equal(new Date(normalizeTimestamp("2026-09-15")).getDate(), 15, `${tz}: --at 2026-09-15`);
    });
  }
});

test("explicit offsets are kept exactly, and folders use the author's local month", () => {
  for (const tz of ZONES) {
    inZone(tz, () => {
      const e = withOccurred("2026-09-15T23:30:00+09:00");
      assert.equal(e.occurred, "2026-09-15T23:30:00+09:00", tz);
      assert.equal(parseEntry(serializeEntry(e)).occurred, "2026-09-15T23:30:00+09:00", `${tz} round trip`);
      assert.equal(normalizeTimestamp("2026-09-15T23:30+09:00"), "2026-09-15T23:30:00+09:00", `${tz} --at with an offset`);
    });
  }
  // 23:30 on September 30 in Los Angeles is already October in UTC; the folder follows the author.
  assert.equal(entryPath("2026-09-30T23:30:00-07:00", "abc"), "entries/2026/09/abc.md");
});

test("only ISO 8601 timestamps are accepted, so every platform reads them the same way", () => {
  for (const ok of ["2026-09-15T14:30", "2026-09-15T14:30:00", "2026-09-15T21:30:00Z", "2026-09-15T21:30:00.123Z", "2026-09-15T14:30:00-07:00"]) {
    assert.doesNotThrow(() => withOccurred(ok), ok);
  }
  for (const bad of ["Sept 15", "15/09/2026", "2026-9-15", "2026-09-15 14:30", "2026-02-30T10:00:00Z", "2026-09-15T25:00:00Z", "2026-09-15T10:00:00+15:00", "yesterday"]) {
    assert.throws(() => withOccurred(bad), /invalid occurred timestamp/, bad);
  }
  assert.throws(() => withOccurred("2026-09-15T10:00:00Z", "last Tuesday"), /invalid created timestamp/);
  for (const bad of ["2026-02-30", "2026-02-29T10:00", "2026-09-15T24:00", "2026-09-15T10:00:00+15:00"]) {
    assert.throws(() => normalizeTimestamp(bad), /Invalid date\/time/, `--at ${bad}`);
  }
  assert.doesNotThrow(() => normalizeTimestamp("2028-02-29"), "leap day");
});

test("events from different time zones sort by the moment they happened", () => {
  const la = withOccurred("2026-09-15T09:00:00-07:00"); // 16:00 UTC
  const london = withOccurred("2026-09-15T15:00:00+01:00"); // 14:00 UTC
  const tokyo = withOccurred("2026-09-15T23:30:00+09:00"); // 14:30 UTC
  for (const tz of ZONES) {
    const order = inZone(tz, () => sortEntries([london, tokyo, la]).map((e) => e.occurred));
    assert.deepEqual(order, [la.occurred, tokyo.occurred, london.occurred], `${tz}: newest first`);
  }
});

test("days are the viewer's local days, including across daylight-saving changes", () => {
  // 02:00 in Tokyo on the 15th is still the 14th in Los Angeles.
  const early = withOccurred("2026-09-15T02:00:00+09:00");
  assert.equal(inZone("Asia/Tokyo", () => onDay([early], "2026-09-15")), 1);
  assert.equal(inZone("America/Los_Angeles", () => onDay([early], "2026-09-14")), 1);

  inZone("America/Los_Angeles", () => {
    // March 8, 2026 has 23 hours; late that night must still be on the 8th.
    assert.equal(onDay([withOccurred("2026-03-08T23:30:00-07:00")], "2026-03-08"), 1);
    assert.equal(onDay([withOccurred("2026-03-08T23:30:00-07:00")], "2026-03-09"), 0);
    // November 1, 2026 has 25 hours; 1:30 AM happens twice, and both are on the 1st, in order.
    const first = withOccurred("2026-11-01T01:30:00-07:00");
    const second = withOccurred("2026-11-01T01:30:00-08:00");
    assert.equal(onDay([first, second], "2026-11-01"), 2);
    assert.deepEqual(sortEntries([first, second]).map((e) => e.occurred), [second.occurred, first.occurred]);
    // A whole-month search covers the long day too.
    assert.equal(new SearchIndex([first, second]).search("after:2026-11 before:2026-11").length, 2);
  });
});
