import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEntry, relativeLink, resolveLink, updateEntrySource } from "../src/core/entry.ts";
import type { Entry } from "../src/core/entry.ts";
import {
  applyChanges,
  attachmentName,
  buildEntry,
  entryPath,
  filePath,
  findEntry,
  moveEntry,
  parseConfig,
  templateStatus,
} from "../src/core/layout.ts";
import { SearchIndex, parseQuery, serialize, tokenize } from "../src/core/search.ts";
import { formatAmount, parseAmount } from "../src/core/util.ts";
import { validateRepo } from "../src/core/validate.ts";

const MINIMAL = `# AC serviced

Replaced the capacitor. Paid $325.
One-year warranty on the repair.

[Receipt](../files/ac-receipt.pdf)
`;

test("a plain Markdown file with no front matter is a valid event", () => {
  const e = parseEntry(".gitroll/events/2026-09-15-ac-serviced.md", MINIMAL);
  assert.equal(e.title, "AC serviced");
  assert.equal(e.date, "2026-09-15");
  assert.equal(e.dateFrom, "filename");
  assert.equal(e.id, e.path);
  assert.deepEqual(e.attachments, [{ path: ".gitroll/files/ac-receipt.pdf", name: "Receipt", type: "application/pdf", image: false }]);
  assert.equal(e.body, MINIMAL.trimEnd());
});

test("front matter is optional metadata, and overrides the date in the file name", () => {
  const source = `---
date: 2026-09-14
projects: [house]
tags: [maintenance, warranty]
amount: 325
currency: USD
vendor: Carlos   # a key GitRoll knows nothing about
---

# AC serviced

Replaced the capacitor. #hvac
`;
  const e = parseEntry(".gitroll/events/2026-09-15-ac-serviced.md", source);
  assert.equal(e.date, "2026-09-14");
  assert.equal(e.dateFrom, "metadata");
  // `projects:` was a second way to categorize; it reads as tags now, so a Roll
  // that already used it keeps everything it filed.
  assert.deepEqual(e.tags, ["maintenance", "warranty", "house", "hvac"]);
  assert.deepEqual(e.amount, { value: 325, currency: "USD" });
  assert.equal(e.meta.vendor, "Carlos");
});

test("an event with no date anywhere is undated rather than invalid", () => {
  const e = parseEntry(".gitroll/events/notes.md", "Something happened.\n");
  assert.equal(e.date, null);
  assert.equal(e.dateFrom, "none");
  assert.equal(e.title, "Something happened.");
});

