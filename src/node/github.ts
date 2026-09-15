// Small, optional GitHub conveniences. GitRoll works with any Git host; these
// only add safety checks and shortcuts when the remote is on github.com.

import { execFileSync, spawnSync } from "node:child_process";
import { UserError } from "../core/util.ts";

export function parseGitHubRemote(url: string): { owner: string; repo: string } | null {
  const m = /github\.com[:/]+([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? { owner: m[1], repo: m[2] } : null;
}

export type Visibility = "public" | "not-public" | "unknown";

/**
 * Whether anyone on the internet can read a GitHub repository.
 *
 * Asks GitHub without credentials first: a 200 with `private: false` is public, and a
 * 404 means the repository isn't publicly readable. Anything else (offline, rate limited,
 * an unexpected answer) falls back to the signed-in GitHub CLI if available, and
 * otherwise returns "unknown". Callers must treat "unknown" as unsafe.
 */
export async function githubVisibility(owner: string, repo: string, fetchImpl: typeof fetch = fetch, useGhCli = true): Promise<Visibility> {
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "gitroll" },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 404) return "not-public";
    if (res.status === 200) {
      const data = (await res.json()) as { private?: unknown };
      if (data.private === false) return "public";
      if (data.private === true) return "not-public";
    }
  } catch {
    // fall through to the GitHub CLI
  }
  if (useGhCli && hasGh()) {
    const result = spawnSync("gh", ["api", `repos/${owner}/${repo}`, "--jq", ".private"], { encoding: "utf8", timeout: 15_000, env: { ...process.env, GH_PROMPT_DISABLED: "1" } });
    const answer = result.status === 0 ? result.stdout.trim() : "";
    if (answer === "false") return "public";
    if (answer === "true") return "not-public";
  }
  return "unknown";
}

export function hasGh(): boolean {
  return spawnSync("gh", ["--version"], { stdio: "ignore" }).status === 0;
}

export function ghSignedIn(): boolean {
  return spawnSync("gh", ["auth", "status"], { stdio: "ignore" }).status === 0;
}

/** Runs the GitHub CLI with arguments (never a shell). */
export function gh(args: string[], opts: { cwd?: string; inherit?: boolean } = {}): string {
  try {
    return execFileSync("gh", args, {
      cwd: opts.cwd,
      encoding: "utf8",
      stdio: opts.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
      env: { ...process.env, GH_PROMPT_DISABLED: opts.inherit ? process.env.GH_PROMPT_DISABLED : "1" },
    }) ?? "";
  } catch (e) {
    const err = e as { stderr?: string; code?: string; message: string };
    if (err.code === "ENOENT") throw new UserError("This needs the GitHub CLI. Install it from https://cli.github.com and run: gh auth login");
    throw new UserError((err.stderr || err.message).trim());
  }
}
