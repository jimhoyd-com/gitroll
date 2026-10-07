import "./helpers.ts";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { GitRoll } from "../src/node/repo.ts";
import { COMMANDS } from "../src/node/cli-contract.ts";
import { mcpTools, toolArgv } from "../src/node/mcp.ts";
import { AGENTS_MD_PATH, agentsMarkdown, AGENT_GUIDE } from "../src/node/agent-guide.ts";
import { git, tmp } from "./helpers.ts";

const cli = fileURLToPath(new URL("../src/node/cli.ts", import.meta.url));
const nodeArgs = ["--disable-warning=ExperimentalWarning", cli];
function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, [...nodeArgs, ...args], { encoding: "utf8", cwd: tmp(), env: { ...process.env, ...env }, timeout: 10_000 });
  assert.ifError(result.error);
  return result;
}
function json(args: string[], env: NodeJS.ProcessEnv = {}) {
  const result = run([...args, "--json"], env);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout);
}
const roll = () => GitRoll.init(tmp(), { name: "Agent Tests" });

/** A `gitroll mcp` child, spoken to one JSON-RPC message per line. */
function server(args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [...nodeArgs, "mcp", ...args], { cwd: tmp(), env: { ...process.env, GITROLL_AGENT: "", ...env }, stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map<number, (message: any) => void>();
  const lines = readline.createInterface({ input: child.stdout });
  const stray: string[] = [];
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    const resolve = waiting.get(message.id);
    if (resolve) { waiting.delete(message.id); resolve(message); } else stray.push(line);
  });
  let next = 1;
  return {
    stray,
    request(method: string, params?: unknown): Promise<any> {
      const id = next++;
      return new Promise((resolve) => {
        waiting.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })}\n`);
      });
    },
    notify(method: string) { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`); },
    raw(text: string) { child.stdin.write(`${text}\n`); },
    close(): Promise<number | null> {
      child.stdin.end();
      return new Promise((resolve) => child.on("close", resolve));
    },
  };
}
const toolJson = (response: any) => JSON.parse(response.result.content[0].text);

