// Events written by developers refer to code: a commit, a pull request, an
// issue. Those references are ordinary text — `#412`, `owner/repo#412`, a SHA,
// a GitHub URL — so an event stays readable in a terminal, on GitHub, and in
// five years. Nothing here is required: this only recognizes what is already
// written, and turns it into links when a repository is known.

import type { Entry } from "./entry.ts";

export interface SourceRef {
  /** Other keys a person wrote under `source:` are kept as they are. */
  [key: string]: unknown;
  /** owner/repo, when the event says which repository it is about. */
  repo?: string;
  branch?: string;
  /** Full or abbreviated commit SHA. */
  commit?: string;
  /** Where the repository is hosted, e.g. https://github.com/owner/repo */
  url?: string;
}

export type CodeRefKind = "commit" | "pr" | "issue";

export interface CodeRef {
  kind: CodeRefKind;
  /** A commit SHA, or a pull request or issue number. */
  id: string;
  /** owner/repo when the reference names one, else the event's own source repo. */
  repo?: string;
  /** As written in the event, so an interface can show exactly that. */
  text: string;
  url?: string;
}

const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA = /^[0-9a-f]{7,40}$/i;

const scalar = (v: unknown): string => (v == null || typeof v === "object" ? "" : String(v).trim());

/**
 * Where a hosted repository lives, from a Git remote or a `repo:` value.
 * git@github.com:you/app.git and https://github.com/you/app both give
 * https://github.com/you/app.
 */
export function repoUrl(source: string): string | null {
  const s = source.trim().replace(/\.git\/?$/, "");
  if (!s) return null;
  if (REPO_NAME.test(s)) return `https://github.com/${s}`;
  const scp = /^[^@/]+@([^:/]+):(.+)$/.exec(s);
  if (scp) return `https://${scp[1]}/${scp[2]}`;
  if (/^https?:\/\//i.test(s)) return s.replace(/\/$/, "");
  if (/^ssh:\/\//i.test(s)) return s.replace(/^ssh:\/\/(?:[^@/]+@)?/i, "https://");
  return null;
}

/** owner/repo from anything that names a repository, or null. */
export function repoName(source: string): string | null {
  const url = repoUrl(source);
  if (!url) return null;
  const m = /^https?:\/\/[^/]+\/(.+)$/.exec(url);
  const path = m?.[1]?.replace(/\/$/, "");
  return path && REPO_NAME.test(path) ? path : null;
}

/** The `source:` block on an event: which repository, branch and commit it is about. */
export function sourceRef(entry: Entry): SourceRef | null {
  const raw = entry.meta.source;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const d = raw as Record<string, unknown>;
  // `source:` is also used by importers ({ adapter, id }); that isn't a code reference.
  const repo = scalar(d.repo);
  const branch = scalar(d.branch);
  const commit = scalar(d.commit);
  const url = scalar(d.url) || (repo ? (repoUrl(repo) ?? "") : "");
  if (!repo && !branch && !commit) return null;
  const out: SourceRef = {};
  if (repo) out.repo = repoName(repo) ?? repo;
  if (branch) out.branch = branch;
  if (commit && SHA.test(commit)) out.commit = commit.toLowerCase();
  if (url) out.url = url;
  return out;
}

const REFERENCE =
  // owner/repo#412 · #412 · https://github.com/owner/repo/pull/412 · a bare SHA
  /(?:^|[^\w/-])(?:(?<repo>[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*)#(?<num>\d+)|#(?<bare>\d+)|(?<url>https?:\/\/[^\s)<>]+\/(?:pull|issues|commit)\/[\w-]+(?:\.[\w-]+)*)|(?<=^|[\s(])(?<sha>[0-9a-f]{7,40})(?=$|[\s).,;]))/g;

// Code spans and HTML comments aren't prose: a #412 in either is an example or
// a note to the writer, not a reference this event makes.
const stripCode = (text: string): string =>
  text.replace(/```[\s\S]*?```/g, "\n").replace(/`[^`\n]*`/g, " ").replace(/<!--[\s\S]*?-->/g, " ");

/**
 * Every commit, pull request and issue an event refers to, in the order they
 * appear. `#412` belongs to the event's own source repository when it names
 * one; a number on its own with no repository anywhere is still reported, so an
 * interface can show it as plain text rather than a broken link.
 */
export function codeRefs(entry: Entry): CodeRef[] {
  const source = sourceRef(entry);
  const out: CodeRef[] = [];
  const add = (ref: CodeRef) => {
    // An abbreviated SHA in the text is the same commit as the full one in
    // `source:`, so the longer form wins and the event isn't listed twice.
    const same = out.find(
      (x) =>
        x.kind === ref.kind &&
        (x.repo ?? "") === (ref.repo ?? "") &&
        (x.id === ref.id || (ref.kind === "commit" && (x.id.startsWith(ref.id) || ref.id.startsWith(x.id)))),
    );
    if (same) {
      if (ref.kind === "commit" && ref.id.length > same.id.length) Object.assign(same, ref);
      return;
    }
    out.push(ref);
  };

  if (source?.commit) {
    add({ kind: "commit", id: source.commit, repo: source.repo, text: source.commit.slice(0, 12), url: commitUrl(source) ?? undefined });
  }

  for (const m of stripCode(entry.body).matchAll(REFERENCE)) {
    const g = m.groups ?? {};
    if (g.url) {
      const parsed = fromUrl(g.url);
      if (parsed) add(parsed);
    } else if (g.num && g.repo) {
      add({ kind: "pr", id: g.num, repo: repoName(g.repo) ?? g.repo, text: `${g.repo}#${g.num}`, url: `https://github.com/${g.repo}/issues/${g.num}` });
    } else if (g.bare) {
      const repo = source?.repo;
      add({ kind: "pr", id: g.bare, repo, text: `#${g.bare}`, url: repo ? `https://github.com/${repo}/issues/${g.bare}` : undefined });
    } else if (g.sha) {
      const url = source ? commitUrl({ ...source, commit: g.sha.toLowerCase() }) : null;
      add({ kind: "commit", id: g.sha.toLowerCase(), repo: source?.repo, text: g.sha.slice(0, 12), url: url ?? undefined });
    }
  }
  return out;
}

function fromUrl(raw: string): CodeRef | null {
  // A link at the end of a sentence carries the sentence's punctuation.
  const url = raw.replace(/[.,;:)\]]+$/, "");
  const m = /^(https?:\/\/[^/]+\/([\w.-]+\/[\w.-]+))\/(pull|issues|commit)\/([\w.-]+)/.exec(url);
  if (!m) return null;
  const kind: CodeRefKind = m[3] === "commit" ? "commit" : m[3] === "pull" ? "pr" : "issue";
  const id = m[4];
  return { kind, id: kind === "commit" ? id.toLowerCase() : id, repo: m[2], text: `${m[2]}${kind === "commit" ? `@${id.slice(0, 12)}` : `#${id}`}`, url };
}

/** A link to a commit on the host, when the event says where the code lives. */
export function commitUrl(source: SourceRef): string | null {
  const base = source.url ?? (source.repo ? repoUrl(source.repo) : null);
  return base && source.commit ? `${base}/commit/${source.commit}` : null;
}

/** A link to a branch on the host, for showing where an event's work happened. */
export function branchUrl(source: SourceRef): string | null {
  const base = source.url ?? (source.repo ? repoUrl(source.repo) : null);
  return base && source.branch ? `${base}/tree/${encodeURIComponent(source.branch)}` : null;
}
