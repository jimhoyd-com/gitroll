// How GitRoll was installed, and how to upgrade or remove it. Never touches Rolls.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UserError } from "../core/util.ts";

export const RELEASE_REPO = "jimhoyd-com/gitroll";

export type InstallMethod = "homebrew" | "scoop" | "npm" | "source";

export interface Install {
  method: InstallMethod;
  version: string;
  /** Folder that holds the installed package (or the source checkout). */
  root: string;
}

/** Finds GitRoll's own package.json above the running file (dist/gitroll.mjs or src/node/cli.ts). */
export function detectInstall(entry = fileURLToPath(import.meta.url)): Install {
  let real = entry;
  try {
    real = fs.realpathSync(entry);
  } catch {
    // Use the path as given.
  }
  let dir = path.dirname(real);
  for (;;) {
    const pkg = path.join(dir, "package.json");
    if (fs.existsSync(pkg)) {
      try {
        const data = JSON.parse(fs.readFileSync(pkg, "utf8")) as { name?: string; version?: string };
        if (data.name === "gitroll") return { method: methodFor(dir), version: data.version ?? "unknown", root: dir };
      } catch {
        // Keep looking.
      }
    }
    const up = path.dirname(dir);
    if (up === dir) return { method: "source", version: "unknown", root: path.dirname(real) };
    dir = up;
  }
}

export function methodFor(root: string): InstallMethod {
  const p = root.replace(/\\/g, "/");
  if (/\/Cellar\/gitroll\/|\/homebrew\/.*\/gitroll(\/|$)|\/linuxbrew\//.test(p)) return "homebrew";
  if (/\/scoop\/apps\/gitroll(\/|$)/i.test(p)) return "scoop";
  if (/\/node_modules\/gitroll$/.test(p)) return "npm";
  return "source";
}

export const commands = {
  upgrade: {
    homebrew: "brew upgrade gitroll",
    scoop: "scoop update gitroll",
    npm: "gitroll upgrade",
    source: "git pull && npm ci && npm run build",
  },
  uninstall: {
    homebrew: "brew uninstall gitroll",
    scoop: "scoop uninstall gitroll",
    npm: "npm uninstall --global gitroll",
    source: "Delete the source folder",
  },
} as const;

/** Latest published version, from GitHub's releases API. Sends nothing about the user or their Rolls. */
export async function latestVersion(fetcher: typeof fetch = fetch): Promise<string> {
  const res = await fetcher(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`, { headers: { accept: "application/vnd.github+json", "user-agent": "gitroll" } });
  if (!res.ok) throw new UserError(`Couldn't check for updates (GitHub said ${res.status}). Try again later.`);
  const tag = ((await res.json()) as { tag_name?: string }).tag_name ?? "";
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new UserError("Couldn't read the latest GitRoll version.");
  return tag.slice(1);
}

export function newer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

/** Downloads a release package and checks it against the release's SHA256SUMS. Returns the file path. */
export async function downloadVerified(version: string, fetcher: typeof fetch = fetch): Promise<string> {
  const base = `https://github.com/${RELEASE_REPO}/releases/download/v${version}`;
  const name = `gitroll-${version}.tgz`;
  const get = async (url: string) => {
    const res = await fetcher(url, { headers: { "user-agent": "gitroll" } });
    if (!res.ok) throw new UserError(`Couldn't download ${url} (${res.status}). Nothing was changed.`);
    return Buffer.from(await res.arrayBuffer());
  };
  const [pkg, sums] = await Promise.all([get(`${base}/${name}`), get(`${base}/SHA256SUMS`)]);
  const expected = sums
    .toString("utf8")
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .find(([, file]) => file === name)?.[0];
  const actual = createHash("sha256").update(pkg).digest("hex");
  if (!expected || expected !== actual) throw new UserError("The download didn't match its checksum. Nothing was changed.");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gitroll-upgrade-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, pkg);
  return file;
}

export function run(cmd: string, args: string[]): void {
  execFileSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });
}
