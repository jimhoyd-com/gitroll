// Running GitRoll from this checkout, against a Roll you can safely ruin.
//
//   npm run dev                       open the sandbox Roll in the terminal app
//   npm run dev -- log "something"    any CLI command, straight from src/
//   npm run dev -- open               the browser app (needs `npm run watch` or `npm run build`)
//   npm run dev -- --reset            throw the sandbox away and seed a new one
//   npm run dev -- --real status      your own Rolls, not the sandbox
//
// The sandbox lives in .dev/ and is created on first use, with settings and a
// Rolls folder of its own: nothing here can reach the Rolls you actually keep.
// It is seeded with the awkward cases worth looking at — entries written by
// hand, a backdated one, a month that has been archived — because those are the
// ones that are tedious to make by hand every time.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
process.chdir(root);

// npm strips the first `--`; anyone running this script directly may not.
const args = process.argv.slice(2).filter((a) => a !== "--");
const flag = (name) => {
  const at = args.indexOf(name);
  if (at < 0) return false;
  args.splice(at, 1);
  return true;
};

const real = flag("--real");
const reset = flag("--reset");
const sandbox = path.join(root, ".dev");
const rollDir = path.join(sandbox, "rolls", "sandbox");

const env = real
  ? { ...process.env }
  : {
      ...process.env,
      GITROLL_HOME: path.join(sandbox, "settings"),
      GITROLL_ROLLS: path.join(sandbox, "rolls"),
    };

if (reset) {
  fs.rmSync(sandbox, { recursive: true, force: true });
  console.log("Threw the sandbox away.");
}

/** The CLI, from source: no build step, so an edit is live on the next command. */
function cli(argv, opts = {}) {
  return spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "src/node/cli.ts", ...argv], {
    stdio: opts.quiet ? ["ignore", "ignore", "inherit"] : "inherit",
    env,
  });
}

if (!real && !fs.existsSync(path.join(rollDir, ".gitroll/config.yaml"))) seed();

// No command means "open it", which is what you want nine times out of ten.
const forwarded = args.length ? args : ["menu"];
const inRoll = real || forwarded.some((a) => a === "-C" || a === "--repo" || a === "--roll");
const result = cli(inRoll ? forwarded : [...forwarded, "-C", rollDir]);
process.exit(result.status ?? 0);

/** A Roll with the things that are interesting to look at, and tedious to type. */
function seed() {
  console.log("Making a sandbox Roll in .dev/ …");
  fs.mkdirSync(path.dirname(rollDir), { recursive: true });
  cli(["new", "Sandbox", "--dir", rollDir], { quiet: true });
  cli(["-C", rollDir, "storage", "--mode", "monthly", "--timezone", "America/Chicago"], { quiet: true });

  const log = (text, ...rest) => cli(["-C", rollDir, "log", text, ...rest], { quiet: true });
  log("Checkout times out under load\n\np99 went from 300ms to 9s after the 14:10 deploy. Rolled back; the index dropped in 9f1c2d3 is the cause.\n\n## What we tried\n\n- Pool size: no change\n- Revert: p99 back to 310ms\n\n#incident");
  log("Decided to queue writes instead of retrying\n\nRetries amplified the load. Revisit if p99 stays above 500ms.\n\n#decision");
  log("Paid the on-call vendor\n\nInvoice for September support.", "--amount", "$1,850", "-t", "invoice");
  log("Roof inspected\n\nNo damage after the storm.", "--at", "2026-09-08T14:10");
  log("Boiler serviced\n\nCapacitor replaced. One-year warranty.", "--at", "2026-09-03");
  log("Something from a month that gets archived", "--at", "2026-07-11");
  log("…and something else from it", "--at", "2026-07-19");

  // An entry somebody typed into the file themselves, with their own spacing
  // and no marker: the case GitRoll must never tidy up.
  const september = path.join(rollDir, ".gitroll/logs/2026/09.md");
  fs.appendFileSync(september, "\n# Bought a drill\n\n\nFrom   the hardware shop on the corner.   \nReceipt is in the drawer.\n");
  spawnSync("git", ["add", "-A"], { cwd: rollDir, stdio: "ignore", env });
  spawnSync("git", ["commit", "-qm", "Bought a drill"], { cwd: rollDir, stdio: "ignore", env });

  cli(["-C", rollDir, "archive", "2026-07", "--compress"], { quiet: true });

  console.log(`Seeded ${path.relative(root, rollDir)}:`);
  console.log("  • entries logged through GitRoll, one backdated with a time, one date-only");
  console.log("  • an entry written by hand, with no marker (gitroll adopt gives it an id)");
  console.log("  • July archived and gzipped (gitroll find '…' --include-archive)");
  console.log("");
}
