// The hosted-secrets contract and client. The gateway itself is a separate
// service; here it is a MOCK on 127.0.0.1 that speaks the documented protocol,
// to prove the client's behavior. None of this is a live deployment or a real
// GitHub OIDC exchange.

import "./helpers.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkClaims } from "../src/core/secrets/protocol.ts";
import type { WorkloadPolicy } from "../src/core/secrets/protocol.ts";
import { gatewayUrl } from "../src/node/cli-secrets.ts";
import { tmp } from "./helpers.ts";

const cli = fileURLToPath(new URL("../src/node/cli.ts", import.meta.url));
const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/secrets/github-oidc-claims.json", import.meta.url), "utf8"));

test("claim rules: the approved job is allowed, and every fixture denial is denied for its reason", () => {
  const policy = fixture.policy as WorkloadPolicy;
  for (const c of fixture.cases) {
    const claims = { ...fixture.base, ...c.change };
    for (const k of c.remove ?? []) delete claims[k];
    const d = checkClaims(policy, claims, fixture.now, () => !!c.seen);
    if (c.allow) assert.deepEqual(d, { allow: true }, c.name);
    else assert.equal(d.allow ? "allowed" : d.code, c.code, c.name);
  }
  // A policy whose workflow isn't pinned to a commit allows nothing.
  const loose = { ...policy, jobWorkflowRef: "example-org/deploy-workflows/.github/workflows/deploy.yml@refs/heads/main" };
  assert.equal(checkClaims(loose, { ...fixture.base, job_workflow_ref: loose.jobWorkflowRef }, fixture.now, () => false).allow, false);
});

test("the gateway URL must be https, except a gateway on this computer", () => {
  assert.throws(() => gatewayUrl({ gateway: "http://gateway.example.com" }), /https/);
  assert.throws(() => gatewayUrl({ gateway: "https://user:pw@gateway.example.com" }), /credentials/);
  assert.equal(gatewayUrl({ gateway: "https://gateway.example.com" }).host, "gateway.example.com");
  assert.equal(gatewayUrl({ gateway: "http://127.0.0.1:9" }).port, "9");
});

/** A mock gateway and a mock GitHub token endpoint, recording what they were sent. */
async function mock(opts: { refuse?: boolean; wrongVersion?: boolean } = {}) {
  const seen: { path: string; auth?: string; body?: any }[] = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    seen.push({ path: req.url!, auth: req.headers.authorization, body: body ? JSON.parse(body) : undefined });
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (req.url!.startsWith("/token")) return send(200, { value: "header.synthetic-claims.signature" });
    if (req.url === "/v1/exchange") {
      if (opts.refuse) return send(403, { error: { code: "policy_denied", message: "workflow" } });
      return send(200, { session: "synthetic-session", expiresAt: new Date(Date.now() + 300_000).toISOString(), bundle: { id: "app", version: 3, sourceRevision: "a".repeat(40) } });
    }
    if (req.url === "/v1/bundles/app/versions/3") {
      if (req.headers.authorization !== "Bearer synthetic-session") return send(401, { error: { code: "invalid_token", message: "" } });
      return send(200, { id: "app", version: opts.wrongVersion ? 2 : 3, sourceRevision: "a".repeat(40), values: { DEPLOY_KEY: "synthetic-deploy-key" } });
    }
    send(404, { error: { code: "invalid_request", message: "" } });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, seen, close: () => server.close() };
}

function run(args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", cli, ...args], { env: { ...process.env, ...env }, cwd: tmp() });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("exit", (status) => resolve({ status, stdout, stderr }));
  });
}

test("secrets run (against a mock gateway): exchanges the job's token, runs with the bundle, passes the exit status", async () => {
  const g = await mock();
  try {
    const probe = path.join(tmp(), "probe.mjs");
    fs.writeFileSync(probe, "console.log(JSON.stringify({ key: process.env.DEPLOY_KEY, token: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ?? null })); process.exit(4);");
    const env = { ACTIONS_ID_TOKEN_REQUEST_URL: `${g.base}/token?api-version=2.0`, ACTIONS_ID_TOKEN_REQUEST_TOKEN: "synthetic-request-token" };
    const r = await run(["secrets", "run", "--environment", "staging", "--gateway", g.base, "--", process.execPath, probe], env);
    assert.equal(r.status, 4, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { key: "synthetic-deploy-key", token: null }, "the child gets the bundle, not the means to fetch more");
    assert.match(g.seen[0].path, /audience=gitroll-secrets/);
    assert.equal(g.seen[0].auth, "bearer synthetic-request-token");
    assert.deepEqual(g.seen[1].body, { token: "header.synthetic-claims.signature", environment: "staging" });
    assert.ok(!r.stderr.includes("synthetic-deploy-key") && !r.stderr.includes("synthetic-session"));
  } finally {
    g.close();
  }
});

test("secrets run stops, and runs nothing, when the gateway refuses or answers for the wrong version", async () => {
  const marker = path.join(tmp(), "ran");
  const args = (base: string) => ["secrets", "run", "--json", "--environment", "staging", "--gateway", base, "--", process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`];
  const env = (base: string) => ({ ACTIONS_ID_TOKEN_REQUEST_URL: `${base}/token`, ACTIONS_ID_TOKEN_REQUEST_TOKEN: "t" });
  for (const opts of [{ refuse: true }, { wrongVersion: true }]) {
    const g = await mock(opts);
    try {
      const r = await run(args(g.base), env(g.base));
      assert.equal(r.status, 1);
      assert.ok(!fs.existsSync(marker), "nothing ran");
      assert.match(JSON.parse(r.stderr).error.message, /Nothing was run/);
    } finally {
      g.close();
    }
  }
  // Outside GitHub Actions there's no token: refused before any request.
  const r = await run(args("http://127.0.0.1:9"), { ACTIONS_ID_TOKEN_REQUEST_URL: "", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /id-token: write/);
});
