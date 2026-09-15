// Builds the installable app: dist/gitroll.mjs (CLI + local server), dist/web/ (browser app),
// and dist/THIRD_PARTY_NOTICES.txt for every third-party package bundled into either.
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const banner = `/*! GitRoll ${pkg.version} · MIT License · Includes third-party software; see THIRD_PARTY_NOTICES.txt */`;

fs.rmSync("dist", { recursive: true, force: true });
fs.mkdirSync("dist/web", { recursive: true });

const cli = await build({
  entryPoints: ["src/node/cli.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: "dist/gitroll.mjs",
  metafile: true,
  legalComments: "eof",
  // Bundled CommonJS dependencies call require(); give the ESM bundle one.
  banner: { js: `${banner}\nimport { createRequire as __gitrollRequire } from "node:module"; const require = __gitrollRequire(import.meta.url);` },
});
fs.chmodSync("dist/gitroll.mjs", 0o755);

const web = await build({
  entryPoints: ["src/web/main.ts"],
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  outfile: "dist/web/app.js",
  metafile: true,
  minify: true,
  legalComments: "eof",
  charset: "utf8",
  banner: { js: banner },
});
for (const file of ["index.html", "style.css", "icon.svg"]) fs.copyFileSync(`web/${file}`, `dist/web/${file}`);

// License notices for every bundled package (required by their licenses).
const packages = new Map();
for (const input of [...Object.keys(cli.metafile.inputs), ...Object.keys(web.metafile.inputs)]) {
  const m = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input);
  if (!m || packages.has(m[1])) continue;
  const dir = path.join("node_modules", m[1]);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  const licenseFile = fs.readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
  if (!licenseFile) throw new Error(`No license file found for bundled package ${m[1]}`);
  packages.set(m[1], { version: meta.version, license: meta.license, text: fs.readFileSync(path.join(dir, licenseFile), "utf8").trim() });
}
const notices = [
  "GitRoll includes the following third-party software.",
  "",
  ...[...packages].flatMap(([name, p]) => [`${"=".repeat(72)}`, `${name} ${p.version} (${p.license})`, `${"=".repeat(72)}`, "", p.text, ""]),
].join("\n");
fs.writeFileSync("dist/THIRD_PARTY_NOTICES.txt", notices);
fs.copyFileSync("dist/THIRD_PARTY_NOTICES.txt", "dist/web/THIRD_PARTY_NOTICES.txt");

console.log(`Built dist/ (bundled: ${[...packages.keys()].join(", ") || "no third-party packages"})`);
