// GitHub, as events: merged pull requests, closed issues, releases.
//
// This is a pure reader of GitHub's own JSON — the REST API's shapes and the
// webhook envelopes that wrap them — so the same code serves `gitroll import
// github acme/app`, a payload piped in from `gh api`, and a webhook a server
// received. Fetching is somebody else's job.
//
// Two things keep an import from becoming noise:
//
//   Deduplication. Every draft's source id is the thing's own identity on
//   GitHub (`pr:acme/app#412`), so importing the same range twice logs nothing
//   the second time, and an event edited by hand afterwards is never rewritten.
//
//   Filtering. The default is the narrow, useful answer — merged pull requests
//   and published releases — and everything else is asked for.

import type { Adapter, AdapterContext } from "../adapter.ts";
import { AdapterError } from "../adapter.ts";
import { asList, isMapping, matchesFilters, newestFirst, num, quote, readFilters, str, strs, truncate } from "./shared.ts";
import type { FactualDraft } from "./shared.ts";

/** What an import may bring in. Merged pull requests and releases by default. */
export type GitHubKind = "pr" | "issue" | "release";

const DEFAULT_KINDS: GitHubKind[] = ["pr", "release"];

export const githubAdapter: Adapter = {
  id: "github",
  label: "GitHub",
  description: "Merged pull requests, closed issues and releases, from GitHub's own JSON.",
  toEvents(input, ctx) {
    const filters = readFilters(ctx);
    const kinds = new Set<string>(strs(ctx.options.include).length ? strs(ctx.options.include) : DEFAULT_KINDS);
    for (const kind of kinds) {
      if (!["pr", "issue", "release"].includes(kind)) throw new AdapterError(`--include takes pr, issue or release. Not: ${kind}`);
    }

    const drafts = newestFirst(
      asList(input)
        .flatMap((item) => unwrap(item))
        .flatMap((item) => {
          const kind = kindOf(item);
          if (!kind || !kinds.has(kind)) return [];
          const draft = kind === "release" ? release(item, ctx) : kind === "issue" ? issue(item, ctx) : pullRequest(item, ctx);
          return draft && matchesFilters(draft, filters) ? [draft] : [];
        }),
    );
    return filters.limit ? drafts.slice(0, filters.limit) : drafts;
  },
};

/** A webhook sends `{ action, pull_request: {…} }`; the REST API sends the thing itself. */
function unwrap(item: unknown): Record<string, unknown>[] {
  if (!isMapping(item)) return [];
  for (const key of ["pull_request", "issue", "release"]) {
    const inner = item[key];
    if (isMapping(inner)) return [{ ...inner, __wrapped: key }];
  }
  // `gh api` can hand back `{ items: [...] }` from a search, or `{ workflow_runs: [...] }`.
  const list = ["items", "pull_requests", "issues", "releases"].map((k) => item[k]).find(Array.isArray);
  if (list) return (list as unknown[]).filter(isMapping);
  return [item];
}

function kindOf(item: Record<string, unknown>): GitHubKind | null {
  if (item.__wrapped === "release" || item.tag_name) return "release";
  if (item.__wrapped === "pull_request" || item.merged_at !== undefined || isMapping(item.head)) return "pr";
  // GitHub's issues endpoint returns pull requests too; they carry `pull_request`.
  if (item.__wrapped === "issue" || item.number !== undefined) return isMapping(item.pull_request) ? "pr" : "issue";
  return null;
}

/** owner/repo from whatever the payload happens to carry, or "" when it says nothing. */
function repoOf(item: Record<string, unknown>, ctx: AdapterContext): string {
  const base = isMapping(item.base) ? item.base : null;
  const fromBase = base && isMapping(base.repo) ? str(base.repo.full_name) : "";
  const fromItem = isMapping(item.repository) ? str(item.repository.full_name) : "";
  const fromUrl = /github\.com\/([^/]+\/[^/]+)\//.exec(str(item.html_url))?.[1] ?? "";
  return fromBase || fromItem || fromUrl || str(ctx.options.repo);
}

const login = (v: unknown): string => (isMapping(v) ? str(v.login) : "");
const labels = (v: unknown): string[] => (Array.isArray(v) ? v.map((l) => (isMapping(l) ? str(l.name) : str(l))).filter(Boolean) : []);

