import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// src/core is shared with the browser app and with GitRoll.com's edge runtime, so it must stay platform-free.
test("the shared core imports nothing platform-specific", () => {
  const dir = fileURLToPath(new URL("../src/core/", import.meta.url));
  const files = fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith(".ts"));
  for (const file of files) {
    const source = fs.readFileSync(`${dir}${file}`, "utf8");
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    for (const spec of imports) {
      assert.ok(spec.startsWith(".") || spec === "yaml", `${file} imports ${spec}; core may only import relative files and yaml`);
    }
    assert.doesNotMatch(source, /\b(process\.|Buffer\b|require\()/, `${file} uses a Node-only global`);
  }
});
