// Setting Ask up is where people give up, so what matters is that every way it
// can fail says which thing is wrong, and that a model somewhere else is never
// used by accident.
import "./helpers.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { AI_PRESETS, checkEndpoint, privacyNote, testConnection } from "../src/node/ai.ts";
import { aiOn } from "../src/node/user-config.ts";

const local = { endpoint: "http://127.0.0.1:11434/v1", model: "llama3.2", provider: "ollama" };

/** A scripted OpenAI-compatible server. */
const server = (reply: () => Response): typeof fetch => (async () => reply()) as unknown as typeof fetch;
const models = (...ids: string[]) => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 });

test("a model on this computer needs no permission; one anywhere else does", () => {
  assert.ok(checkEndpoint(local));
  assert.throws(() => checkEndpoint({ endpoint: "https://api.example.com/v1", model: "m" }), /isn't on this computer/);
  assert.throws(() => checkEndpoint({ endpoint: "http://api.example.com/v1", model: "m", allowRemote: true }), /https/);
  assert.ok(checkEndpoint({ endpoint: "https://api.example.com/v1", model: "m", allowRemote: true }));
  // Every hosted preset says where the key comes from, and none stores one.
  for (const [id, preset] of Object.entries(AI_PRESETS)) {
    if (!preset.local) assert.ok(preset.apiKeyEnv, `${id} must read its key from the environment`);
    assert.equal(JSON.stringify(preset).includes("sk-"), false);
  }
});

test("what leaves this computer is said plainly, either way", () => {
  assert.match(privacyNote(local), /Nothing leaves it/);
  const hosted = privacyNote({ endpoint: "https://api.openai.com/v1", model: "gpt-4o-mini", allowRemote: true });
  assert.match(hosted, /sent to api\.openai\.com/);
  assert.match(hosted, /Attachments themselves are never sent/);
});

test("a connection test says which thing is wrong", async () => {
  const ok = await testConnection(local, server(() => models("llama3.2", "qwen2.5")));
  assert.equal(ok.ok, true);
  assert.match(ok.message, /answered in \d+ ms with llama3\.2 available/);

  const missing = await testConnection({ ...local, model: "llama3.9" }, server(() => models("llama3.2")));
  assert.equal(missing.ok, false);
  assert.equal(missing.modelMissing, true);
  assert.match(missing.message, /doesn't have "llama3\.9"/);
  assert.match(missing.message, /gitroll ai ollama --model/, "and how to fix it");

  const unreachable = await testConnection(local, (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch);
  assert.equal(unreachable.ok, false);
  assert.match(unreachable.message, /Is the model running\?/);
  assert.match(unreachable.message, /ollama pull/, "the preset's own setup hint");

  const refused = await testConnection(
    { endpoint: "https://api.openai.com/v1", model: "gpt-4o-mini", allowRemote: true, apiKeyEnv: "TEST_AI_KEY" },
    server(() => new Response("{}", { status: 401 })),
  );
  assert.equal(refused.ok, false);
  assert.match(refused.message, /TEST_AI_KEY isn't set/, "a missing key is spotted before a request is made");

  process.env.TEST_AI_KEY = "not-a-real-key";
  try {
    const rejected = await testConnection(
      { endpoint: "https://api.openai.com/v1", model: "gpt-4o-mini", allowRemote: true, apiKeyEnv: "TEST_AI_KEY" },
      server(() => new Response("{}", { status: 401 })),
    );
    assert.match(rejected.message, /refused the key in TEST_AI_KEY/);
  } finally {
    delete process.env.TEST_AI_KEY;
  }

  const wrongPath = await testConnection(local, server(() => new Response("not found", { status: 404 })));
  assert.match(wrongPath.message, /usually ends in \/v1/);
});

test("Ask can be switched off without forgetting how it was set up", () => {
  assert.equal(aiOn(undefined), false);
  assert.equal(aiOn({ ...local }), true, "settings with no flag are on");
  assert.equal(aiOn({ ...local, enabled: false }), false);
  assert.equal(aiOn({ ...local, enabled: true }), true);
});
