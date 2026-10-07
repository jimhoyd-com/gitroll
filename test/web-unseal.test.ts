// Sealed content in the browser interface, with and without a host that can
// open it (src/web/unseal.tsx), driven in a real browser like test/web.test.ts:
// locked, the block stays a placeholder with an Unlock button; unlocked, it is
// shown opened and marked as sealed; with no unsealer at all, nothing changes.
// axe checks both states, in light and dark.
//
// The page is the real EntryDetail, bundled here with esbuild around a fake
// host, and served by a throwaway server: the local app has no unsealer to
// test it with.

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { build } from "esbuild";
import { X25519Identity, armor, encrypt } from "../src/core/age/format.ts";
import { utf8 } from "../src/core/age/bytes.ts";
import { nodeAgeCrypto } from "../src/node/age-crypto.ts";

const STYLE = path.resolve("dist/web/style.css");
const built = fs.existsSync(STYLE);
const SECRET_BLOCK = "The safe code is **2716**.";
const SECRET_FIELD = "4417";
const SECRET_FILE = "Spare key is under the blue pot.";

async function browserOrNull() {
  try {
    const { chromium } = await import("playwright");
    return await chromium.launch({ executablePath: process.env.GITROLL_TEST_CHROMIUM || undefined });
  } catch {
    return null;
  }
}

describe("sealed content in the browser", { skip: !built && "run `npm run build` first" }, async () => {
  const browser = await browserOrNull();
  const skip = browser ? false : "no browser installed (npx playwright install chromium)";
  let server: http.Server | null = null;
  let url = "";

  before(async () => {
    if (!browser) return;
    const identity = await X25519Identity.generate(nodeAgeCrypto);
    const to = await identity.recipient(nodeAgeCrypto);
    const seal = async (text: string) => armor(await encrypt(utf8(text), [to], nodeAgeCrypto)).trim();
    const source = [
      "---",
      "date: 2026-10-01",
      "gate_code: |",
      ...(await seal(SECRET_FIELD)).split("\n").map((l) => `  ${l}`),
      "---",
      "# Alarm",
      "",
      "Fitted the new alarm panel.",
      "",
      "```sealed",
      await seal(SECRET_BLOCK),
      "```",
      "",
      "[spare key](../files/spare-key.txt.age)",
      "",
    ].join("\n");

    const out = await build({
      entryPoints: [path.resolve("test/fixtures/unseal-page.tsx")],
      bundle: true,
      platform: "browser",
      format: "esm",
      target: "es2022",
      jsx: "automatic",
      write: false,
      define: { "process.env.NODE_ENV": '"production"' },
      logLevel: "silent",
    });
    const files: Record<string, [string, string | Uint8Array]> = {
      "/": ["text/html", `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sealed</title><link rel="stylesheet" href="style.css"><script type="module" src="app.js"></script></head><body><div id="root"></div></body></html>`],
      "/app.js": ["text/javascript", out.outputFiles[0].text],
      "/style.css": ["text/css", fs.readFileSync(STYLE, "utf8")],
      "/fixture.json": ["application/json", JSON.stringify({ source, identity: identity.toString() })],
      "/files/spare-key.txt.age": ["application/octet-stream", await encrypt(utf8(SECRET_FILE), [to], nodeAgeCrypto)],
    };
    server = http.createServer((req, res) => {
      const hit = files[new URL(req.url ?? "/", "http://x").pathname];
      if (!hit) return void res.writeHead(404).end();
      res.writeHead(200, { "Content-Type": hit[0] }).end(hit[1]);
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  });

  after(() => {
    server?.close();
    void browser?.close();
  });

  const open = async (mode: string, scheme: "light" | "dark" = "light") => {
    const context = await browser!.newContext({ colorScheme: scheme });
    const page = await context.newPage();
    await page.goto(`${url}?mode=${mode}`, { waitUntil: "networkidle" });
    await page.getByText("Fitted the new alarm panel.").waitFor();
    return { context, page };
  };

  it("without an unsealer, shows the placeholder exactly as before", { skip }, async () => {
    const { context, page } = await open("none");
    const text = await page.locator("#main").innerText();
    assert.match(text, /\[sealed\] Only someone with one of this Roll's keys can read this\./);
    assert.equal(await page.getByRole("button", { name: /unlock/i }).count(), 0, "nothing to unlock with");
    assert.doesNotMatch(text, /2716|4417/);
    await context.close();
  });

  it("locked, offers Unlock; unlocked, shows the block, the field and the file, marked as sealed", { skip }, async () => {
    const { context, page } = await open("locked");
    assert.doesNotMatch(await page.locator("#main").innerText(), /2716|4417/, "nothing is opened while locked");
    const unlock = page.getByRole("button", { name: "Unlock", exact: true });
    assert.ok((await unlock.count()) >= 2, "the block and the field each offer to unlock");
    await unlock.first().click();

    const opened = page.getByRole("region", { name: /Sealed content/ });
    await opened.waitFor();
    assert.equal(await opened.locator("strong", { hasText: "2716" }).count(), 1, "the block is rendered as Markdown");
    assert.match(await opened.innerText(), /Sealed/, "and marked as sealed");
    await page.getByText(SECRET_FIELD, { exact: true }).waitFor();

    // A sealed file opens decrypted, from a blob: URL.
    const [popup] = await Promise.all([page.waitForEvent("popup"), page.getByRole("button", { name: "Open spare-key.txt" }).click()]);
    await popup.waitForLoadState();
    assert.match(popup.url(), /^blob:/);
    assert.match(await popup.locator("body").innerText(), /blue pot/);
    await context.close();
  });

  it("has no automatically detectable WCAG 2.1 AA violation, locked or unlocked, in light and dark", { skip }, async () => {
    const { AxeBuilder } = await import("@axe-core/playwright");
    for (const scheme of ["light", "dark"] as const) {
      for (const mode of ["locked", "unlocked"]) {
        const { context, page } = await open(mode, scheme);
        if (mode === "unlocked") await page.getByRole("region", { name: /Sealed content/ }).waitFor();
        const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
        const described = violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.length} element(s)`).join("; ");
        assert.equal(violations.length, 0, `${mode} in ${scheme} mode: ${described}`);
        await context.close();
      }
    }
  });
});
