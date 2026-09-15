// Builds versioned release artifacts in release/:
//   gitroll-<version>.tgz   the installable package (built app, starter files, docs, notices)
//   SHA256SUMS              checksum of the package
//   gitroll.rb              Homebrew formula pointing at the published package
//   gitroll.json            Scoop manifest pointing at the published package
//
// Usage: node scripts/release.mjs [--base-url <url>]
// The base URL is where the package will be downloaded from (default: this version's GitHub Release).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));
const { values } = parseArgs({ options: { "base-url": { type: "string" }, repo: { type: "string" } } });
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const version = pkg.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`package.json version must be X.Y.Z, got ${version}`);
if (process.env.RELEASE_TAG && process.env.RELEASE_TAG !== `v${version}`) {
  throw new Error(`Tag ${process.env.RELEASE_TAG} doesn't match package.json version ${version}`);
}
const repo = values.repo ?? process.env.GITHUB_REPOSITORY ?? "jimhoyd-com/gitroll";
const baseUrl = (values["base-url"] ?? `https://github.com/${repo}/releases/download/v${version}`).replace(/\/$/, "");

fs.rmSync("release", { recursive: true, force: true });
fs.mkdirSync("release");

// npm pack runs the build (prepare) and includes only the "files" in package.json.
execFileSync("npm", ["pack", "--pack-destination", "release"], { stdio: ["ignore", "ignore", "inherit"], shell: process.platform === "win32" });
const tarball = `gitroll-${version}.tgz`;
const tarballPath = path.join("release", tarball);
if (!fs.existsSync(tarballPath)) throw new Error(`npm pack didn't produce ${tarball}`);

const contents = execFileSync("tar", ["-tzf", tarballPath], { encoding: "utf8" }).split("\n").filter(Boolean);
for (const required of ["package/dist/gitroll.mjs", "package/dist/web/index.html", "package/dist/THIRD_PARTY_NOTICES.txt", "package/template/.gitroll/config.yaml", "package/LICENSE"]) {
  if (!contents.includes(required)) throw new Error(`Release package is missing ${required}`);
}
for (const forbidden of [/^package\/src\//, /^package\/test\//, /^package\/\.github\//, /^package\/template\/\.github\//, /node_modules\//]) {
  const hit = contents.find((f) => forbidden.test(f));
  if (hit) throw new Error(`Release package must not contain ${hit}`);
}

const sha256 = createHash("sha256").update(fs.readFileSync(tarballPath)).digest("hex");
fs.writeFileSync(path.join("release", "SHA256SUMS"), `${sha256}  ${tarball}\n`);

const render = (template, output) => {
  let text = fs.readFileSync(template, "utf8");
  for (const [key, value] of Object.entries({ VERSION: version, URL: `${baseUrl}/${tarball}`, SHA256: sha256, REPO: repo })) {
    text = text.replaceAll(`{{${key}}}`, value);
  }
  const leftover = /\{\{[A-Z0-9_]+\}\}/.exec(text);
  if (leftover) throw new Error(`${template} has an unfilled placeholder ${leftover[0]}`);
  fs.writeFileSync(path.join("release", output), text);
};
render("packaging/homebrew/gitroll.rb.template", "gitroll.rb");
render("packaging/scoop/gitroll.json.template", "gitroll.json");
JSON.parse(fs.readFileSync("release/gitroll.json", "utf8"));

console.log(`Release ${version}`);
for (const f of fs.readdirSync("release")) console.log(`  release/${f}`);
console.log(`  sha256 ${sha256}`);
console.log(`  download URL ${baseUrl}/${tarball}`);
