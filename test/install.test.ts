import "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { detectInstall, downloadVerified, methodFor, newer } from "../src/node/install.ts";

const cli = fileURLToPath(new URL("../src/node/cli.ts", import.meta.url));

function gitroll(args: string[]): { out: string; code: number } {
  try {
    return { out: execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", cli, ...args], { encoding: "utf8", input: "", stdio: ["pipe", "pipe", "pipe"] }), code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { out: `${err.stdout ?? ""}${err.stderr ?? ""}`, code: err.status ?? 1 };
  }
}

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

test("versions compare numerically", () => {
  assert.ok(newer("0.10.0", "0.9.9"));
  assert.ok(newer("1.0.0", "0.99.99"));
  assert.ok(!newer("0.1.0", "0.1.0"));
  assert.ok(!newer("0.1.0", "0.2.0"));
});

test("upgrades only install a download that matches the release checksum", async () => {
  const pkg = Buffer.from("package bytes");
  const good = `${createHash("sha256").update(pkg).digest("hex")}  gitroll-9.9.9.tgz\n`;
  const fake = (sums: string) =>
    (async (url: string | URL | Request) => new Response(String(url).endsWith("SHA256SUMS") ? sums : pkg)) as typeof fetch;

  const file = await downloadVerified("9.9.9", fake(good));
  assert.deepEqual(fs.readFileSync(file), pkg);
  fs.rmSync(path.dirname(file), { recursive: true });

  await assert.rejects(downloadVerified("9.9.9", fake(`${"0".repeat(64)}  gitroll-9.9.9.tgz\n`)), /didn't match its checksum/);
  await assert.rejects(downloadVerified("9.9.9", fake("")), /didn't match its checksum/);
  const missing = (async () => new Response("no", { status: 404 })) as typeof fetch;
  await assert.rejects(downloadVerified("9.9.9", missing), /Couldn't download/);
});

test("version, upgrade and uninstall explain themselves, and uninstall never deletes Rolls", () => {
  assert.match(gitroll(["version"]).out, /GitRoll \d+\.\d+\.\d+ \(running from source/);
  assert.match(gitroll(["--version"]).out, /GitRoll \d+\.\d+\.\d+/);
  assert.match(gitroll(["upgrade"]).out, /git pull && npm ci && npm run build/);

  assert.equal(gitroll(["new", "Keep Me"]).code, 0);
  const roll = path.join(process.env.GITROLL_ROLLS!, "keep-me");
  const settings = process.env.GITROLL_HOME!;

  const plan = gitroll(["uninstall", "--dry-run", "--remove-settings"]);
  assert.match(plan.out, /This removes:[\s\S]*settings[\s\S]*This keeps:[\s\S]*all of your Rolls[\s\S]*keep-me/);
  assert.match(plan.out, /Nothing was changed/);
  assert.ok(fs.existsSync(path.join(settings, "config.json")));

  const unconfirmed = gitroll(["uninstall", "--remove-settings"]);
  assert.notEqual(unconfirmed.code, 0);
  assert.match(unconfirmed.out, /--yes/);
  assert.ok(fs.existsSync(path.join(settings, "config.json")), "nothing happens without confirmation");

  const done = gitroll(["uninstall", "--remove-settings", "--yes"]);
  assert.equal(done.code, 0, done.out);
  assert.ok(!fs.existsSync(settings), "settings removed when asked");
  assert.ok(fs.existsSync(path.join(roll, ".gitroll", "config.yaml")), "the Roll is untouched");
});

test("uninstall refuses to delete a settings folder that isn't GitRoll's", () => {
  const settings = process.env.GITROLL_HOME!;
  fs.mkdirSync(settings, { recursive: true });
  fs.writeFileSync(path.join(settings, "important.txt"), "not ours");
  const result = gitroll(["uninstall", "--remove-settings", "--yes"]);
  assert.notEqual(result.code, 0);
  assert.match(result.out, /doesn't look like GitRoll's settings/);
  assert.ok(fs.existsSync(path.join(settings, "important.txt")));
  fs.rmSync(path.join(settings, "important.txt"));
});
