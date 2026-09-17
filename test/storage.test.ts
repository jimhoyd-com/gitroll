// Grouped storage: where an entry is filed, which file it lands in, and what
// happens at the edges — month boundaries, time zones, daylight saving, backdating,
// rollover, oversized entries and numeric segment ordering.
import "./helpers.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSegment, renderSegment, segmentHeader } from "../src/core/grouped.ts";
import { derivedEntryId, isEntryId, newEntryId } from "../src/core/ids.ts";
import { compareSegments, nextSeq, parseSegmentPath, periodFor, segmentPath, sortSegments } from "../src/core/segments.ts";
import { resolveOccurrence } from "../src/core/occurrence.ts";
import { DEFAULT_LIMITS, parseStorage, placeEntry } from "../src/core/storage.ts";
import type { SegmentState } from "../src/core/storage.ts";
import { filingDateFor, formatInZone, periodEnd, resolveLocal, zonedDay } from "../src/core/tz.ts";
import { UserError } from "../src/core/util.ts";

// ── Names ──────────────────────────────────────────────────────────────────

test("segments are named the way the spec says, and read back", () => {
  assert.equal(segmentPath("2026-09", 1), ".gitroll/logs/2026/09.md");
  assert.equal(segmentPath("2026-09", 2), ".gitroll/logs/2026/09-002.md");
  assert.equal(segmentPath("2026-09", 1000), ".gitroll/logs/2026/09-1000.md");
  assert.equal(segmentPath("2026-09-16", 3), ".gitroll/logs/2026/09/16-003.md");
  assert.equal(segmentPath("2026-09", 2, true), ".gitroll/logs/2026/09-002.md.gz");

  assert.deepEqual(parseSegmentPath(".gitroll/logs/2026/09.md"), { period: "2026-09", seq: 1, mode: "monthly", compressed: false, path: ".gitroll/logs/2026/09.md" });
  assert.equal(parseSegmentPath(".gitroll/logs/2026/09/16-002.md.gz")?.seq, 2);
  assert.equal(parseSegmentPath(".gitroll/logs/2026/09/16-002.md.gz")?.compressed, true);
  // -001 would be a second name for segment one. There is only ever one name.
  assert.equal(parseSegmentPath(".gitroll/logs/2026/09-001.md"), null);
  assert.equal(parseSegmentPath(".gitroll/events/2026-09-15-x.md"), null);
});

test("segment numbers are compared as numbers, not as text", () => {
  const refs = ["09-010.md", "09-002.md", "09-1000.md", "09.md", "09-009.md"].map((n) => parseSegmentPath(`.gitroll/logs/2026/${n}`)!);
  assert.ok(compareSegments(refs[0], refs[1]) > 0); // 010 after 002
  assert.deepEqual(sortSegments(refs).map((r) => r.seq), [1, 2, 9, 10, 1000]);
  assert.equal(nextSeq(refs, "2026-09"), 1001);
  assert.equal(nextSeq(refs, "2026-10"), 1);
});

// ── Dates and time zones ───────────────────────────────────────────────────

test("a moment is filed on the day it happened in the Roll's zone", () => {
  // The example from the brief: 02:00 UTC on 1 October is still 30 September in Chicago.
  assert.equal(filingDateFor("2026-10-01T02:00:00Z", "America/Chicago"), "2026-09-30");
  assert.equal(periodFor(filingDateFor("2026-10-01T02:00:00Z", "America/Chicago"), "monthly"), "2026-09");
  assert.equal(filingDateFor("2026-10-01T02:00:00Z", "UTC"), "2026-10-01");
  assert.equal(filingDateFor("2026-12-31T23:00:00-06:00", "Asia/Tokyo"), "2027-01-01");
  assert.equal(zonedDay(new Date("2026-10-01T02:00:00Z"), "America/Chicago"), "2026-09-30");
});

test("a day someone typed is that day, in every zone", () => {
  for (const tz of ["UTC", "America/Chicago", "Pacific/Kiritimati", "Pacific/Pago_Pago", "Asia/Kolkata"]) {
    const o = resolveOccurrence("2026-09-15", tz);
    assert.equal(o.date, "2026-09-15", tz);
    assert.equal(o.filed, "2026-09-15", tz);
  }
});

