// Builds and deployments, as events.
//
// Reads GitHub Actions workflow runs, check runs and deployment statuses, and a
// plain shape any other CI system can be mapped onto with a few lines of jq:
//
//   { "id": "4711", "name": "build", "status": "failure", "branch": "main",
//     "commit": "9f1c2d3…", "url": "https://ci.example.com/4711",
//     "started_at": "2026-09-15T14:02:00Z", "finished_at": "2026-09-15T14:06:12Z" }
//
// A log of every green build is noise, so **failures are the default** and
// successes are asked for (`--status all`, `--status success`). A run's own id
// is the event's source id, so importing the same range twice logs nothing the
// second time.

import type { Adapter, AdapterContext } from "../adapter.ts";
import { AdapterError } from "../adapter.ts";
import { asList, isMapping, matchesFilters, newestFirst, num, readFilters, str, strs, truncate } from "./shared.ts";
import type { FactualDraft } from "./shared.ts";

/** What a run ended as, in one word, whatever the system called it. */
export type RunStatus = "success" | "failure" | "cancelled" | "running" | "unknown";

const FAILED: RunStatus[] = ["failure"];

export const ciAdapter: Adapter = {
  id: "ci",
  label: "CI and deployments",
  description: "Builds and deployments: GitHub Actions runs, check runs, deployment statuses, or your own JSON.",
  toEvents(input, ctx) {
    const filters = readFilters(ctx);
    // Failures are what a log is for. Everything else is asked for by name.
    const wanted = new Set<string>(strs(ctx.options.status).length ? strs(ctx.options.status).map(normalizeStatus) : FAILED);
    if (wanted.has("all")) wanted.clear();

    const drafts = newestFirst(
      asList(input)
        .flatMap((item) => unwrap(item))
        .flatMap((item) => {
          const draft = run(item, ctx);
          if (!draft) return [];
          if (wanted.size && !wanted.has(draft.facts?.status ?? "unknown")) return [];
          // `--status` is answered above; matchesFilters would ask for it twice.
          return matchesFilters(draft, { ...filters, status: [] }) ? [draft] : [];
        }),
    );
    return filters.limit ? drafts.slice(0, filters.limit) : drafts;
  },
};

/** GitHub wraps runs in `{ workflow_runs: [...] }`, and webhooks in `{ action, workflow_run: {...} }`. */
function unwrap(item: unknown): Record<string, unknown>[] {
  if (!isMapping(item)) return [];
  for (const key of ["workflow_run", "check_run", "deployment_status", "run"]) {
    const inner = item[key];
    if (isMapping(inner)) return [{ ...inner, __wrapped: key, ...(isMapping(item.deployment) ? { deployment: item.deployment } : {}) }];
  }
  const list = ["workflow_runs", "check_runs", "runs", "statuses"].map((k) => item[k]).find(Array.isArray);
  if (list) return (list as unknown[]).filter(isMapping);
  return [item];
}

/** Every CI system spells these differently; GitRoll doesn't care which word arrived. */
export function normalizeStatus(raw: string): RunStatus | "all" {
  const v = raw.trim().toLowerCase();
  if (v === "all") return "all";
  if (["success", "succeeded", "passed", "pass", "ok", "green", "completed"].includes(v)) return "success";
  if (["failure", "failed", "fail", "error", "errored", "broken", "red", "timed_out", "startup_failure"].includes(v)) return "failure";
  if (["cancelled", "canceled", "skipped", "stale", "neutral"].includes(v)) return "cancelled";
  if (["running", "in_progress", "queued", "pending", "waiting", "requested"].includes(v)) return "running";
  return "unknown";
}

const repoOf = (item: Record<string, unknown>, ctx: AdapterContext): string => {
  const fromItem = isMapping(item.repository) ? str(item.repository.full_name) : "";
  const fromUrl = /github\.com\/([^/]+\/[^/]+)\//.exec(str(item.html_url) || str(item.url) || str(item.target_url))?.[1] ?? "";
  return fromItem || fromUrl || str(ctx.options.repo);
};

/** How long it took, when both ends are known. */
function took(from: string, to: string): string {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!from || !to || Number.isNaN(start) || Number.isNaN(end) || end < start) return "";
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function run(item: Record<string, unknown>, ctx: AdapterContext): FactualDraft | null {
  const id = str(item.id) || str(item.run_id) || str(item.number);
  const repo = repoOf(item, ctx);
  const deployment = isMapping(item.deployment) ? item.deployment : null;
  const isDeployment = item.__wrapped === "deployment_status" || !!deployment || !!str(item.environment);

  // `conclusion` is what GitHub says when a run has finished; `status` is where it got to.
  const raw = str(item.conclusion) || str(item.state) || str(item.status) || str(item.result);
  const status = normalizeStatus(raw);
  if (status === "all") throw new AdapterError('"all" isn\'t a status a run can have.');
  if (!id) return null;

  const name = str(item.name) || str(item.workflow_name) || str(item.display_title) || (isDeployment ? "Deployment" : "Run");
  const branch = str(item.head_branch) || str(item.branch) || str(item.ref) || str(deployment?.ref);
  const commit = str(item.head_sha) || str(item.commit) || str(item.sha) || str(deployment?.sha);
  const environment = str(item.environment) || str(deployment?.environment);
  const url = str(item.html_url) || str(item.target_url) || str(item.url);
  const attempt = num(item.run_attempt);
  const started = str(item.run_started_at) || str(item.started_at) || str(item.created_at);
  const finished = str(item.updated_at) || str(item.completed_at) || str(item.finished_at);

  const what = isDeployment
    ? `${verb(status)} to ${environment || "an environment"}`
    : `${name} ${verb(status)}${branch ? ` on \`${branch}\`` : ""}`;
  const detail = [
    commit ? `at \`${commit.slice(0, 12)}\`` : "",
    attempt && attempt > 1 ? `attempt ${attempt}` : "",
    took(started, finished) ? `took ${took(started, finished)}` : "",
  ].filter(Boolean);

  const body = [
    `# ${capital(what)}`,
    detail.length ? `${capital(detail.join(", "))}.` : "",
    truncate(str(item.description) || str(item.output_title) || "", 500),
    url ? `[${isDeployment ? "Deployment" : `Run ${id}`}](${url})` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    text: body,
    date: finished || started || undefined,
    tags: [isDeployment ? "deployment" : "ci", status, ...(environment ? [environment] : [])],
    source: {
      adapter: "ci",
      id: `${isDeployment ? "deploy" : "run"}:${repo || "unknown"}#${id}${attempt && attempt > 1 ? `.${attempt}` : ""}`,
      ...(url ? { url } : {}),
      ...(repo ? { repo } : {}),
      ...(branch ? { branch } : {}),
      ...(/^[0-9a-f]{7,40}$/i.test(commit) ? { commit } : {}),
    },
    facts: { branch, status, author: str(isMapping(item.actor) ? item.actor.login : "") || str(isMapping(item.creator) ? item.creator.login : ""), labels: [] },
  };
}

const verb = (status: RunStatus): string =>
  status === "success" ? "succeeded" : status === "failure" ? "failed" : status === "cancelled" ? "was cancelled" : status === "running" ? "is running" : "finished";

const capital = (text: string): string => (text ? text[0].toUpperCase() + text.slice(1) : text);
