// The browser app, driven in a real browser.
//
// Two things are checked here that nothing else can check: that the interface
// still works end to end, and that it still meets WCAG 2.1 AA. Accessibility
// that isn't measured stops being true, so it is measured.
//
// The whole file skips when no browser is installed, which is the case in CI
// (`npm ci --ignore-scripts` never downloads one) and on a fresh clone. Run
// `npx playwright install chromium` to have these run.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { gitEnv, tmp } from "./helpers.ts";
import { GitRoll } from "../src/node/repo.ts";
import { serve } from "../src/node/server.ts";

const WEB_DIR = path.resolve("dist/web");
const built = fs.existsSync(path.join(WEB_DIR, "app.js"));

async function browserOrNull() {
  try {
    const { chromium } = await import("playwright");
    // An explicit path wins, so a pinned system browser can be used.
    const executablePath = process.env.GITROLL_TEST_CHROMIUM || undefined;
    return await chromium.launch({ executablePath });
  } catch {
    return null;
  }
}

const assertVisible = async (page: any, text: string) =>
  assert.ok(await page.getByText(text, { exact: false }).first().isVisible(), `expected to see: ${text}`);

describe("the browser app", { skip: !built && "run `npm run build` first" }, async () => {
  const browser = await browserOrNull();
  let server: Awaited<ReturnType<typeof serve>> | null = null;
  let url = "";

  before(async () => {
    if (!browser) return;
    const root = path.join(tmp(), "Roll");
    fs.mkdirSync(root, { recursive: true });
    Object.assign(process.env, gitEnv);
    const roll = GitRoll.init(root, { name: "Test Roll" });
    roll.save({ text: "Replaced the **tap**.\n\n- washer\n- cartridge\n\n#plumbing", projects: ["kitchen"] }, []);
    roll.save({ text: "Paid the plumber.", amount: { value: 240, currency: "USD" } }, []);
    server = await serve(roll, { port: 0, webDir: WEB_DIR, token: "test-token" });
    url = server.url;
  });

  after(() => {
    server?.server.close();
    void browser?.close();
  });

  const skip = browser ? false : "no browser installed (npx playwright install chromium)";

  it("renders Markdown, which the old app never did", { skip }, async () => {
    const page = await browser!.newPage();
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForSelector("#main");
    assert.equal(await page.locator("strong", { hasText: "tap" }).count(), 1, "bold text should render");
    assert.equal(await page.locator(".prose-roll li").count(), 2, "list items should render");
    await page.close();
  });

  it("filters from a typed query and from a chip", { skip }, async () => {
    const page = await browser!.newPage();
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForSelector("#main");
    const q = page.locator("#q");
    await q.click();
    await q.fill("has:amount");
    await page.waitForTimeout(300);
    assert.equal(await page.locator("article").count(), 1);
    // A search of several words must survive the round trip through the URL.
    await q.fill("");
    await q.type("replaced the", { delay: 20 });
    await page.waitForTimeout(300);
    assert.equal(await q.inputValue(), "replaced the", "spaces must not be eaten");
    assert.equal(await page.locator("article").count(), 1);
    await page.close();
  });

  it("offers to set Ask up, and says where a model would run", { skip }, async () => {
    const page = await browser!.newPage();
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForSelector("#main");
    await page.getByRole("button", { name: /Ask settings/i }).click();
    await page.waitForTimeout(400);

    // A model on this computer is what it offers first, and it says why.
    await assertVisible(page, "Ollama");
    await assertVisible(page, "on this computer");
    await assertVisible(page, "Your question and the matching events stay on this computer.");

    // Choosing a hosted provider changes what it says is sent.
    await page.getByRole("button", { name: /OpenAI/ }).first().click();
    await page.waitForTimeout(200);
    await assertVisible(page, "api.openai.com");
    await assertVisible(page, "Attachments themselves are never sent");
    // The key is named, never typed in: GitRoll reads it from the environment.
    assert.equal(await page.locator("#ai-key").inputValue(), "OPENAI_API_KEY");
    await page.close();
  });

  it("shows which repository and branch the log is on", { skip }, async () => {
    const page = await browser!.newPage();
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForSelector("#main");
    const branch = page.getByText("This log's branch:", { exact: false });
    assert.equal(await branch.count(), 1);
    assert.match(await page.locator("header").innerText(), /main/, "the branch is in the header");
    await page.close();
  });

  it("logs something with the keyboard alone", { skip }, async () => {
    const page = await browser!.newPage();
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForSelector("#main");
    await page.locator("h2").first().click();
    await page.keyboard.press("n");
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), "TEXTAREA");
    await page.keyboard.type("Logged with the keyboard. #test");
    await page.keyboard.press("Control+Enter");
    await page.waitForTimeout(1200);
    assert.ok(await page.getByText("Logged with the keyboard.").count());
    await page.close();
  });

  it("completes a filter from the suggestion list without a mouse", { skip }, async () => {
    const page = await browser!.newPage();
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForSelector("#main");
    await page.locator("#q").click();
    await page.locator("#q").type("topic:", { delay: 20 });
    await page.waitForTimeout(400);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    assert.equal(await page.locator("#q").inputValue(), "topic:kitchen");
    await page.close();
  });

  it("meets WCAG 2.1 AA on every view, in light and dark", { skip }, async () => {
    const { AxeBuilder } = await import("@axe-core/playwright");
    const views: [string, (page: any) => Promise<void>][] = [
      ["timeline", async () => {}],
      ["composer", async (p) => {
        await p.getByRole("button", { name: /What happened/i }).click();
        await p.waitForTimeout(300);
      }],
      ["suggestions", async (p) => {
        await p.locator("#q").click();
        await p.locator("#q").type("has:", { delay: 20 });
        await p.waitForTimeout(400);
      }],
      ["event", async (p) => {
        await p.locator("article a").first().click();
        await p.waitForTimeout(500);
      }],
      ["topics", async (p) => {
        await p.getByRole("link", { name: "Topics" }).click();
        await p.waitForTimeout(400);
      }],
      ["ask settings", async (p) => {
        await p.getByRole("button", { name: /Ask settings/i }).click();
        await p.waitForTimeout(400);
      }],
    ];

    for (const scheme of ["light", "dark"] as const) {
      for (const [name, prepare] of views) {
        const context = await browser!.newContext({ colorScheme: scheme });
        const page = await context.newPage();
        await page.goto(url, { waitUntil: "networkidle" });
        await page.waitForSelector("#main");
        await prepare(page);
        const { violations } = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
          .analyze();
        const described = violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.length} element(s)`).join("; ");
        assert.equal(violations.length, 0, `${name} in ${scheme} mode: ${described}`);
        await context.close();
      }
    }
  });
});
