// Builds the installable app: dist/gitroll.mjs (CLI + local server), dist/web/ (browser app),
// and dist/THIRD_PARTY_NOTICES.txt for every third-party package bundled into either.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
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
  entryPoints: ["src/web/main.tsx"],
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  outfile: "dist/web/app.js",
  metafile: true,
  minify: true,
  legalComments: "eof",
  charset: "utf8",
  jsx: "automatic",
  // React and its ecosystem branch on this; without it the bundle keeps the
  // development-only warning paths and grows by roughly a third.
  define: { "process.env.NODE_ENV": '"production"' },
  banner: { js: banner },
});
for (const file of ["index.html", "icon.svg"]) fs.copyFileSync(`web/${file}`, `dist/web/${file}`);

// Tailwind compiles web/app.css (tokens + component layers) into the single
// stylesheet the app loads. Only the utilities actually used are emitted.
const tailwind = spawnSync(
  process.execPath,
  ["node_modules/@tailwindcss/cli/dist/index.mjs", "--input", "web/app.css", "--output", "dist/web/style.css", "--minify"],
  { stdio: "inherit" },
);
if (tailwind.status !== 0) {
  console.error("Tailwind failed to build the stylesheet.");
  process.exit(1);
}

/**
 * Some packages declare a license but ship no license file. MIT and ISC both
 * require their text to travel with the code, so rather than omit the notice,
 * reproduce the standard text for the declared license and attribute it to the
 * copyright holder the package names. Anything else still fails the build,
 * because its terms can't be reconstructed from an SPDX id alone.
 */
function reconstructLicense(meta) {
  const id = String(meta.license ?? "");
  const author = typeof meta.author === "object" ? meta.author?.name : meta.author;
  // npm writes an author string as `Name <email> (url)`, so the name is simply
  // what comes before the address. Take that, rather than stripping the parts
  // that aren't wanted: removing bracketed spans in one pass is defeated by
  // nesting, and a name is not something to sanitize in the first place.
  const holder = String(author ?? meta.name ?? "").split(/[<(]/)[0].trim() || "the authors";
  const copyright = `Copyright (c) ${holder}`;
  const note = `[Reproduced from the "${id}" license declared by ${meta.name} ${meta.version}, which ships no license file.]`;

  if (id === "MIT") {
    return `${note}\n\nMIT License\n\n${copyright}\n\n${MIT_BODY}`;
  }
  if (id === "ISC") {
    return `${note}\n\nISC License\n\n${copyright}\n\n${ISC_BODY}`;
  }
  return null;
}

const MIT_BODY = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

const ISC_BODY = `Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.`;

// License notices for every bundled package (required by their licenses).
const packages = new Map();
for (const input of [...Object.keys(cli.metafile.inputs), ...Object.keys(web.metafile.inputs)]) {
  const m = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input);
  if (!m || packages.has(m[1])) continue;
  const dir = path.join("node_modules", m[1]);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  const licenseFile = fs.readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
  const text = licenseFile ? fs.readFileSync(path.join(dir, licenseFile), "utf8").trim() : reconstructLicense(meta);
  if (!text) throw new Error(`No license file found for bundled package ${m[1]} (declared: ${meta.license ?? "none"})`);
  packages.set(m[1], { version: meta.version, license: meta.license, text });
}
const notices = [
  "GitRoll includes the following third-party software.",
  "",
  ...[...packages].flatMap(([name, p]) => [`${"=".repeat(72)}`, `${name} ${p.version} (${p.license})`, `${"=".repeat(72)}`, "", p.text, ""]),
].join("\n");
fs.writeFileSync("dist/THIRD_PARTY_NOTICES.txt", notices);
fs.copyFileSync("dist/THIRD_PARTY_NOTICES.txt", "dist/web/THIRD_PARTY_NOTICES.txt");

console.log(`Built dist/ (bundled: ${[...packages.keys()].join(", ") || "no third-party packages"})`);