test("editing keeps handwritten formatting, comments and unknown keys", () => {
  const source = `---
date: 2026-09-15   # the day of the service call
vendor: Carlos
projects: [house]
---

# AC serviced

Replaced the capacitor.

[Receipt](../files/ac-receipt.pdf)
`;
  const next = applyChanges(source, { tags: ["warranty"], amount: { value: 325, currency: "USD" } }, [], ".gitroll/events/2026-09-15-ac.md");
  assert.match(next, /# the day of the service call/, "comments survive");
  assert.match(next, /vendor: Carlos/);
  assert.match(next, /\[Receipt\]\(\.\.\/files\/ac-receipt\.pdf\)/, "the body is untouched");
  const e = parseEntry(".gitroll/events/2026-09-15-ac.md", next);
  // The `projects: [house]` this file already had is kept as written and read
  // as a tag; editing the tags doesn't quietly drop it.
  assert.match(next, /projects: \[ ?house ?\]/);
  assert.deepEqual(e.tags, ["warranty", "house"]);
  assert.deepEqual(e.amount, { value: 325, currency: "USD" });
});

test("an event written by GitRoll is the same shape as one written by hand", () => {
  const plain = buildEntry({ text: "Fixed the gate", date: "2026-09-15" }, [], () => false);
  assert.equal(plain.path, ".gitroll/events/2026-09-15-fixed-the-gate.md");
  assert.equal(plain.source, "# Fixed the gate\n", "no front matter when there is no metadata");

  const withMeta = buildEntry(
    { text: "Paid Carlos for tiling", date: "2026-09-15", tags: ["bathroom"], amount: { value: 1850, currency: "USD" } },
    [{ path: ".gitroll/files/invoice.pdf", name: "Invoice", image: false }],
    () => false,
  );
  const e = parseEntry(withMeta.path, withMeta.source);
  assert.deepEqual(e.tags, ["bathroom"]);
  assert.deepEqual(e.amount, { value: 1850, currency: "USD" });
  assert.deepEqual(e.attachments.map((a) => a.path), [".gitroll/files/invoice.pdf"]);
  assert.match(withMeta.source, /\[Invoice\]\(\.\.\/files\/invoice\.pdf\)/);
});

test("names never collide, and nothing is overwritten", () => {
  const taken = new Set([".gitroll/events/2026-09-15-ac-serviced.md", ".gitroll/files/ac-receipt.pdf", ".gitroll/files/ac-receipt-2.pdf"]);
  assert.equal(entryPath("2026-09-15", "AC serviced", (p) => taken.has(p)), ".gitroll/events/2026-09-15-ac-serviced-2.md");
  assert.equal(filePath("AC Receipt.PDF", (p) => taken.has(p)), ".gitroll/files/ac-receipt-3.pdf");
  assert.equal(attachmentName("../../etc/passwd"), "passwd");
  assert.equal(attachmentName("Photo of the leak.JPEG"), "photo-of-the-leak.jpeg");
});

test("moving an event keeps its links pointing at the same files", () => {
  const moved = moveEntry(MINIMAL, ".gitroll/events/2026-09-15-ac-serviced.md", ".gitroll/events/house/2026-09-15-ac-serviced.md");
  const e = parseEntry(".gitroll/events/house/2026-09-15-ac-serviced.md", moved);
  assert.deepEqual(e.attachments.map((a) => a.path), [".gitroll/files/ac-receipt.pdf"]);
  assert.match(moved, /\.\.\/\.\.\/files\/ac-receipt\.pdf/);
});

test("links are resolved inside the repository and nowhere else", () => {
  const from = ".gitroll/events/2026-09-15-ac.md";
  assert.equal(resolveLink(from, "../files/a.pdf"), ".gitroll/files/a.pdf");
  assert.equal(resolveLink(from, "./notes.md"), ".gitroll/events/notes.md");
  assert.equal(resolveLink(from, "../../../etc/passwd"), null);
  assert.equal(resolveLink(from, "/etc/passwd"), null);
  assert.equal(resolveLink(from, "https://example.com/a.pdf"), null);
  assert.equal(relativeLink(from, ".gitroll/files/a b.pdf"), "../files/a%20b.pdf");
});

test("an event is found by path, file name or a distinctive part of one", () => {
  const entries = [
    parseEntry(".gitroll/events/2026-09-15-ac-serviced.md", MINIMAL),
    parseEntry(".gitroll/events/2026-08-01-gate.md", "# Gate\n"),
  ];
  assert.equal(findEntry(entries, ".gitroll/events/2026-08-01-gate.md").title, "Gate");
  assert.equal(findEntry(entries, "2026-08-01-gate").title, "Gate");
  assert.equal(findEntry(entries, "ac-serviced").title, "AC serviced");
  assert.throws(() => findEntry(entries, "nothing-like-this"), /No event matches/);
});

test("the template version is read, never guessed, and blocks writes when it is too new", () => {
  assert.equal(parseConfig("template_version: 1\n", "x").templateVersion, 1);
  assert.equal(templateStatus(parseConfig("template_version: 1\n", "x")).code, "ok");

  const unknown = templateStatus(parseConfig("name: My Roll\n", "x"));
  assert.equal(unknown.code, "unknown");
  assert.equal(unknown.version, null);
  assert.match(unknown.message, /unknown/);
  assert.match(unknown.message, /gitroll template --set 1/, "says how to record it");

  const future = templateStatus(parseConfig("template_version: 99\n", "x"));
  assert.equal(future.code, "unsupported");
  assert.equal(future.writable, false, "a newer template blocks writes");
  assert.match(future.message, /Update GitRoll/);
});

test("the validator reports missing files and unreadable front matter", () => {
  const files: Record<string, string> = {
    ".gitroll/config.yaml": "template_version: 1\n",
    ".gitroll/events/2026-09-15-ac-serviced.md": MINIMAL,
    ".gitroll/events/2026-09-16-broken.md": "---\ndate: nope\n---\n\n# Broken\n",
    ".gitroll/files/ac-receipt.pdf": "%PDF",
  };
  const problems = validateRepo({ paths: Object.keys(files), read: (p) => files[p] });
  assert.deepEqual(problems.map((p) => p.path), [".gitroll/events/2026-09-16-broken.md"]);

  const missing = validateRepo({ paths: [".gitroll/config.yaml", ".gitroll/events/2026-09-15-ac-serviced.md"], read: (p) => files[p] });
  assert.match(missing[0].error, /isn't in this Roll/);
});

test("an amount reads back as money, and what is read back parses again", () => {
  // $41.90 was coming back as "41.9", which reads as a typo rather than a sum.
  assert.equal(formatAmount({ value: 41.9, currency: "USD" }), "41.90 USD");
  assert.equal(formatAmount({ value: 1200, currency: "USD" }), "1,200.00 USD");
  assert.equal(formatAmount({ value: 99.5, currency: "EUR" }), "99.50 EUR");
  // Yen has no minor unit, so ".00" would be wrong rather than tidy.
  assert.equal(formatAmount({ value: 1200, currency: "JPY" }), "1,200 JPY");
  // A code nobody recognises is written in a Roll by hand sooner or later; the
  // amount is still shown rather than withheld.
  assert.match(formatAmount({ value: 50, currency: "XYZ" }), /50(\.00)? XYZ/);

  // The composer shows the amount this way and reads it back on save.
  for (const a of [{ value: 41.9, currency: "USD" }, { value: 1200, currency: "USD" }, { value: 99.5, currency: "EUR" }]) {
    assert.deepEqual(parseAmount(formatAmount(a)), a, `round trip: ${formatAmount(a)}`);
  }
});

test("amounts and search filters", () => {
  assert.deepEqual(parseAmount("$1,850"), { value: 1850, currency: "USD" });
  assert.deepEqual(parseAmount("99.50 eur"), { value: 99.5, currency: "EUR" });
  assert.equal(parseAmount("lots"), null);

  // topic: and project: are what a Roll's searches used to say; both mean tag:.
  const tokens = tokenize('topic:house "shower tile" #payment https://example.com');
  assert.deepEqual(tokens, [
    { key: "tag", value: "house" },
    { value: "shower tile" },
    { key: "tag", value: "payment" },
    { value: "https://example.com" },
  ]);
  assert.equal(serialize(tokens), 'tag:house "shower tile" tag:payment https://example.com');
  assert.deepEqual(parseQuery("amount:>500").amounts, [{ op: ">", value: 500 }]);

  const entries: Entry[] = [
    parseEntry(
      ".gitroll/events/2026-09-02-paid-carlos.md",
      "---\nprojects: [bathroom-remodel]\ntags: [payment]\namount: 1500\nvendor: Carlos\n---\n\n# Paid Carlos\n",
    ),
    parseEntry(
      ".gitroll/events/2026-09-15-paid-carlos-the-rest.md",
      "---\nprojects: [bathroom-remodel]\namount: 1850\nvendor: Carlos\n---\n\n# Paid Carlos the rest\n\n[Receipt](../files/receipt.pdf)\n",
    ),
    parseEntry(".gitroll/events/2026-08-01-ac-serviced.md", "---\nprojects: [house]\nvendor: Cool Air\n---\n\n# AC serviced\n"),
  ];
  const index = new SearchIndex(entries);
  const names = (q: string) => index.search(q).map((e) => e.title);
  assert.deepEqual(names("carlos"), ["Paid Carlos", "Paid Carlos the rest"]);
  assert.deepEqual(names("amount:>1600"), ["Paid Carlos the rest"]);
  assert.deepEqual(names("after:2026-09-10 has:receipt"), ["Paid Carlos the rest"]);
  assert.deepEqual(names("vendor:cool"), ["AC serviced"]);
  assert.deepEqual(names("#payment"), ["Paid Carlos"]);
  assert.deepEqual(names("on:2026-08"), ["AC serviced"]);
});

test("writing front matter onto a file that had none", () => {
  const next = updateEntrySource("# Fixed the gate\n", { tags: ["house"] });
  assert.equal(next, "---\ntags:\n  - house\n---\n\n# Fixed the gate\n");
  assert.equal(updateEntrySource(next, { tags: [] }), "# Fixed the gate\n", "the block goes away when nothing is left");
});

// Topics were a second way to categorize an entry, and are now read as tags.
// A Roll written before that must keep everything it filed, and the searches
// somebody saved must keep finding it.
test("a projects: somebody already wrote is kept, and read as tags", () => {
  const source = "---\nprojects: [garden, house]\ntags: [mowing]\n---\n\n# Mowed the lawn\n";
  const e = parseEntry(".gitroll/events/2026-09-15-mowed.md", source);
  assert.deepEqual(e.tags, ["mowing", "garden", "house"]);

  const index = new SearchIndex([e]);
  for (const query of ["tag:garden", "topic:garden", "project:garden", "#garden"]) {
    assert.deepEqual(index.search(query).map((x) => x.title), ["Mowed the lawn"], query);
  }
  // Editing it doesn't drop the key: what somebody wrote stays written.
  const next = applyChanges(source, { tags: ["mowing", "weekly"] }, [], ".gitroll/events/2026-09-15-mowed.md");
  assert.match(next, /projects: \[ ?garden, ?house ?\]/);
  assert.deepEqual(parseEntry(".gitroll/events/2026-09-15-mowed.md", next).tags, ["mowing", "weekly", "garden", "house"]);
});

test("GitRoll writes tags, never projects", () => {
  const draft = buildEntry({ text: "Paid the plumber", date: "2026-09-15", tags: ["house", "trade"] }, [], () => false);
  assert.match(draft.source, /tags:/);
  assert.doesNotMatch(draft.source, /projects:/);
});