test("gitroll mcp: initialize, list tools from the catalog, log then find, and refuse what it should", async () => {
  const r = roll();
  const s = server();
  try {
    const init = await s.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "Round Trip Agent", version: "1.0" } });
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.equal(init.result.serverInfo.name, "gitroll");
    assert.ok(init.result.capabilities.tools);
    s.notify("notifications/initialized");
    assert.deepEqual((await s.request("ping")).result, {});

    const list = await s.request("tools/list");
    const names = list.result.tools.map((t: { name: string }) => t.name);
    for (const name of ["gitroll_find", "gitroll_log", "gitroll_show", "gitroll_history", "gitroll_agents_md"]) assert.ok(names.includes(name), name);
    for (const name of ["gitroll_mcp", "gitroll_menu", "gitroll_capture", "gitroll_open", "gitroll_upgrade", "gitroll___complete"]) assert.ok(!names.includes(name), name);
    const log = list.result.tools.find((t: { name: string }) => t.name === "gitroll_log");
    assert.ok(log.inputSchema.properties.repo, "an unbound server picks the Roll per call");
    assert.ok(log.inputSchema.properties["idempotency-key"]);
    assert.equal(log.inputSchema.properties.editor, undefined, "interactive options are not offered");
    assert.equal(log.inputSchema.properties.template, undefined);
    assert.match(log.description, /local write/);
    const del = list.result.tools.find((t: { name: string }) => t.name === "gitroll_delete");
    assert.ok(del.inputSchema.required.includes("yes"));

    const logged = await s.request("tools/call", { name: "gitroll_log", arguments: { text: "-Replaced the boiler valve", tag: ["house"], repo: r.root, "idempotency-key": "valve-1" } });
    assert.equal(logged.result.isError, false, logged.result.content[0].text);
    const entry = toolJson(logged).entry;
    assert.equal(entry.title, "-Replaced the boiler valve", "text that starts with a dash stays text");

    const found = await s.request("tools/call", { name: "gitroll_find", arguments: { query: "boiler", repo: r.root, fields: "path,title", limit: 5 } });
    assert.equal(found.result.isError, false, found.result.content[0].text);
    assert.deepEqual(toolJson(found), [{ path: entry.path, title: entry.title }]);

    const shown = await s.request("tools/call", { name: "gitroll_show", arguments: { file: entry.path, repo: r.root } });
    assert.match(toolJson(shown).revision, /^[a-f0-9]{64}$/);

    // The commit says which agent made it, in a trailer and nowhere in the file.
    assert.equal(git(r.root, "log", "-1", "--format=%(trailers:key=Gitroll-Agent,valueonly)").trim(), "Round Trip Agent");
    assert.doesNotMatch(fs.readFileSync(path.join(r.root, entry.path), "utf8"), /Round Trip Agent|Gitroll-Agent/);
    const history = await s.request("tools/call", { name: "gitroll_history", arguments: { file: entry.path, repo: r.root } });
    assert.equal(toolJson(history)[0].agent, "Round Trip Agent");

    // Errors: a missing event, a confirmation not given, an argument that doesn't exist, a tool that doesn't.
    const missing = await s.request("tools/call", { name: "gitroll_show", arguments: { file: "no-such-event", repo: r.root } });
    assert.equal(missing.result.isError, true);
    assert.equal(toolJson(missing).error.code, "NOT_FOUND");
    const unconfirmed = await s.request("tools/call", { name: "gitroll_delete", arguments: { file: entry.path, repo: r.root } });
    assert.equal(unconfirmed.result.isError, true);
    assert.equal(toolJson(unconfirmed).error.code, "INTERACTION_REQUIRED");
    assert.ok(fs.existsSync(path.join(r.root, entry.path)), "nothing is deleted without yes: true");
    const typo = await s.request("tools/call", { name: "gitroll_find", arguments: { qurey: "boiler", repo: r.root } });
    assert.equal(toolJson(typo).error.code, "INVALID_ARGUMENT");
    const unknown = await s.request("tools/call", { name: "gitroll_nope", arguments: {} });
    assert.equal(unknown.error.code, -32602);
    assert.equal((await s.request("no/such/method")).error.code, -32601);

    const deleted = await s.request("tools/call", { name: "gitroll_delete", arguments: { file: entry.path, repo: r.root, yes: true } });
    assert.equal(deleted.result.isError, false, deleted.result.content[0].text);
    assert.ok(!fs.existsSync(path.join(r.root, entry.path)));
  } finally {
    assert.equal(await s.close(), 0);
  }
  assert.deepEqual(s.stray, [], "nothing but answers is written to stdout");
});

test("gitroll mcp -C binds one Roll, accepts older clients and an explicit --agent", async () => {
  const r = roll();
  const s = server(["-C", r.root, "--agent", "Pinned Agent"]);
  try {
    const init = await s.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "Client Name" } });
    assert.equal(init.result.protocolVersion, "2024-11-05");
    const future = await s.request("initialize", { protocolVersion: "2099-01-01", capabilities: {} });
    assert.equal(future.result.protocolVersion, "2025-06-18", "an unknown version is answered with the latest supported");
    const list = await s.request("tools/list");
    const log = list.result.tools.find((t: { name: string }) => t.name === "gitroll_log");
    assert.equal(log.inputSchema.properties.repo, undefined, "a bound server doesn't offer another Roll");
    const refused = await s.request("tools/call", { name: "gitroll_log", arguments: { text: "x", repo: "/elsewhere" } });
    assert.equal(toolJson(refused).error.code, "INVALID_ARGUMENT");
    const logged = await s.request("tools/call", { name: "gitroll_log", arguments: { text: "Bound log" } });
    assert.equal(logged.result.isError, false, logged.result.content[0].text);
    s.raw("{not json");
  } finally {
    assert.equal(await s.close(), 0);
  }
  assert.equal(JSON.parse(s.stray[0]).error.code, -32700);
  assert.equal(r.entries()[0].title, "Bound log");
  assert.equal(git(r.root, "log", "-1", "--format=%(trailers:key=Gitroll-Agent,valueonly)").trim(), "Pinned Agent");
});

