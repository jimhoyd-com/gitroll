import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_LINE, guessKind, quickTodoText, readQuick } from "../src/core/quick.ts";
import type { QuickKind } from "../src/core/quick.ts";

// Wednesday 14 October 2026, mid-afternoon.
const now = new Date(2026, 9, 14, 15, 30);
const read = (line: string, kind?: QuickKind) => readQuick(line, { now, kind })!;

test("plain words are an event today", () => {
  const q = read("Fixed the gate latch");
  assert.equal(q.kind, "event");
  assert.equal(q.title, "Fixed the gate latch");
  assert.equal(q.date, null);
});

test("a day that has passed dates the event", () => {
  const q = read("Planted garlic yesterday");
  assert.equal(q.kind, "event");
  assert.equal(q.title, "Planted garlic");
  assert.equal(q.date, "2026-10-13");
  assert.equal(read("Planted garlic today").kind, "event");
});

test("an amount is an expense, read out of the words", () => {
  const q = read("$18 parking at the airport");
  assert.equal(q.kind, "expense");
  assert.deepEqual(q.amount, { value: 18, currency: "USD" });
  assert.equal(q.title, "parking at the airport");
  assert.deepEqual(read("Paid the plumber 240.50 EUR").amount, { value: 240.5, currency: "EUR" });
  assert.deepEqual(read("Groceries €1,250.50").amount, { value: 1250.5, currency: "EUR" });
});

test("a checkbox or todo: makes a to-do", () => {
  assert.equal(read("[ ] buy furnace filter").kind, "todo");
  assert.equal(read("[ ] buy furnace filter").title, "buy furnace filter");
  assert.equal(read("- [ ] clean gutters").title, "clean gutters");
  assert.equal(read("todo: call the bank").title, "call the bank");
});

test("a day ahead or a time is a reminder", () => {
  const q = read("call Dana tomorrow 9am");
  assert.equal(q.kind, "reminder");
  assert.equal(q.title, "call Dana");
  assert.equal(q.remind, "2026-10-15 09:00");
  assert.equal(quickTodoText(q), "call Dana ⏰ 2026-10-15 09:00");
  assert.equal(read("take the bins out at 19:30").remind, "2026-10-14 19:30");
  assert.equal(read("dentist friday").remind, "2026-10-16 09:00");
  assert.equal(read("dentist on wednesday").remind, "2026-10-21 09:00");
  assert.equal(read("water the plants tonight").remind, "2026-10-14 19:00");
  assert.equal(read("[ ] renew passport 2026-11-02").kind, "reminder");
  assert.equal(read("[ ] renew passport 2026-11-02").title, "renew passport");
});

test("a link is a bookmark, its words the title", () => {
  const q = read("https://example.com/fermenting Fermenting guide");
  assert.equal(q.kind, "bookmark");
  assert.equal(q.url, "https://example.com/fermenting");
  assert.equal(q.title, "Fermenting guide");
  assert.equal(read("https://example.com/x").title, "https://example.com/x");
});

test("note: makes a note", () => {
  const q = read("note: Wi-Fi");
  assert.equal(q.kind, "note");
  assert.equal(q.title, "Wi-Fi");
});

test("tags come out of events", () => {
  const q = read("Planted garlic #garden #Fall");
  assert.deepEqual(q.tags, ["garden", "fall"]);
  assert.equal(q.title, "Planted garlic");
  assert.equal(read("[ ] weed #garden").title, "weed #garden");
});

test("another kind reads the line again as that kind", () => {
  const q = read("call Dana tomorrow 9am", "todo");
  assert.equal(q.kind, "todo");
  assert.equal(q.guessed, "reminder");
  assert.equal(quickTodoText(q), "call Dana tomorrow 9am");
  const e = read("$18 parking", "event");
  assert.equal(e.amount, null);
  assert.equal(e.title, "$18 parking");
  const r = read("Fixed the gate latch", "reminder");
  assert.equal(r.remind, "2026-10-14 09:00");
});

test("nothing typed is nothing to save", () => {
  assert.equal(readQuick("   "), null);
  assert.equal(guessKind("Lunch with Dana yesterday at 1pm", now), "event");
});

test("a long line is read quickly, and at most MAX_LINE characters of it", () => {
  const started = Date.now();
  for (const filler of ["\t", " ", "-", "1", ",", "1,"]) {
    const q = readQuick(`a${filler.repeat(50_000)}b`, { now })!;
    assert.ok(q.title.length <= MAX_LINE);
    guessKind(`$${filler.repeat(50_000)}`, now);
  }
  assert.ok(Date.now() - started < 2000, "no backtracking on long runs");
});
