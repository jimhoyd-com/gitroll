// Fetching what the GitHub and CI adapters read.
//
// The adapters are pure: they turn GitHub's JSON into events and never ask for
// it. This asks for it, in the way that is least surprising to somebody who
// already uses GitHub:
//
//   1. The GitHub CLI, when it is installed and signed in. It already holds the
//      credentials, handles SSO and enterprise hosts, and nothing new has to be
//      stored anywhere.
//   2. GITHUB_TOKEN or GH_TOKEN from the environment, over HTTPS.
//   3. No credentials at all, which works for public repositories and is rate
//      limited. Private repositories say so rather than appearing empty.
//
// No token is ever written to a Roll or to GitRoll's settings.

import { spawnSync } from "node:child_process";
import { AuthError, UserError } from "../core/util.ts";
import { hasGh } from "./github.ts";

/** GitHub's own cap. Asking for more in one request is an error, not more results. */
const PER_PAGE = 100;
const MAX_PAGES = 10;

export interface FetchOptions {
  /** Injected by tests; real runs use global fetch. */
  fetch?: typeof fetch;
  /** Set false to ignore the GitHub CLI even when it is installed. */
  useGhCli?: boolean;
  /** api.github.com unless a GitHub Enterprise host is configured. */
  host?: string;
  pages?: number;
  /** Called with each request, so a long import can say what it is doing. */
  onRequest?: (path: string) => void;
}

const token = (): string | undefined => process.env.GITHUB_TOKEN || process.env.GH_TOKEN || undefined;

/**
 * One page of a GitHub REST endpoint, as parsed JSON. `path` is everything
 * after the host: `repos/acme/app/pulls?state=closed`.
 */
async function page(path: string, opts: FetchOptions): Promise<unknown> {
  opts.onRequest?.(path);
  if ((opts.useGhCli ?? true) && !opts.fetch && hasGh()) {
    const result = spawnSync("gh", ["api", path], {
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, GH_PROMPT_DISABLED: "1" },
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status === 0) return parse(result.stdout, path);
    const message = (result.stderr || "").trim();
    // Fall through to HTTPS only when the CLI can't help; a real 404 is a real answer.
    if (/not logged|authentication|gh auth login/i.test(message)) throw new AuthError(`The GitHub CLI isn't signed in. Run: gh auth login\n${message}`);
    if (/404|Not Found/i.test(message)) throw new UserError(`GitHub says that doesn't exist, or you can't see it: ${path}`);
    if (message) throw new UserError(`GitHub CLI: ${message}`);
  }

  const host = opts.host ?? "api.github.com";
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "gitroll", "X-GitHub-Api-Version": "2022-11-28" };
  const key = token();
  if (key) headers.Authorization = `Bearer ${key}`;

  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(`https://${host}/${path}`, { headers, redirect: "follow", signal: AbortSignal.timeout(60_000) });
  } catch {
    throw new UserError(`Couldn't reach ${host}. Check your internet connection and try again; nothing was logged.`);
  }
  if (res.status === 401 || res.status === 403) {
    const limited = res.headers.get("x-ratelimit-remaining") === "0";
    if (limited && !key) {
      throw new UserError(
        "GitHub is rate limiting requests that aren't signed in. Sign in with the GitHub CLI (gh auth login), or set GITHUB_TOKEN, and try again.",
      );
    }
    throw new AuthError(
      key
        ? `GitHub refused the token in GITHUB_TOKEN (${res.status}). It may be expired, or lack access to this repository.`
        : `That repository needs credentials (${res.status}). Sign in with the GitHub CLI (gh auth login), or set GITHUB_TOKEN.`,
    );
  }
  if (res.status === 404) {
    throw new UserError(
      `GitHub says ${path.split("?")[0]} doesn't exist, or you can't see it.` +
        (key ? "" : " If it's private, sign in with the GitHub CLI (gh auth login) or set GITHUB_TOKEN."),
    );
  }
  if (!res.ok) throw new UserError(`GitHub returned ${res.status} for ${path}. Nothing was logged.`);
  return parse(await res.text(), path);
}

function parse(text: string, path: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new UserError(`GitHub sent something GitRoll couldn't read for ${path}.`);
  }
}

