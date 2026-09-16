import "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { GitRoll } from "../src/node/repo.ts";
import { tmp } from "./helpers.ts";

const script = fileURLToPath(new URL("../scripts/publish-template.mjs", import.meta.url));

test("the published template is a valid Roll made only of data files", () => {
  const out = path.join(tmp(), "template");
  execFileSync(process.execPath, [script, "--out", out], { env: process.env, stdio: "pipe" });
  const files = fs.readdirSync(out, { recursive: true }).map(String).filter((f) => fs.statSync(path.join(out, f)).isFile()).sort();
  assert.ok(files.includes(path.join(".gitroll", "config.yaml")));
  assert.match(fs.readFileSync(path.join(out, ".gitroll/config.yaml"), "utf8"), /^template_version: 1$/m);
  assert.ok(!files.some((f) => f.startsWith(".github") || /\.(js|mjs|ts|sh|py)$/.test(f)), `unexpected files: ${files.join(", ")}`);
  // The root README is short and points at the log; the instructions live with it.
  const readme = fs.readFileSync(path.join(out, "README.md"), "utf8");
  assert.match(readme, /\.gitroll\/events/);
  assert.match(readme, /## Using this template[\s\S]*Use this template → Create a new repository[\s\S]*namespace, not a privacy boundary[\s\S]*jimhoyd-com\/gitroll\/issues/);

  // The first thing a reader of the log sees is how to add an event with nothing installed.
  const rollReadme = fs.readFileSync(path.join(out, ".gitroll/README.md"), "utf8");
  assert.match(rollReadme, /## Log something[\s\S]*\.gitroll\/events\/2026-09-15-ac-serviced\.md[\s\S]*## Optional metadata[\s\S]*## Using GitRoll \(optional\)/);
  assert.match(rollReadme, /namespace, not a privacy\s+boundary/);
  assert.deepEqual(new GitRoll(out).check(), []);
});
