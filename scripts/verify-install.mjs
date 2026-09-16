// Verifies a release on this machine as a new user would experience it:
// checks the package against SHA256SUMS, installs it into an empty location with no
// existing GitRoll settings, and uses the installed `gitroll` command end to end.
//
// Usage: node scripts/verify-install.mjs [release-dir]
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = path.resolve(process.argv[2] ?? "release");
const sums = fs.readFileSync(path.join(dir, "SHA256SUMS"), "utf8").trim().split("\n");
const [expected, tarball] = sums[0].split(/\s+/);
const actual = createHash("sha256").update(fs.readFileSync(path.join(dir, tarball))).digest("hex");
if (actual !== expected) throw new Error(`Checksum mismatch for ${tarball}: expected ${expected}, got ${actual}`);
console.log(`✓ ${tarball} matches SHA256SUMS`);

const home = fs.mkdtempSync(path.join(os.tmpdir(), "gitroll-verify-"));
const prefix = path.join(home, "prefix");
const env = {
  ...process.env,
  GITROLL_HOME: path.join(home, "settings"),
  GITROLL_ROLLS: path.join(home, "rolls"),
  GITROLL_EXPERIMENTAL: "",
  GIT_CONFIG_GLOBAL: path.join(home, "gitconfig"),
  GIT_CONFIG_NOSYSTEM: "1",
  npm_config_prefix: prefix,
};
fs.writeFileSync(env.GIT_CONFIG_GLOBAL, "[user]\n\tname = Release Check\n\temail = release@example.com\n[init]\n\tdefaultBranch = main\n");

const windows = process.platform === "win32";
execFileSync("npm", ["install", "--global", "--no-audit", "--no-fund", path.join(dir, tarball)], { env, stdio: ["ignore", "ignore", "inherit"], shell: windows });
const bin = windows ? path.join(prefix, "gitroll.cmd") : path.join(prefix, "bin", "gitroll");
if (!fs.existsSync(bin)) throw new Error(`The installed command wasn't found at ${bin}`);
const installed = path.join(prefix, windows ? "" : "lib", "node_modules", "gitroll");
const bundledDeps = fs.existsSync(path.join(installed, "node_modules")) ? fs.readdirSync(path.join(installed, "node_modules")).filter((d) => !d.startsWith(".")) : [];
if (bundledDeps.length) throw new Error(`The package installed runtime dependencies: ${bundledDeps.join(", ")}`);
console.log(`✓ installed with no runtime dependencies (node ${process.versions.node}, ${process.platform})`);

function gitroll(args, { fail = false } = {}) {
  const result = spawnSync(bin, args, { env, encoding: "utf8", shell: windows, cwd: home });
  const out = `${result.stdout}${result.stderr}`;
  if (!fail && result.status !== 0) throw new Error(`gitroll ${args.join(" ")} failed (${result.status}):\n${out}`);
  if (fail && result.status === 0) throw new Error(`gitroll ${args.join(" ")} should have failed:\n${out}`);
  return out;
}
const expect = (out, pattern, what) => {
  if (!pattern.test(out)) throw new Error(`${what}: expected ${pattern}, got:\n${out}`);
  console.log(`✓ ${what}`);
};

expect(gitroll(["help"]), /gitroll log "what happened"/, "help works");
expect(gitroll(["new", "Release Check"]), /Created the Roll/, "creates a Roll");
const receipt = path.join(home, "receipt.pdf");
fs.writeFileSync(receipt, "%PDF-1.4 release check");
expect(gitroll(["log", "Installed GitRoll from the release #release", receipt]), /Logged/, "logs an event with an attachment");
expect(gitroll(["find", "release"]), /Installed GitRoll from the release/, "finds the event");
expect(gitroll(["check"]), /The Roll looks good/, "the Roll validates");
expect(gitroll(["sync"], { fail: true }), /isn't backed up yet/, "sync explains that there's no backup");
// Ask ships as a normal feature now, so checking that it was hidden is checking
// for the old behavior. What matters in a release is that it stays off until
// someone sets it up, and that the models running on this computer come first.
expect(gitroll(["ask", "anything"], { fail: true }), /Ask isn't set up yet/, "Ask asks for a model instead of answering");
expect(gitroll(["ai"]), /nothing you log ever leaves it/, "gitroll ai offers the models on this computer first");
expect(gitroll(["rolls", "--json"]), /"release-check"/, "lists the Roll");

expect(gitroll(["version"]), /GitRoll \d+\.\d+\.\d+ \(installed with the installer or npm\)/, "reports its version and install method");
expect(gitroll(["uninstall", "--dry-run"]), /Nothing was changed[\s\S]*|all of your Rolls/, "uninstall explains what it keeps");
if (!windows) {
  // Windows can't remove the running command's own shim, so there the documented npm command is used.
  expect(gitroll(["uninstall", "--yes"]), /GitRoll was uninstalled/, "uninstalls itself");
} else {
  execFileSync("npm", ["uninstall", "--global", "gitroll"], { env, stdio: ["ignore", "ignore", "inherit"], shell: true });
}
if (fs.existsSync(bin)) throw new Error("The gitroll command is still installed after uninstalling");
if (!fs.existsSync(path.join(env.GITROLL_ROLLS, "release-check", ".gitroll", "config.yaml"))) throw new Error("Uninstalling removed a Roll");
if (!fs.existsSync(path.join(env.GITROLL_HOME, "config.json"))) throw new Error("Uninstalling removed settings without --remove-settings");
console.log("✓ uninstall removed the app and kept the Roll and settings");

fs.rmSync(home, { recursive: true, force: true });
console.log("Release verified.");