/** Every page of a list endpoint, stopping at the first short page. */
async function list(path: string, opts: FetchOptions): Promise<unknown[]> {
  const out: unknown[] = [];
  const pages = opts.pages ?? MAX_PAGES;
  for (let n = 1; n <= pages; n++) {
    const sep = path.includes("?") ? "&" : "?";
    const data = await page(`${path}${sep}per_page=${PER_PAGE}&page=${n}`, opts);
    const items = Array.isArray(data) ? data : Array.isArray((data as { workflow_runs?: unknown[] })?.workflow_runs) ? (data as { workflow_runs: unknown[] }).workflow_runs : [];
    out.push(...items);
    if (items.length < PER_PAGE) break;
  }
  return out;
}

export interface ImportQuery {
  repo: string;
  /** For github: pr, issue, release. For ci: ignored. */
  include?: string[];
  branch?: string;
  /** Only ask GitHub for things updated since this day; the adapter filters exactly. */
  since?: string;
}

const REPO = /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/;

function checkRepo(repo: string): string {
  if (!REPO.test(repo)) throw new UserError(`That isn't a repository: ${repo}. Use owner/name, for example acme/app.`);
  return repo;
}

/** Pull requests, issues and releases, as GitHub's own JSON. */
export async function fetchGitHub(query: ImportQuery, opts: FetchOptions = {}): Promise<unknown[]> {
  const repo = checkRepo(query.repo);
  const include = query.include?.length ? query.include : ["pr", "release"];
  const out: unknown[] = [];

  if (include.includes("pr")) {
    // Sorted by when they were last touched, so `--since` can stop early.
    const base = query.branch ? `&base=${encodeURIComponent(query.branch)}` : "";
    out.push(...(await list(`repos/${repo}/pulls?state=closed&sort=updated&direction=desc${base}`, opts)));
  }
  if (include.includes("issue")) {
    const since = query.since ? `&since=${encodeURIComponent(`${query.since}T00:00:00Z`)}` : "";
    // GitHub's issues endpoint includes pull requests; the adapter tells them apart.
    out.push(...(await list(`repos/${repo}/issues?state=closed&sort=updated&direction=desc${since}`, opts)));
  }
  if (include.includes("release")) {
    out.push(...(await list(`repos/${repo}/releases`, opts)));
  }
  return out;
}

/** GitHub Actions runs, as GitHub's own JSON. */
export async function fetchRuns(query: ImportQuery, opts: FetchOptions = {}): Promise<unknown[]> {
  const repo = checkRepo(query.repo);
  const parts = ["status=completed"];
  if (query.branch) parts.push(`branch=${encodeURIComponent(query.branch)}`);
  // GitHub takes a date range here, which keeps a busy repository's pages down.
  if (query.since) parts.push(`created=%3E%3D${encodeURIComponent(query.since)}`);
  return list(`repos/${repo}/actions/runs?${parts.join("&")}`, opts);
}

/** Deployment statuses, newest first, across a repository's deployments. */
export async function fetchDeployments(query: ImportQuery, opts: FetchOptions = {}): Promise<unknown[]> {
  const repo = checkRepo(query.repo);
  const env = query.branch ? `?environment=${encodeURIComponent(query.branch)}` : "";
  const deployments = await list(`repos/${repo}/deployments${env}`, opts);
  const out: unknown[] = [];
  for (const deployment of deployments.slice(0, 50)) {
    const id = (deployment as { id?: unknown }).id;
    if (typeof id !== "number") continue;
    const statuses = await list(`repos/${repo}/deployments/${id}/statuses`, { ...opts, pages: 1 });
    // The newest status is what the deployment ended as.
    if (statuses[0]) out.push({ deployment_status: statuses[0], deployment });
  }
  return out;
}

/** How this import will authenticate, for saying so before it starts. */
export function describeAuth(opts: FetchOptions = {}): string {
  if ((opts.useGhCli ?? true) && !opts.fetch && hasGh()) return "the GitHub CLI";
  if (token()) return process.env.GITHUB_TOKEN ? "GITHUB_TOKEN" : "GH_TOKEN";
  return "no credentials (public repositories only, and rate limited)";
}
