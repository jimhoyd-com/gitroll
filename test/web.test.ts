// The browser app, driven in a real browser.
//
// Two things are checked here that nothing else can check: that the interface
// still works end to end, and that an automated accessibility scan (axe, WCAG
// 2.1 AA rules) finds nothing. An automated scan supports a narrower claim than
// conformance — it catches what tooling can catch — but accessibility that
// isn't measured stops being true, so it is measured.
//
// Locally the file skips when the app hasn't been built or no browser is
// installed (`npx playwright install chromium`). In CI it must not skip:
// GITROLL_REQUIRE_BROWSER=1 turns a missing build or browser into a failure, so
// these checks can never quietly stop running.

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
const required = process.env.GITROLL_REQUIRE_BROWSER === "1";

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


describe("the browser app", { skip: !built && !required && "run `npm run build` first" }, async () => {
  const browser = await browserOrNull();
  if (required && !built) throw new Error("GITROLL_REQUIRE_BROWSER=1: run `npm run build` before the tests");
  if (required && !browser) throw new Error("GITROLL_REQUIRE_BROWSER=1: install a browser with `npx playwright install chromium`");
  let server: Awaited<ReturnType<typeof serve>> | null = null;
  let url = "";

  before(async () => {
    if (!browser) return;
    const root = path.join(tmp(), "Roll");
    fs.mkdirSync(root, { recursive: true });
    Object.assign(process.env, gitEnv);
    const roll = GitRoll.init(root, { name: "Test Roll" });
    roll.save({ text: "Replaced the **tap**.\n\n- washer\n- cartridge\n\n#plumbing", tags: ["kitchen"] }, []);
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

  it("never lists a tag the text already shows", { skip }, async () => {
    // The tag row under an entry is for tags that live only in the front
    // matter. A #word somebody wrote is already on screen, and already
    // clickable, where they wrote it — printing it again below says the same
    // thing twice and makes the two look like different tags.
    const page = await browser!.newPage();
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForSelector("#main");
    // "Replaced the tap" carries #plumbing in its text and kitchen in front matter.
    await page.getByRole("link", { name: /Replaced the/ }).first().click();
    await page.waitForTimeout(600);
    assert.equal(await page.getByRole("button", { name: "#plumbing" }).count(), 0, "the written tag isn't repeated");
    assert.equal(await page.getByRole("link", { name: "#plumbing" }).count(), 1, "it is still there, where it was written");
    assert.equal(await page.getByRole("button", { name: "#kitchen" }).count(), 1, "a front-matter tag still gets a row");
    await page.close();
  });

  it("puts back something deleted by mistake, without leaving the browser", { skip }, async () => {
    // A Roll of its own: this test deletes something, and the others expect
    // what they logged to still be on the timeline.
    const root = path.join(tmp(), "Regret");
    fs.mkdirSync(root, { recursive: true });
    const roll = GitRoll.init(root, { name: "Regret Roll" });
    roll.save({ text: "The receipt I deleted by mistake\n\nFor the boiler service, filed under the wrong month." }, []);
    const own = await serve(roll, { port: 0, webDir: WEB_DIR, token: "regret-token" });
    try {
      const page = await browser!.newPage();
      await page.goto(own.url, { waitUntil: "networkidle" });
      await page.waitForSelector("#main");

      await page.locator("article a").first().click();
      await page.waitForTimeout(400);
      await page.getByRole("button", { name: "Delete" }).click();
      await page.getByRole("button", { name: /Delete/ }).last().click();
      await page.waitForTimeout(800);
      assert.equal(await page.getByText("The receipt I deleted by mistake").count(), 0, "gone from the timeline");

      // The way back is on the timeline, not only in the toast that just passed.
      await page.getByRole("link", { name: /Deleted something by mistake/ }).click();
      await page.waitForTimeout(600);
      assert.ok(await page.getByText("The receipt I deleted by mistake").count(), "listed under what was removed");
      // The stored file keeps its heading; the row already shows it as the
      // title, so the preview underneath must not print it again with its #.
      assert.equal(await page.getByText("# The receipt").count(), 0, "the title isn't repeated as raw Markdown");
      // The same words as the toast's shortcut, so scope to the page's list.
      await page.getByRole("region", { name: "Removed from this Roll" }).getByRole("button", { name: "Put it back" }).click();
      await page.waitForTimeout(1000);

      await page.goto(own.url, { waitUntil: "networkidle" });
      await page.waitForSelector("#main");
      assert.ok(await page.getByText("The receipt I deleted by mistake").count(), "back on the timeline");
      assert.equal(roll.entries().length, 1);
      await page.close();
    } finally {
      own.server.close();
    }
  });

  it("finds no automated accessibility violations on any view, in light and dark", { skip }, async () => {
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
      ["removed", async (p) => {
        await p.getByRole("link", { name: /Deleted something by mistake/ }).click();
        await p.waitForTimeout(500);
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
