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
  assert.ok(!files.some((f) => f.startsWith(".github") || /\.(js|mjs|ts|sh|py)$/.test(f)), `unexpected files: ${files.join(", ")}`);
  assert.match(fs.readFileSync(path.join(out, "README.md"), "utf8"), /Created from the GitRoll template/);
  assert.deepEqual(new GitRoll(out).check(), []);
});
