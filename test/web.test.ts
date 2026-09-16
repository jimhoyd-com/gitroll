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
import { execFileSync } from "node:child_process";
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

  it("never uploads on its own: backing up waits to be asked", { skip }, async () => {
    // A Roll of its own, with somewhere to back up to: a bare repository in a
    // folder, which sync treats as a destination it needn't check for privacy.
    const root = path.join(tmp(), "Backed");
    fs.mkdirSync(root, { recursive: true });
    const remote = path.join(tmp(), "remote.git");
    execFileSync("git", ["init", "--bare", "-q", remote], { env: gitEnv });
    const backed = GitRoll.init(root, { name: "Backed Roll" });
    backed.save({ text: "Something worth keeping" }, []);
    backed.git(["remote", "add", "origin", remote]);
    await backed.sync();
    backed.save({ text: "Written after the last backup" }, []);
    const waiting = () => execFileSync("git", ["rev-list", "--count", "origin/main..HEAD"], { cwd: root, encoding: "utf8", env: gitEnv }).trim();
    assert.equal(waiting(), "1");

    const its = await serve(backed, { port: 0, webDir: WEB_DIR, token: "test-token" });
    try {
      const page = await browser!.newPage();
      const uploads: string[] = [];
      page.on("request", (r) => {
        if (r.method() === "POST" && r.url().includes("/api/sync")) uploads.push(r.url());
      });
      await page.goto(its.url, { waitUntil: "networkidle" });
      await page.waitForSelector("#main");
      // Coming back to the window used to be enough to send everything up.
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await page.waitForTimeout(1500);
      assert.deepEqual(uploads, [], "no upload without being asked");
      assert.equal(waiting(), "1", "and nothing left this computer");

      await page.getByRole("button", { name: /change|backed up|back up/i }).first().click();
      await page.getByRole("button", { name: "Back up now" }).click();
      await page.waitForTimeout(2000);
      assert.equal(uploads.length, 1, "asked once, uploaded once");
      assert.equal(waiting(), "0", "and it actually went");
      await page.close();
    } finally {
      its.server.close();
    }
  });

  it("keeps an unsaved draft through a reload, and does not clear it on Log", { skip }, async () => {
    const page = await browser!.newPage();
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForSelector("#main");
    await page.getByRole("button", { name: /What happened/i }).click();
    await page.waitForTimeout(200);
    await page.keyboard.type("Half a thought, not saved yet");

    // The header's Log action used to wipe exactly this.
    await page.getByRole("button", { name: "Log something" }).click();
    await page.waitForTimeout(300);
    assert.match(await page.locator("textarea").first().inputValue(), /Half a thought/, "Log came back to the writing");

    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector("#main");
    await page.waitForTimeout(400);
    assert.match(await page.locator("textarea").first().inputValue(), /Half a thought/, "and a reload kept it");

    // Saving is what clears a draft.
    await page.locator("textarea").first().click();
    await page.keyboard.press("Control+Enter");
    await page.waitForTimeout(1200);
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector("#main");
    await page.waitForTimeout(400);
    const boxes = await page.locator("textarea").count();
    if (boxes) assert.equal(await page.locator("textarea").first().inputValue(), "", "a saved event leaves no draft behind");
    await page.close();
  });

  it("finds a deleted event and puts it back, with its metadata", { skip }, async () => {
    const root = path.join(tmp(), "Recover");
    fs.mkdirSync(root, { recursive: true });
    const roll = GitRoll.init(root, { name: "Recover Roll" });
    roll.save({ text: "Paid for the part", amount: { value: 41.9, currency: "USD" }, projects: ["hvac"], tags: ["receipt"] }, []);
    const gone = roll.entries()[0];
    roll.deleteEntry(gone.path);

    const its = await serve(roll, { port: 0, webDir: WEB_DIR, token: "test-token" });
    try {
      const page = await browser!.newPage();
      await page.goto(`${its.url}#/deleted`, { waitUntil: "networkidle" });
      await page.waitForSelector("#main");
      await page.waitForTimeout(500);
      await assertVisible(page, "Paid for the part");
      await page.getByRole("button", { name: "Put it back" }).first().click();
      await page.waitForTimeout(1200);
      const back = roll.entries().find((e) => e.path === gone.path);
      assert.ok(back, "the event is in the Roll again");
      assert.equal(back!.amount?.value, 41.9, "with the amount it was written with");
      assert.deepEqual(back!.projects, ["hvac"]);
      assert.ok(back!.tags.includes("receipt"));
      await page.close();
    } finally {
      its.server.close();
    }
  });

  it("does not call a Roll backed up while writing sits uncommitted", { skip }, async () => {
    const root = path.join(tmp(), "Handwritten");
    fs.mkdirSync(root, { recursive: true });
    const remote = path.join(tmp(), "handwritten-remote.git");
    execFileSync("git", ["init", "--bare", "-q", remote], { env: gitEnv });
    const roll = GitRoll.init(root, { name: "Handwritten Roll" });
    roll.save({ text: "Logged through the app" }, []);
    roll.git(["remote", "add", "origin", remote]);
    await roll.sync();
    // A handwritten event, the way somebody who likes their own editor writes one.
    fs.writeFileSync(path.join(root, ".gitroll/events/2026-04-01-by-hand.md"), "---\ndate: 2026-04-01\n---\n\n# Written by hand\n");

    const its = await serve(roll, { port: 0, webDir: WEB_DIR, token: "test-token" });
    try {
      const page = await browser!.newPage();
      await page.goto(its.url, { waitUntil: "networkidle" });
      await page.waitForSelector("#main");
      await page.waitForTimeout(400);
      const header = await page.locator("header").innerText();
      assert.doesNotMatch(header, /synced|^backed up$/im, `nothing may claim the Roll is fully backed up: ${JSON.stringify(header)}`);
      assert.match(header, /Not all backed up/i, "and it says so plainly");
      await page.getByRole("button", { name: /not all backed up|change|backed up|back up/i }).first().click();
      await page.waitForTimeout(300);
      await assertVisible(page, "isn't committed, so it won't be in this backup");
      await page.close();
    } finally {
      its.server.close();
    }
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
