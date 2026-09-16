import assert from "node:assert/strict";
import { test } from "node:test";
import { planIngest } from "../src/core/adapter.ts";
import { webhookAdapter } from "../src/core/adapters/webhook.ts";
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
import { parseAmount } from "../src/core/util.ts";
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
  assert.deepEqual(e.projects, ["house"]);
  assert.deepEqual(e.tags, ["maintenance", "warranty", "hvac"]);
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
  assert.deepEqual(e.tags, ["warranty"]);
  assert.deepEqual(e.amount, { value: 325, currency: "USD" });
});

test("an event written by GitRoll is the same shape as one written by hand", () => {
  const plain = buildEntry({ text: "Fixed the gate", date: "2026-09-15" }, [], () => false);
  assert.equal(plain.path, ".gitroll/events/2026-09-15-fixed-the-gate.md");
  assert.equal(plain.source, "# Fixed the gate\n", "no front matter when there is no metadata");

  const withMeta = buildEntry(
    { text: "Paid Carlos for tiling", date: "2026-09-15", projects: ["bathroom"], amount: { value: 1850, currency: "USD" } },
    [{ path: ".gitroll/files/invoice.pdf", name: "Invoice", image: false }],
    () => false,
  );
  const e = parseEntry(withMeta.path, withMeta.source);
  assert.deepEqual(e.projects, ["bathroom"]);
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

test("amounts and search filters", () => {
  assert.deepEqual(parseAmount("$1,850"), { value: 1850, currency: "USD" });
  assert.deepEqual(parseAmount("99.50 eur"), { value: 99.5, currency: "EUR" });
  assert.equal(parseAmount("lots"), null);

  const tokens = tokenize('project:house "shower tile" #payment https://example.com');
  assert.deepEqual(tokens, [
    { key: "project", value: "house" },
    { value: "shower tile" },
    { key: "tag", value: "payment" },
    { value: "https://example.com" },
  ]);
  assert.equal(serialize(tokens), 'project:house "shower tile" tag:payment https://example.com');
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
  const index = new SearchIndex(entries, { projectNames: new Map([["bathroom-remodel", "Bathroom Remodel"]]) });
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

test("webhook adapter requires ids so ingestion is idempotent", () => {
  const drafts = webhookAdapter.toEvents([{ id: "inv-1", text: "Paid plumber", amount: "$425", project: "house" }], { options: {} });
  assert.equal(drafts[0].amount?.value, 425);
  assert.equal(planIngest([], [...drafts, ...drafts]).create.length, 1);
  assert.throws(() => webhookAdapter.toEvents({ text: "no id" }, { options: {} }), /id/);
});
