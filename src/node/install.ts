// How GitRoll was installed, and the one command that upgrades or removes it.
//
// GitRoll used to download a release, check it against SHA256SUMS and run npm
// or Homebrew itself. Every way of installing it already has a package manager
// that does that better, and none of them needed a second one inside the app.
// What was worth keeping is knowing which one you used — and saying, plainly,
// that removing GitRoll doesn't touch a single Roll.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
    npm: "npm install --global gitroll@latest",
    source: "git pull && npm ci && npm run build",
  },
  uninstall: {
    homebrew: "brew uninstall gitroll",
    scoop: "scoop uninstall gitroll",
    npm: "npm uninstall --global gitroll",
    source: "Delete the source folder",
  },
} as const;
