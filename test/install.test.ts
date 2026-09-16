import "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { detectInstall, methodFor } from "../src/node/install.ts";

const cli = fileURLToPath(new URL("../src/node/cli.ts", import.meta.url));

function gitroll(args: string[]): { out: string; code: number } {
  try {
    return { out: execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", cli, ...args], { encoding: "utf8", input: "", stdio: ["pipe", "pipe", "pipe"] }), code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { out: `${err.stdout ?? ""}${err.stderr ?? ""}`, code: err.status ?? 1 };
  }
}

/*
 * Installing GitRoll must never pull anything else down with it: everything the
 * app uses is bundled by esbuild, so the published package has no runtime
 * dependencies at all. `make verify-release` proves this against a real install,
 * but that only runs when a release is cut — by which point a stray dependency
 * has already been merged. This is the cheap version that fails in CI instead.
 */
test("the published package installs nothing at runtime", () => {
  const pkg = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
    const names = Object.keys(pkg[field] ?? {});
    assert.deepEqual(names, [], `package.json "${field}" must stay empty; anything the app needs is bundled. Found: ${names.join(", ")}`);
  }
});

test("install method is recognized from where GitRoll lives", () => {
  assert.equal(methodFor("/opt/homebrew/Cellar/gitroll/0.1.0/libexec/lib/node_modules/gitroll"), "homebrew");
  assert.equal(methodFor("/home/linuxbrew/.linuxbrew/Cellar/gitroll/0.1.0/libexec/lib/node_modules/gitroll"), "homebrew");
  assert.equal(methodFor("/usr/local/lib/node_modules/gitroll"), "npm");
  assert.equal(methodFor("C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\gitroll"), "npm");
  assert.equal(methodFor("C:\\Users\\me\\scoop\\apps\\gitroll\\0.1.1"), "scoop");
  assert.equal(methodFor("D:\\Scoop\\apps\\gitroll\\current"), "scoop");
  assert.equal(methodFor("/Users/me/Projects/gitroll"), "source");
  const here = detectInstall(cli);
  assert.equal(here.method, "source");
  assert.equal(here.version, JSON.parse(fs.readFileSync(path.join(here.root, "package.json"), "utf8")).version);
});

test("version, upgrade and uninstall say the one command to run, and never run it", () => {
  // Whatever installed GitRoll upgrades and removes it. GitRoll's job is to
  // name the command for the way it was installed — and to be clear that
  // removing the app leaves every Roll exactly where it is.
  assert.match(gitroll(["version"]).out, /GitRoll \d+\.\d+\.\d+ \(running from source/);
  assert.match(gitroll(["--version"]).out, /GitRoll \d+\.\d+\.\d+/);
  assert.match(gitroll(["upgrade"]).out, /git pull && npm ci && npm run build/);

  assert.equal(gitroll(["new", "Keep Me"]).code, 0);
  const roll = path.join(process.env.GITROLL_ROLLS!, "keep-me");
  const settings = process.env.GITROLL_HOME!;

  const out = gitroll(["uninstall"]);
  assert.equal(out.code, 0, out.out);
  assert.match(out.out, /To remove it: Delete the source folder/);
  assert.match(out.out, /leaves everything you've written where it is[\s\S]*keep-me/);
  assert.match(out.out, /settings/);
  assert.ok(fs.existsSync(path.join(settings, "config.json")), "nothing was deleted");
  assert.ok(fs.existsSync(path.join(roll, ".gitroll", "config.yaml")), "the Roll is untouched");
});

/*
 * The README ships in the package and links to pages under docs/. Those pages
 * are listed in "files" one by one rather than as the whole folder, so that
 * repository-only documents (docs/ROADMAP.md, which is for contributors) stay
 * out of everyone's node_modules. The cost of listing them individually is that
 * adding a page and linking it from the README silently breaks that link for
 * anyone who installed GitRoll instead of cloning it. This catches that here
 * rather than after a release.
 */
test("every docs page the README links to ships in the package", () => {
  const root = new URL("../", import.meta.url);
  const pkg = JSON.parse(fs.readFileSync(fileURLToPath(new URL("package.json", root)), "utf8")) as { files: string[] };
  const readme = fs.readFileSync(fileURLToPath(new URL("README.md", root)), "utf8");

  const linked = [...readme.matchAll(/\]\((docs\/[^)#\s]+)\)/g)].map((m) => m[1]);
  assert.ok(linked.length > 0, "expected the README to link at least one docs/ page");

  for (const target of new Set(linked)) {
    assert.ok(fs.existsSync(fileURLToPath(new URL(target, root))), `README links ${target}, which doesn't exist`);
    const shipped = pkg.files.some((entry) => entry === target || target.startsWith(`${entry.replace(/\/$/, "")}/`));
    assert.ok(shipped, `README links ${target}, so it must be in package.json "files" or the link breaks once installed`);
  }
});