function pullRequest(item: Record<string, unknown>, ctx: AdapterContext): FactualDraft | null {
  const number = num(item.number);
  const repo = repoOf(item, ctx);
  if (!number) throw new AdapterError("A pull request needs a number; this JSON has none.");

  const merged = str(item.merged_at);
  const closed = str(item.closed_at);
  const only = str(ctx.options.only) || "merged";
  if (only === "merged" && !merged) return null;
  if (only === "closed" && !closed) return null;

  const head = isMapping(item.head) ? item.head : null;
  const base = isMapping(item.base) ? item.base : null;
  const state = merged ? "Merged" : closed ? "Closed" : "Opened";
  const author = login(item.user);
  const mergedBy = login(item.merged_by);
  const branch = str(base?.ref) || str(item.base_ref);
  const commit = str(item.merge_commit_sha) || str(head?.sha);

  const facts = [
    author ? `Opened by @${author}` : "",
    mergedBy && mergedBy !== author ? `merged by @${mergedBy}` : "",
    branch ? `into \`${branch}\`` : "",
    str(head?.ref) ? `from \`${str(head?.ref)}\`` : "",
  ].filter(Boolean);
  const counts = [
    num(item.commits) ? `${num(item.commits)} commits` : "",
    num(item.additions) || num(item.deletions) ? `+${num(item.additions) ?? 0} −${num(item.deletions) ?? 0}` : "",
    num(item.changed_files) ? `${num(item.changed_files)} files` : "",
  ].filter(Boolean);

  const url = str(item.html_url);
  const body = [
    `# ${state} ${repo ? `${repo}#${number}` : `#${number}`}: ${str(item.title) || "(no title)"}`,
    facts.length ? `${facts.join(", ")}.` : "",
    quote(truncate(str(item.body), 2000)),
    [url ? `[Pull request](${url})` : "", ...counts].filter(Boolean).join(" · "),
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    text: body,
    date: merged || closed || str(item.created_at) || undefined,
    tags: ["pull-request", merged ? "merged" : closed ? "closed" : "open", ...labels(item.labels)],
    source: {
      adapter: "github",
      id: `pr:${repo || "unknown"}#${number}`,
      ...(url ? { url } : {}),
      ...(repo ? { repo } : {}),
      ...(branch ? { branch } : {}),
      ...(commit ? { commit } : {}),
    },
    // Read by the filters, and left behind: only `source` reaches the file.
    facts: { author, labels: labels(item.labels), branch, status: merged ? "merged" : closed ? "closed" : "open" },
  };
}

function issue(item: Record<string, unknown>, ctx: AdapterContext): FactualDraft | null {
  const number = num(item.number);
  const repo = repoOf(item, ctx);
  if (!number) return null;
  const closed = str(item.closed_at);
  const only = str(ctx.options.only) || "closed";
  if (only === "closed" && !closed) return null;

  const url = str(item.html_url);
  const author = login(item.user);
  const body = [
    `# ${closed ? "Closed" : "Opened"} ${repo ? `${repo}#${number}` : `#${number}`}: ${str(item.title) || "(no title)"}`,
    author ? `Opened by @${author}.` : "",
    quote(truncate(str(item.body), 2000)),
    url ? `[Issue](${url})` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    text: body,
    date: closed || str(item.created_at) || undefined,
    tags: ["issue", closed ? "closed" : "open", ...labels(item.labels)],
    source: { adapter: "github", id: `issue:${repo || "unknown"}#${number}`, ...(url ? { url } : {}), ...(repo ? { repo } : {}) },
    facts: { author, labels: labels(item.labels), status: closed ? "closed" : "open" },
  };
}

function release(item: Record<string, unknown>, ctx: AdapterContext): FactualDraft | null {
  const tag = str(item.tag_name);
  const repo = repoOf(item, ctx);
  if (!tag) return null;
  if (item.draft === true && str(ctx.options.only) !== "all") return null;

  const url = str(item.html_url);
  const published = str(item.published_at) || str(item.created_at);
  const body = [
    `# Released ${str(item.name) || tag}${repo ? ` · ${repo}` : ""}`,
    str(item.target_commitish) ? `Tagged \`${tag}\` on \`${str(item.target_commitish)}\`.` : `Tagged \`${tag}\`.`,
    quote(truncate(str(item.body), 4000)),
    url ? `[Release](${url})` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    text: body,
    date: published || undefined,
    tags: ["release", ...(item.prerelease === true ? ["prerelease"] : [])],
    source: {
      adapter: "github",
      id: `release:${repo || "unknown"}@${tag}`,
      ...(url ? { url } : {}),
      ...(repo ? { repo } : {}),
      ...(str(item.target_commitish) ? { branch: str(item.target_commitish) } : {}),
    },
    facts: { author: login(item.author), status: item.prerelease === true ? "prerelease" : "released" },
  };
}
