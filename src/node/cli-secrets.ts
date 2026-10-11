// `gitroll secrets …`: the client for a GitRoll secrets gateway, the separate
// hosted service that releases deployment secrets to CI jobs (see
// docs/SECRETS-GATEWAY.md). The gateway is not part of this repository, and
// this client is not a personal vault: nothing here reads or holds a vault key.
//
//   gitroll secrets run --environment staging -- ./deploy.sh
//       In a GitHub Actions job with `permissions: id-token: write`: asks
//       GitHub for an OIDC token for the gateway's audience, exchanges it for a
//       short session and the environment's active bundle, and runs the command
//       with those values in its environment. Any failure stops here: there is
//       no fallback to other credentials.
//   gitroll secrets publish --environment staging --from secrets/staging.sops.yaml [--rev <sha>]
//       From an authorized publisher job: asks the gateway to publish that SOPS
//       document at that commit. The gateway decrypts it, never this client.
//
// Tokens and values are never printed, logged or put in arguments.

import { execFileSync, spawn } from "node:child_process";
import { DEFAULT_AUDIENCE, ENVIRONMENT, SHA, SecretsProtocolError, checkBundle, checkExchange, checkPublication } from "../core/secrets/protocol.ts";
import type { ErrorResponse } from "../core/secrets/protocol.ts";
import { UserError } from "../core/util.ts";
import { CliError } from "./cli-contract.ts";

type Values = Record<string, string | boolean | string[] | undefined>;
export interface SecretsContext {
  json: boolean;
  childArgv: string[] | null;
  /** For tests: where requests go. Defaults to the global fetch. */
  fetch?: typeof fetch;
}

const one = (v: Values, flag: string): string | undefined => {
  const x = v[flag];
  return Array.isArray(x) ? x[x.length - 1] : typeof x === "string" ? x : undefined;
};
const invalid = (message: string): never => {
  throw new CliError("INVALID_ARGUMENT", message);
};

export const SECRETS_USAGE = `Hosted deployment secrets (a separate service; see docs/SECRETS-GATEWAY.md)
  secrets run --environment <name> [--gateway <url>] [--audience <aud>] -- <command> [args]
                               In GitHub Actions: exchange the job's OIDC token, run the command with the bundle
  secrets publish --environment <name> --from <file.sops.yaml> [--rev <commit>]
                               Ask the gateway to publish an approved SOPS document
`;

/** The gateway's base URL: https, or plain http to this computer only (a local test gateway). */
export function gatewayUrl(v: Values): URL {
  const raw = one(v, "gateway") ?? process.env.GITROLL_SECRETS_GATEWAY;
  if (!raw) invalid("Say which gateway: --gateway https://… or GITROLL_SECRETS_GATEWAY.");
  let url: URL;
  try {
    url = new URL(raw!);
  } catch {
    return invalid("--gateway must be a URL.");
  }
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) invalid("The gateway must be reached over https.");
  if (url.username || url.password) invalid("Don't put credentials in the gateway URL.");
  return url;
}

function environment(v: Values): string {
  const env = one(v, "environment");
  if (!env || !ENVIRONMENT.test(env)) invalid("--environment <name> is required, e.g. --environment staging");
  return env!;
}

