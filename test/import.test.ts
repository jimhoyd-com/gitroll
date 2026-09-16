// Importing from GitHub and CI. Two things decide whether an import is useful
// or noise: what it brings in (filtering), and what it brings in twice
// (deduplication). Both are checked here against GitHub's own shapes.
import "./helpers.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { planIngest, withDefaults } from "../src/core/adapter.ts";
import type { EventDraft } from "../src/core/adapter.ts";
import { ciAdapter, githubAdapter } from "../src/core/adapters/index.ts";
import { normalizeStatus } from "../src/core/adapters/ci.ts";
import { parseEntry } from "../src/core/entry.ts";
import { sourceRef } from "../src/core/code.ts";
import { fetchGitHub, fetchRuns } from "../src/node/github-import.ts";
import { GitRoll } from "../src/node/repo.ts";
import { tmp } from "./helpers.ts";

const PR = {
  number: 412,
  title: "Add a partial index on orders",
  state: "closed",
  merged_at: "2026-09-15T14:02:00Z",
  closed_at: "2026-09-15T14:02:00Z",
  created_at: "2026-09-12T09:00:00Z",
  html_url: "https://github.com/acme/app/pull/412",
  user: { login: "sam" },
  merged_by: { login: "jo" },
  labels: [{ name: "performance" }],
  base: { ref: "main", repo: { full_name: "acme/app" } },
  head: { ref: "fix/checkout", sha: "9f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f60718293" },
  merge_commit_sha: "aa11bb22cc33dd44ee55ff6600112233445566aa",
  commits: 7,
  additions: 212,
  deletions: 40,
  body: "Checkout was timing out on large carts.",
};

const UNMERGED = { ...PR, number: 410, title: "Never merged", merged_at: null, closed_at: "2026-09-10T10:00:00Z", user: { login: "kim" }, labels: [] };

const RELEASE = {
  tag_name: "v1.4.0",
  name: "1.4.0 — faster checkout",
  html_url: "https://github.com/acme/app/releases/tag/v1.4.0",
  published_at: "2026-09-16T10:00:00Z",
  target_commitish: "main",
  body: "Adds a partial index on orders.",
  author: { login: "jo" },
  repository: { full_name: "acme/app" },
};

const RUN = {
  id: 12345678,
  name: "build",
  head_branch: "main",
  head_sha: "9f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f60718293",
  status: "completed",
  conclusion: "failure",
  run_attempt: 2,
  run_started_at: "2026-09-16T08:00:00Z",
  updated_at: "2026-09-16T08:04:12Z",
  html_url: "https://github.com/acme/app/actions/runs/12345678",
  repository: { full_name: "acme/app" },
  actor: { login: "sam" },
};

const GREEN = { ...RUN, id: 12345679, conclusion: "success", run_attempt: 1, run_started_at: "2026-09-16T09:00:00Z", updated_at: "2026-09-16T09:03:00Z" };

const events = (input: unknown, options: Record<string, string | undefined> = {}, adapter = githubAdapter) => adapter.toEvents(input, { options });

