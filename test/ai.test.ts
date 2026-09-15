import "./helpers.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { LoadedEntry } from "../src/core/layout.ts";
import { askRoll, checkEndpoint, relevantEvents, shortId } from "../src/node/ai.ts";

const event = (id: string, body: string, extra: Partial<LoadedEntry> = {}): LoadedEntry => ({
  version: 1,
  id,
  type: "log",
  created: "2026-09-01T10:00:00-05:00",
  occurred: "2026-09-01T10:00:00-05:00",
  author: "jimmy",
  projects: [],
  tags: [],
  attachments: [],
  data: {},
  extra: {},
  body,
  path: `entries/2026/09/${id}.md`,
  ...extra,
});

const events = [
  event("01a0a5d3-0000-7000-8000-00000000aaaa", "Paid Carlos for tile", { type: "expense", amount: { value: 1500, currency: "USD" }, data: { vendor: "Carlos" } }),
  event("01a0a5d3-0000-7000-8000-00000000bbbb", "Paid Carlos the rest", { type: "expense", amount: { value: 1850, currency: "USD" } }),
  event("01a0a5d3-0000-7000-8000-00000000cccc", "AC serviced"),
];

test("only local AI endpoints are used unless remote is explicitly allowed", () => {
  assert.equal(checkEndpoint({ endpoint: "http://127.0.0.1:11434/v1", model: "m" }).port, "11434");
  assert.throws(() => checkEndpoint({ endpoint: "https://api.example.com/v1", model: "m" }), /isn't on this computer/);
  assert.throws(() => checkEndpoint({ endpoint: "http://api.example.com/v1", model: "m", allowRemote: true }), /https/);
  assert.ok(checkEndpoint({ endpoint: "https://api.example.com/v1", model: "m", allowRemote: true }));
});

test("questions pick the relevant events", () => {
  assert.deepEqual(relevantEvents(events, "How much have I paid Carlos?", new Map()).map((e) => e.body), ["Paid Carlos for tile", "Paid Carlos the rest"]);
});

test("answers cite the events they came from", async () => {
  const requests: { url: string; body: string }[] = [];
  const fakeModel = (async (url: string, init: RequestInit) => {
    requests.push({ url, body: String(init.body) });
    const content = `You paid Carlos $3,350 across two payments [${shortId(events[0].id)}] [${shortId(events[1].id)}].`;
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  }) as unknown as typeof fetch;

  const { answer, sources } = await askRoll({ endpoint: "http://127.0.0.1:11434/v1", model: "llama3.2" }, events, "How much have I paid Carlos?", new Map(), fakeModel);
  assert.match(answer, /\$3,350/);
  assert.deepEqual(sources.map((e) => e.body), ["Paid Carlos for tile", "Paid Carlos the rest"]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://127.0.0.1:11434/v1/chat/completions");
  assert.ok(!requests[0].body.includes("AC serviced"), "unrelated events aren't sent");
});