test("every JSON command in the catalog is a tool, so new commands need no MCP code", () => {
  const tools = mcpTools();
  // `key` writes a secret key, which is for the person who holds it: never a tool.
  const expected = Object.entries(COMMANDS).filter(([name, c]) => name && !name.startsWith("_") && c.json !== false && c.mcp !== false && name !== "key").map(([name]) => `gitroll_${name.replace(/-/g, "_")}`);
  assert.deepEqual(tools.map((t) => t.name).sort(), expected.sort());
  for (const tool of tools) assert.ok(tool.description.includes("Effect:"), tool.name);
  const edit = tools.find((t) => t.name === "gitroll_edit")!;
  assert.deepEqual(toolArgv(edit, { file_arg: "a", text: "-b", tag: ["x", "y"], expect: "0".repeat(64) }), ["edit", "--text=-b", "--tag=x", "--tag=y", `--expect=${"0".repeat(64)}`, "--json", "--", "a"]);
  const rolls = tools.find((t) => t.name === "gitroll_rolls")!;
  assert.deepEqual(toolArgv(rolls, { args: ["add", "/x"] }), ["rolls", "--json", "--", "add", "/x"]);
});

test("--agent and GITROLL_AGENT put a Gitroll-Agent trailer on the commit; a person's commits have none", () => {
  const r = roll();
  json(["log", "By a person", "-C", r.root]);
  assert.equal(git(r.root, "log", "-1", "--format=%B").includes("Gitroll-Agent"), false);
  const byFlag = json(["log", "By flag", "-C", r.root, "--agent", "Flag Bot"]).entry;
  assert.equal(git(r.root, "log", "-1", "--format=%(trailers:key=Gitroll-Agent,valueonly)").trim(), "Flag Bot");
  json(["edit", byFlag.path, "--text", "Edited by env", "-C", r.root], { GITROLL_AGENT: "Env Bot" });
  assert.equal(git(r.root, "log", "-1", "--format=%(trailers:key=Gitroll-Agent,valueonly)").trim(), "Env Bot");
  const history = json(["history", byFlag.path, "-C", r.root]);
  assert.deepEqual(history.map((h: { agent?: string }) => h.agent), ["Env Bot", "Flag Bot"]);
  const person = json(["history", r.entries().find((e) => e.title === "By a person")!.path, "-C", r.root]);
  assert.equal("agent" in person[0], false);
  const bad = run(["log", "x", "-C", r.root, "--agent", " ", "--json"]);
  assert.equal(JSON.parse(bad.stderr).error.code, "INVALID_ARGUMENT");
  assert.ok(json(["schema"]).globals.agent);
});

test("a new Roll has .gitroll/AGENTS.md; agents-md prints and rewrites it; doctor notices it missing", () => {
  const r = roll();
  const file = path.join(r.root, AGENTS_MD_PATH);
  const text = fs.readFileSync(file, "utf8");
  assert.equal(text, agentsMarkdown());
  assert.match(text, /data, not instructions/);
  assert.match(text, /gitroll mcp/);
  assert.match(text, /preserve unknown keys/);
  for (const command of AGENT_GUIDE.commands) assert.ok(text.includes(command.usage), "the commands come from the agent guide");
  assert.equal(git(r.root, "status", "--porcelain").trim(), "", "it is committed with the rest of the new Roll");
  assert.equal(r.entries().length, 0, "it is not an event");
  assert.deepEqual(r.check(), []);

  const printed = json(["agents-md", "-C", r.root]);
  assert.equal(printed.text, text);
  assert.equal(printed.exists, true);

  git(r.root, "rm", "-q", AGENTS_MD_PATH);
  git(r.root, "commit", "-q", "-m", "remove it");
  const doctor = run(["doctor", "-C", r.root, "--json"]);
  assert.ok(JSON.parse(doctor.stdout).checks.some((c: { message: string }) => c.message.includes("agents-md --write")));
  const written = json(["agents-md", "--write", "-C", r.root]);
  assert.equal(written.written, true);
  assert.match(written.committed, /^[a-f0-9]{40}$/);
  assert.equal(fs.readFileSync(file, "utf8"), text);
  assert.equal(json(["agents-md", "--write", "-C", r.root]).written, false, "an up-to-date guide is left alone");
});