test("the device's zone can't move an entry", () => {
  const before = process.env.TZ;
  try {
    process.env.TZ = "Pacific/Kiritimati";
    assert.equal(filingDateFor("2026-10-01T02:00:00Z", "America/Chicago"), "2026-09-30");
    process.env.TZ = "Pacific/Pago_Pago";
    assert.equal(filingDateFor("2026-10-01T02:00:00Z", "America/Chicago"), "2026-09-30");
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
});

test("daylight saving is answered explicitly, never silently", () => {
  // 1:30am on 1 November 2026 happens twice in Chicago; 2:30am on 8 March never happens.
  const twice = resolveLocal("2026-11-01T01:30", "America/Chicago");
  assert.equal(twice.kind, "ambiguous");
  assert.equal(twice.instants.length, 2);
  const never = resolveLocal("2026-03-08T02:30", "America/Chicago");
  assert.equal(never.kind, "nonexistent");

  const ambiguous = resolveOccurrence("2026-11-01T01:30", "America/Chicago", { ambiguous: "earlier" });
  assert.match(ambiguous.date!, /^2026-11-01T01:30:00-05:00$/);
  assert.match(ambiguous.notices[0], /happened twice/);

  const shifted = resolveOccurrence("2026-03-08T02:30", "America/Chicago");
  assert.match(shifted.notices[0], /never happened/);
  assert.equal(shifted.filed, "2026-03-08");
  assert.ok(resolveOccurrence("2026-07-01T12:00", "America/Chicago").notices.length === 0);
});

test("a timestamp keeps its own offset, and an unusable one is refused", () => {
  assert.equal(resolveOccurrence("2026-09-15T14:30:00-07:00", "America/Chicago").date, "2026-09-15T14:30:00-07:00");
  assert.throws(() => resolveOccurrence("Sept 15", "UTC"), UserError);
  assert.throws(() => resolveOccurrence("2026-02-30", "UTC"), UserError);
  // Ingestion time is never substituted for an occurrence nobody supplied.
  assert.deepEqual(resolveOccurrence("", "UTC"), { date: null, filed: null, notices: [] });
});

test("a date implausibly far ahead is questioned rather than filed", () => {
  const now = new Date("2026-09-16T00:00:00Z");
  assert.throws(() => resolveOccurrence("2030-01-01", "UTC", { now }), /more than a year/);
  assert.equal(resolveOccurrence("2030-01-01", "UTC", { now, allowFuture: true }).filed, "2030-01-01");
  assert.equal(resolveOccurrence("2026-10-01", "UTC", { now }).filed, "2026-10-01");
});

test("a period ends at the end of the period, in the Roll's zone", () => {
  assert.equal(formatInZone(periodEnd("2026-09", "America/Chicago"), "America/Chicago"), "2026-10-01T00:00:00-05:00");
  assert.equal(formatInZone(periodEnd("2026-09-16", "UTC"), "UTC"), "2026-09-17T00:00:00+00:00");
});

// ── Rollover ───────────────────────────────────────────────────────────────

const state = (seq: number, bytes: number, entries: number): SegmentState => ({
  period: "2026-09",
  seq,
  mode: "monthly",
  compressed: false,
  path: segmentPath("2026-09", seq),
  bytes,
  entries,
});

test("a new period starts at segment one", () => {
  assert.deepEqual(placeEntry([], "2026-09", 100, DEFAULT_LIMITS), { period: "2026-09", seq: 1, path: ".gitroll/logs/2026/09.md", created: true });
});

test("rollover happens on either limit, and only on the highest segment", () => {
  const big = [state(1, DEFAULT_LIMITS.maxBytes - 10, 5)];
  assert.equal(placeEntry(big, "2026-09", 5, DEFAULT_LIMITS).seq, 1);
  assert.equal(placeEntry(big, "2026-09", 50, DEFAULT_LIMITS).seq, 2);

  const many = [state(1, 10, DEFAULT_LIMITS.maxEntries)];
  assert.equal(placeEntry(many, "2026-09", 10, DEFAULT_LIMITS).seq, 2);

  // Gaps are never filled and nothing is redistributed: the highest takes it.
  assert.equal(placeEntry([state(1, 10, 1), state(5, 10, 1)], "2026-09", 10, DEFAULT_LIMITS).seq, 5);
});

test("an entry bigger than the whole target is written anyway, on its own", () => {
  const huge = DEFAULT_LIMITS.maxBytes * 4;
  assert.equal(placeEntry([state(1, 10, 1)], "2026-09", huge, DEFAULT_LIMITS).seq, 2);
  // …and the empty segment it opens accepts it rather than rolling for ever.
  assert.equal(placeEntry([state(2, 0, 0)], "2026-09", huge, DEFAULT_LIMITS).seq, 2);
});

test("an edit may leave a segment over target; the next addition opens the next one", () => {
  const over = [state(1, DEFAULT_LIMITS.maxBytes + 5000, 3)];
  assert.equal(placeEntry(over, "2026-09", 1, DEFAULT_LIMITS).seq, 2);
});

// ── The segment document ───────────────────────────────────────────────────

const id1 = "01K5F8ZC7M4Q0X2R9T6V3B1DHE";
const id2 = "01K5F8ZC7N4Q0X2R9T6V3B1DHF";

test("entries round-trip through a segment, whatever their Markdown does", () => {
  const awkward = [
    "---",
    "date: 2026-09-16",
    "---",
    "",
    "# Deploys",
    "",
    "- [x] a checklist",
    "",
    "---",
    "",
    "## A heading, and a thematic break above it",
    "",
    "```md",
    "<!-- gitroll:entry 01K5F8ZC7M4Q0X2R9T6V3B1DHE -->",
    "a marker inside a fence is just text",
    "```",
    "",
  ].join("\n");
  const text = renderSegment(segmentHeader("2026-09", 1), [
    { id: id1, content: awkward },
    { id: id2, content: "# Second\n\nplain\n" },
  ]);
  const parsed = parseSegment(text);
  assert.deepEqual(parsed.sections.map((s) => s.id), [id1, id2]);
  assert.equal(parsed.sections[0].content.trim(), awkward.trim());
  assert.match(parsed.header, /gitroll:log 2026-09/);
  assert.doesNotMatch(parsed.header, /^#\s/m, "the header is not a heading: a heading means an entry");
  assert.deepEqual(parsed.duplicates, []);
});

test("an entry that writes a marker at the margin still round-trips", () => {
  const body = `# Docs\n\n<!-- gitroll:entry ${id2} -->\n\nnot a boundary\n`;
  const parsed = parseSegment(renderSegment("", [{ id: id1, content: body }]));
  assert.equal(parsed.sections.length, 1);
  assert.equal(parsed.sections[0].content.trim(), body.trim());
});

test("the same id twice in one file is reported, not merged", () => {
  const parsed = parseSegment(renderSegment("", [{ id: id1, content: "# A\n" }, { id: id1, content: "# B\n" }]));
  assert.deepEqual(parsed.duplicates, [id1]);
  assert.equal(parsed.sections.length, 2);
});

test("ids are permanent, opaque and derivable", () => {
  assert.ok(isEntryId(newEntryId()));
  assert.notEqual(newEntryId(), newEntryId());
  const a = derivedEntryId("a".repeat(64));
  assert.ok(isEntryId(a));
  assert.equal(a, derivedEntryId("a".repeat(64)));
  assert.notEqual(a, derivedEntryId("b".repeat(64)));
});

// ── Settings ───────────────────────────────────────────────────────────────

test("a Roll with no storage block keeps one file per event", () => {
  const s = parseStorage("template_version: 1\n", "UTC");
  assert.equal(s.mode, "event");
  assert.equal(s.timezone, "UTC");
  assert.deepEqual(s.limits, DEFAULT_LIMITS);
  assert.equal(s.archive.afterDays, 0);
  assert.equal(s.archive.compress, false);
});

test("the storage block is read, and nonsense in it falls back rather than throwing", () => {
  const s = parseStorage(
    ["template_version: 1", "storage:", "  mode: daily", "  timezone: America/Chicago", "  limits:", "    max_bytes: 2048", "    max_entries: -3", "  archive:", "    after_days: 90", "    compress: true"].join("\n"),
    "UTC",
  );
  assert.equal(s.mode, "daily");
  assert.equal(s.timezone, "America/Chicago");
  assert.equal(s.limits.maxBytes, 2048);
  assert.equal(s.limits.maxEntries, DEFAULT_LIMITS.maxEntries);
  assert.equal(s.archive.afterDays, 90);
  assert.equal(s.archive.compress, true);
  assert.equal(parseStorage("storage:\n  timezone: Mars/Olympus\n", "UTC").timezone, "UTC");
});

test("a filing period is named the way a person says it, without losing the period itself", async () => {
  const { periodLabel } = await import("../src/web/lib/format.ts");
  assert.equal(periodLabel("2026-09"), "September 2026");
  assert.equal(periodLabel("2026-01"), "January 2026");
  // A Roll filed by day names the day. Midday inside, so a zone behind UTC
  // can't shift the label to the month before.
  assert.match(periodLabel("2026-09-16"), /16.*September.*2026|September 16, 2026/);
  assert.equal(periodLabel("not-a-period"), "not-a-period", "anything unexpected is shown as it is");
});

test("a removed entry says which month it was filed under, and a removed event doesn't", async () => {
  const { filedUnder } = await import("../src/web/lib/format.ts");
  assert.equal(filedUnder(".gitroll/logs/2026/09.md"), "September 2026");
  assert.equal(filedUnder(".gitroll/logs/2026/09-002.md"), "September 2026", "a month that rolled over is still that month");
  assert.match(filedUnder(".gitroll/logs/2026/09/16.md") ?? "", /September/);
  // An event had a file to itself and was never in a month: a path where a
  // person expects a date would be worse than saying nothing.
  assert.equal(filedUnder(".gitroll/events/2026-09-15-oil-change.md"), null);
});