/** The job's OIDC token from GitHub Actions, for the gateway's audience. */
async function githubToken(audience: string, f: typeof fetch): Promise<string> {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const bearer = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !bearer) throw new UserError("No GitHub Actions OIDC token is available. Run this in a GitHub Actions job with permissions: id-token: write.");
  const u = new URL(url);
  u.searchParams.set("audience", audience);
  const r = await f(u, { headers: { authorization: `bearer ${bearer}`, accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new UserError(`GitHub didn't issue an OIDC token (HTTP ${r.status}).`);
  const body = (await r.json()) as { value?: unknown };
  if (typeof body.value !== "string" || body.value.split(".").length !== 3) throw new UserError("GitHub's OIDC token response was malformed.");
  return body.value;
}

async function call<T>(f: typeof fetch, base: URL, path: string, init: { method: string; body?: unknown; session?: string }, check: (v: unknown) => T): Promise<T> {
  let r: Response;
  try {
    r = await f(new URL(path, base), {
      method: init.method,
      headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...(init.session ? { authorization: `Bearer ${init.session}` } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new UserError(`Couldn't reach the secrets gateway at ${base.origin}. Nothing was run.`);
  }
  let body: unknown;
  try {
    body = await r.json();
  } catch {
    throw new UserError(`The secrets gateway answered HTTP ${r.status} without JSON. Nothing was run.`);
  }
  if (!r.ok) {
    const e = (body as ErrorResponse)?.error;
    throw new CliError(r.status === 401 || r.status === 403 ? "AUTH_REQUIRED" : r.status === 409 ? "CONFLICT" : "USER_ERROR", `The secrets gateway refused (${typeof e?.code === "string" ? e.code : `HTTP ${r.status}`}). Nothing was run.`);
  }
  try {
    return check(body);
  } catch (e) {
    if (e instanceof SecretsProtocolError) throw new UserError(`${e.message} Nothing was run.`);
    throw e;
  }
}

export async function secretsCommand(args: string[], v: Values, ctx: SecretsContext): Promise<void> {
  const f = ctx.fetch ?? fetch;
  const [action] = args;
  if (!action) return void process.stdout.write(SECRETS_USAGE);
  if (action !== "run" && ctx.childArgv) invalid("Only gitroll secrets run takes a command after --.");
  const audience = one(v, "audience") ?? process.env.GITROLL_SECRETS_AUDIENCE ?? DEFAULT_AUDIENCE;
  if (action === "run") {
    const command = ctx.childArgv ?? [];
    if (!command.length) invalid("Usage: gitroll secrets run --environment <name> -- <command> [args]");
    const env = environment(v);
    const base = gatewayUrl(v);
    const token = await githubToken(audience, f);
    const session = await call(f, base, "/v1/exchange", { method: "POST", body: { token, environment: env } }, checkExchange);
    const bundle = await call(f, base, `/v1/bundles/${encodeURIComponent(session.bundle.id)}/versions/${session.bundle.version}`, { method: "GET", session: session.session }, (b) => checkBundle(b, session.bundle));
    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...bundle.values };
    // The child has no use for the means to fetch more tokens or bundles.
    delete childEnv.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    delete childEnv.ACTIONS_ID_TOKEN_REQUEST_URL;
    if (!ctx.json) console.error(`Running with ${Object.keys(bundle.values).length} values from ${env} (bundle ${bundle.id} v${bundle.version}, ${bundle.sourceRevision.slice(0, 12)}).`);
    const child = spawn(command[0], command.slice(1), { stdio: "inherit", env: childEnv, shell: false });
    const forward = (sig: NodeJS.Signals) => () => child.kill(sig);
    const handlers = (["SIGINT", "SIGTERM", "SIGHUP"] as NodeJS.Signals[]).map((s) => [s, forward(s)] as const);
    for (const [s, h] of handlers) process.on(s, h);
    const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.on("error", () => reject(new UserError(`Couldn't run ${command[0]}.`)));
      child.on("exit", (c, s) => resolve({ code: c, signal: s }));
    });
    for (const [s, h] of handlers) process.removeListener(s, h);
    if (signal) return void process.kill(process.pid, signal);
    process.exitCode = code ?? 1;
    return;
  }
  if (action === "publish") {
    const env = environment(v);
    const source = one(v, "from") ?? invalid("--from <file.sops.yaml> is required: the SOPS document to publish.");
    const rev = one(v, "rev") ?? execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (!SHA.test(rev)) invalid("--rev must be a full commit SHA.");
    const base = gatewayUrl(v);
    const token = await githubToken(audience, f);
    const result = await call(f, base, "/v1/publications", { method: "POST", body: { token, environment: env, sourceRevision: rev, source } }, checkPublication);
    if (ctx.json) return console.log(JSON.stringify(result, null, 2));
    console.log(`${result.replayed ? "Already published" : result.status === "active" ? "Published" : `Publication ${result.status}`}: ${env} bundle ${result.bundle} v${result.version} from ${rev.slice(0, 12)}.`);
    if (result.status === "failed") process.exitCode = 1;
    return;
  }
  invalid(`“${action}” isn't a secrets command. Run: gitroll secrets`);
}