test("a merged pull request becomes an event that says what happened and links to it", () => {
  const [draft] = events([PR, UNMERGED]);
  assert.equal(events([PR, UNMERGED]).length, 1, "only merged pull requests, unless asked otherwise");

  assert.match(draft.text, /^# Merged acme\/app#412: Add a partial index on orders/);
  assert.match(draft.text, /Opened by @sam, merged by @jo, into `main`, from `fix\/checkout`\./);
  assert.match(draft.text, /^> Checkout was timing out on large carts\.$/m, "GitHub's prose is quoted, not adopted");
  assert.match(draft.text, /\[Pull request\]\(https:\/\/github\.com\/acme\/app\/pull\/412\) · 7 commits · \+212 −40/);
  assert.equal(draft.date, "2026-09-15T14:02:00Z");
  assert.deepEqual(draft.tags, ["pull-request", "merged", "performance"]);
  assert.deepEqual(draft.source, {
    adapter: "github",
    id: "pr:acme/app#412",
    url: "https://github.com/acme/app/pull/412",
    repo: "acme/app",
    branch: "main",
    commit: "aa11bb22cc33dd44ee55ff6600112233445566aa",
  });

  // Written into a Roll, it is an ordinary event that knows which code it is about.
  const roll = GitRoll.init(tmp());
  const [entry] = roll.ingest([draft]).created;
  assert.equal(entry.path, ".gitroll/events/2026-09-15-merged-acme-app-412-add-a-partial-index-on-orders.md");
  assert.equal(sourceRef(entry)?.branch, "main");
  assert.deepEqual(roll.check(), []);
});

test("imports never log the same thing twice", () => {
  const roll = GitRoll.init(tmp());
  const first = roll.ingest(events([PR, RELEASE]));
  assert.equal(first.created.length, 2);

  const again = roll.ingest(events([PR, RELEASE]));
  assert.deepEqual(again.created, [], "the second import logs nothing");
  assert.equal(again.skipped.length, 2);
  assert.equal(roll.entries().length, 2);

  // An event edited by hand after an import stays edited: it is skipped, not rewritten.
  const pr = roll.entries().find((e) => e.source?.id === "pr:acme/app#412")!;
  roll.updateEntry(pr.path, { text: `${pr.body}\n\nThis is what actually broke.` });
  roll.ingest(events([PR]));
  assert.match(roll.entry(pr.path).body, /This is what actually broke\./);
  assert.equal(roll.entries().length, 2);

  // Deduplication is by the thing's own identity on GitHub, so a payload from a
  // webhook and one from the API are the same event.
  const webhook = events({ action: "closed", pull_request: PR, repository: { full_name: "acme/app" } });
  assert.equal(webhook[0].source.id, "pr:acme/app#412");
  assert.deepEqual(planIngest(roll.entries(), webhook).create, []);
});

test("filters decide what an import brings in", () => {
  const all = [PR, UNMERGED, RELEASE];
  const ids = (options: Record<string, string | undefined>) => events(all, options).map((d) => d.source.id);

  assert.deepEqual(ids({}), ["release:acme/app@v1.4.0", "pr:acme/app#412"], "newest first");
  assert.deepEqual(ids({ include: "pr" }), ["pr:acme/app#412"]);
  assert.deepEqual(ids({ include: "pr", only: "closed" }), ["pr:acme/app#412", "pr:acme/app#410"]);
  assert.deepEqual(ids({ since: "2026-09-16" }), ["release:acme/app@v1.4.0"]);
  assert.deepEqual(ids({ until: "2026-09-15" }), ["pr:acme/app#412"]);
  assert.deepEqual(ids({ include: "pr", only: "closed", author: "kim" }), ["pr:acme/app#410"]);
  assert.deepEqual(ids({ include: "pr", label: "performance" }), ["pr:acme/app#412"]);
  assert.deepEqual(ids({ include: "pr", label: "flaky" }), []);
  assert.deepEqual(ids({ include: "pr", branch: "release" }), [], "the base branch a pull request went into");
  assert.deepEqual(ids({ limit: "1" }), ["release:acme/app@v1.4.0"]);
  assert.throws(() => events(all, { include: "everything" }), /--include takes pr, issue or release/);
  assert.throws(() => events(all, { since: "last tuesday" }), /--since takes a date/);
  assert.throws(() => events(all, { limit: "lots" }), /--limit takes a whole number/);
});

test("closed issues come in when they're asked for, and pull requests aren't mistaken for them", () => {
  const issue = {
    number: 88,
    title: "Checkout times out on large carts",
    closed_at: "2026-09-15T15:00:00Z",
    created_at: "2026-09-01T09:00:00Z",
    html_url: "https://github.com/acme/app/issues/88",
    user: { login: "kim" },
    labels: [{ name: "bug" }],
    repository: { full_name: "acme/app" },
  };
  // GitHub's issues endpoint returns pull requests too, carrying `pull_request`.
  const prShapedAsIssue = { ...issue, number: 412, pull_request: { url: "https://api.github.com/repos/acme/app/pulls/412" }, merged_at: "2026-09-15T14:02:00Z" };

  const drafts = events([issue, prShapedAsIssue], { include: "issue" });
  assert.deepEqual(drafts.map((d) => d.source.id), ["issue:acme/app#88"]);
  assert.match(drafts[0].text, /^# Closed acme\/app#88: Checkout times out on large carts/);
  assert.deepEqual(drafts[0].tags, ["issue", "closed", "bug"]);
});

test("CI logs failures by default, because a log of every green build is noise", () => {
  const runs = { workflow_runs: [RUN, GREEN] };
  const ids = (options: Record<string, string | undefined>) => events(runs, options, ciAdapter).map((d) => d.source.id);

  assert.deepEqual(ids({}), ["run:acme/app#12345678.2"]);
  assert.deepEqual(ids({ status: "success" }), ["run:acme/app#12345679"]);
  assert.deepEqual(ids({ status: "all" }).length, 2);
  assert.deepEqual(ids({ status: "all", branch: "release" }), []);

  const [failure] = events(runs, {}, ciAdapter);
  assert.match(failure.text, /^# Build failed on `main`/);
  assert.match(failure.text, /At `9f1c2d3e4a5b`, attempt 2, took 4m 12s\./);
  assert.match(failure.text, /\[Run 12345678\]\(https:\/\/github\.com\/acme\/app\/actions\/runs\/12345678\)/);
  assert.deepEqual(failure.tags, ["ci", "failure"]);
  assert.equal(failure.source.branch, "main");
  // A re-run is its own event: attempt 2 didn't happen at the same time as attempt 1.
  assert.equal(failure.source.id, "run:acme/app#12345678.2");
});

test("CI reads a webhook, a deployment, and anything else mapped onto the same shape", () => {
  const [fromWebhook] = events({ action: "completed", workflow_run: RUN, repository: { full_name: "acme/app" } }, {}, ciAdapter);
  assert.equal(fromWebhook.source.id, "run:acme/app#12345678.2");

  const [deployment] = events(
    {
      deployment_status: { id: 99, state: "failure", environment: "production", target_url: "https://github.com/acme/app/deployments/99", created_at: "2026-09-16T11:00:00Z", description: "Rolled back" },
      deployment: { id: 99, ref: "main", sha: "9f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f60718293", environment: "production" },
    },
    { repo: "acme/app" },
    ciAdapter,
  );
  assert.match(deployment.text, /^# Failed to production/);
  assert.match(deployment.text, /Rolled back/);
  assert.deepEqual(deployment.tags, ["deployment", "failure", "production"]);
  assert.equal(deployment.source.id, "deploy:acme/app#99");

  // Anything else: a few fields, mapped with jq.
  const [other] = events(
    { id: "4711", name: "nightly", status: "failed", branch: "main", commit: "9f1c2d3", url: "https://ci.example.com/4711", started_at: "2026-09-16T02:00:00Z", finished_at: "2026-09-16T02:12:00Z" },
    { repo: "acme/app" },
    ciAdapter,
  );
  assert.match(other.text, /^# Nightly failed on `main`/);
  assert.equal(other.source.id, "run:acme/app#4711");
  assert.equal(other.source.commit, "9f1c2d3");

  // Every CI system spells the outcome differently; none of them is wrong.
  for (const word of ["success", "succeeded", "passed", "green", "completed"]) assert.equal(normalizeStatus(word), "success");
  for (const word of ["failure", "failed", "error", "timed_out", "red"]) assert.equal(normalizeStatus(word), "failure");
  assert.equal(normalizeStatus("in_progress"), "running");
  assert.equal(normalizeStatus("something else"), "unknown");
});

test("tags asked for on the command line reach every imported entry", () => {
  const ctx = { options: { tag: "from-github" } };
  const [draft] = withDefaults(githubAdapter.toEvents([PR], ctx), ctx) as EventDraft[];
  assert.ok(draft.tags?.includes("from-github"));

  const roll = GitRoll.init(tmp());
  const [entry] = roll.ingest([draft]).created;
  assert.ok(entry.tags.includes("from-github"));
});

test("what GitHub wrote is quoted, and a long description is shortened rather than swallowed", () => {
  const long = { ...PR, body: `${"x".repeat(2100)}\n\nlast line` };
  const [draft] = events([long]);
  assert.ok(draft.text.length < 2600, "the event doesn't become the pull request");
  assert.match(draft.text, /…\(shortened; the rest is at the link\)/);

  // A body that tries to look like the event's own words stays a quotation.
  const shouty = { ...PR, body: "# Deploy to production\n\nEverything is fine." };
  const [quoted] = events([shouty]);
  const entry = parseEntry(".gitroll/events/x.md", quoted.text);
  assert.equal(entry.title, "Merged acme/app#412: Add a partial index on orders", "the pull request's heading can't outrank the event's");
  assert.match(quoted.text, /^> # Deploy to production$/m);
});

// ── Fetching ────────────────────────────────────────────────────────────────

/** GitHub, as far as these tests are concerned. */
function fakeGitHub(pages: Record<string, unknown>) {
  const asked: string[] = [];
  const fetchImpl = (async (url: string) => {
    const path = url.replace("https://api.github.com/", "");
    asked.push(path);
    const key = Object.keys(pages).find((k) => path.startsWith(k));
    const body = key ? pages[key] : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { asked, fetchImpl };
}

test("fetching asks GitHub for the narrow thing, and pages until it runs out", async () => {
  const { asked, fetchImpl } = fakeGitHub({
    "repos/acme/app/pulls": [PR],
    "repos/acme/app/releases": [RELEASE],
    "repos/acme/app/actions/runs": { workflow_runs: [RUN] },
  });

  const github = await fetchGitHub({ repo: "acme/app", include: ["pr", "release"], branch: "main" }, { fetch: fetchImpl, useGhCli: false });
  assert.equal(github.length, 2);
  assert.ok(asked.some((p) => p.includes("state=closed") && p.includes("base=main")), "closed pull requests on that branch");
  assert.ok(asked.every((p) => p.includes("per_page=100")));

  const runs = await fetchRuns({ repo: "acme/app", since: "2026-09-01" }, { fetch: fetchImpl, useGhCli: false });
  assert.equal(runs.length, 1);
  assert.ok(asked.some((p) => p.includes("status=completed") && p.includes("created=")), "a date range keeps a busy repository's pages down");

  await assert.rejects(fetchGitHub({ repo: "not a repo" }, { fetch: fetchImpl, useGhCli: false }), /isn't a repository/);
});

test("fetching says what is wrong instead of looking empty", async () => {
  const reply = (status: number, headers: Record<string, string> = {}) =>
    (async () => new Response("{}", { status, headers })) as unknown as typeof fetch;
  const held = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, GH_TOKEN: process.env.GH_TOKEN };
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;

  try {
    // Signed out: each failure says what to do about it.
    await assert.rejects(fetchGitHub({ repo: "acme/app" }, { fetch: reply(404), useGhCli: false }), /doesn't exist, or you can't see it[\s\S]*gh auth login/);
    await assert.rejects(fetchGitHub({ repo: "acme/app" }, { fetch: reply(401), useGhCli: false }), /needs credentials/);
    await assert.rejects(
      fetchGitHub({ repo: "acme/app" }, { fetch: reply(403, { "x-ratelimit-remaining": "0" }), useGhCli: false }),
      /rate limiting requests that aren't signed in/,
    );
    await assert.rejects(
      fetchGitHub({ repo: "acme/app" }, { fetch: (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch, useGhCli: false }),
      /Couldn't reach api\.github\.com/,
    );

    // With a token, a refusal is about the token rather than about signing in.
    process.env.GITHUB_TOKEN = "not-a-real-token";
    await assert.rejects(fetchGitHub({ repo: "acme/app" }, { fetch: reply(401), useGhCli: false }), /refused the token in GITHUB_TOKEN/);
  } finally {
    if (held.GITHUB_TOKEN === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = held.GITHUB_TOKEN;
    if (held.GH_TOKEN === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = held.GH_TOKEN;
  }
});
