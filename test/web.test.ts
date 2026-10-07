// The browser app, driven in a real browser.
//
// Two things are checked here that nothing else can check: that the interface
// still works end to end, and that axe finds no WCAG 2.1 AA violation on any
// view, in both themes. Automated checks catch a minority of accessibility
// problems — they say nothing about whether the app can actually be used with a
// screen reader — so this is a floor that must not drop, not a claim that the
// app is accessible. Accessibility that isn't measured stops being true; the
// part a machine can measure is measured here.
//
// On a fresh clone with no browser installed these skip, so `npm test` works
// before `npx playwright install chromium` has been run. In CI they must not:
// GITROLL_REQUIRE_BROWSER=1 turns a missing browser, or an app that wasn't
// built, into a failure. A regression test that silently doesn't run is worse
// than no test at all, because it is still counted as passing.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { gitEnv, tmp } from "./helpers.ts";
import { GitRoll } from "../src/node/repo.ts";
import { serve } from "../src/node/server.ts";
import { addRoll } from "../src/node/user-config.ts";
import { isoDate } from "../src/core/util.ts";

const WEB_DIR = path.resolve("dist/web");
const built = fs.existsSync(path.join(WEB_DIR, "app.js"));
/** CI sets this: here, a browser that isn't installed is a broken job, not a skip. */
const required = !!process.env.GITROLL_REQUIRE_BROWSER;

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

// A failing assertion, not a thrown module-level error: a suite that dies while
// it is being built still exits 0, which is the very thing this guards against.
it("has a built app and a browser to drive it", { skip: !required && "only required in CI (GITROLL_REQUIRE_BROWSER=1)" }, async () => {
  assert.ok(built, "dist/web/app.js is missing: run `npm run build` before the browser tests");
  const browser = await browserOrNull();
  assert.ok(browser, "no browser could be launched: run `npx playwright install --with-deps chromium`");
  await browser.close();
});

describe("the browser app", { skip: !built && "run `npm run build` first" }, async () => {
  const browser = await browserOrNull();
  let server: Awaited<ReturnType<typeof serve>> | null = null;
  let url = "";
  let rollRoot = "";

  before(async () => {
    if (!browser) return;
    const root = path.join(tmp(), "Roll");
    rollRoot = root;
    fs.mkdirSync(root, { recursive: true });
    Object.assign(process.env, gitEnv);
    const roll = GitRoll.init(root, { name: "Test Roll" });
    roll.save({ text: "Replaced the **tap**.\n\n- washer\n- cartridge\n\n#plumbing", projects: ["kitchen"] }, []);
    roll.save({ text: "Paid the plumber.", amount: { value: 240, currency: "USD" } }, []);
    // Notes, a collection, an inventory item, a dated to-do and a file on its
    // own: what the pages beside the timeline are made from.
    const soon = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    const write = (rel: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    };
    write(".gitroll/notes/wi-fi.md", "# Wi-Fi\n\nNetwork: maple. Router in the hall closet.\n");
    // A reminder already due, so the Due now state is on the page axe checks.
    const yesterday = isoDate(new Date(Date.now() - 86400000));
    write(".gitroll/notes/todo.md", `# To do\n\n- [ ] Renew passport 📅 ${soon}\n- [ ] Call the roofer\n- [ ] Water the plants ⏰ ${yesterday} 08:00\n`);
    write(".gitroll/notes/books/dune.md", "---\nauthor: Frank Herbert\nrating: 5\n---\n# Dune\n");
    write(".gitroll/notes/books/emma.md", "---\nauthor: Jane Austen\nrating: 3\n---\n# Emma\n");
    write(".gitroll/notes/inventory/heat-pump.md", `---\nbrand: Daikin\nprice: 1899\npriceCurrency: USD\nwarranty: ${soon}\n---\n# Garage heat pump\n`);
    write(".gitroll/notes/people/ada-lovelace.md", "---\nemail: ada@example.com\ntel: +44 20 7946 0000\norg: Analytical Engines\n---\n# Ada Lovelace\n");
    write(".gitroll/notes/people/grace-hopper.md", "---\nemail: grace@example.com\n---\n# Grace Hopper\n");
    // An organization Ada belongs to by name, and places that nest, with a thing and an event in one.
    write(".gitroll/notes/organizations/analytical-engines.md", "---\nurl: https://engines.example\ntelephone: +44 20 7946 0001\n---\n# Analytical Engines\n");
    write(".gitroll/notes/places/house.md", "---\naddress: 12 Main St, Springfield\nlatitude: 51.5014\nlongitude: -0.1419\n---\n# House\n");
    write(".gitroll/notes/places/garage.md", '---\nwithin: "[House](house.md)"\n---\n# Garage\n');
    write(".gitroll/notes/inventory/mower.md", '---\nlocation: "[Garage](../places/garage.md)"\n---\n# Lawn mower\n');
    write(".gitroll/events/2026/2026-09-02-mower.md", "# Sharpened the mower blade\n\nIn the [garage](../../notes/places/garage.md).\n");
    // Two open issues, one with an event that links to it, for Issues.
    write(".gitroll/events/2026/2026-08-10-clunk.md", "---\nissue: open\n---\n# Clunk from the front wheel\n");
    write(".gitroll/events/2026/2026-08-12-garage.md", "# Took the car in\n\nAbout the [clunk](2026-08-10-clunk.md).\n");
    write(".gitroll/events/2026/2026-08-01-squeak.md", "---\nissue: true\n---\n# Squeaky stair\n");
    write(".gitroll/files/manual.pdf", "%PDF-1.4\n");
    // Readings of one number over time, for Series.
    write(".gitroll/notes/car-january.md", "---\ndate: 2026-01-05\nodometer: 47210\n---\n# Tyres\n");
    write(".gitroll/notes/car-march.md", "---\ndate: 2026-03-02\nodometer: 48500\n---\n# Fuel in March\n");
    write(".gitroll/notes/car-march-late.md", "---\ndate: 2026-03-30\nodometer: 48900\n---\n# Oil change\n");
    write(".gitroll/notes/car-guess.md", "---\ndate: 2026-04-01\nodometer: lots\n---\n# A guess\n");
    write(".gitroll/files/manual.pdf.md", "---\ntitle: Heat pump manual\n---\n");
    execFileSync("git", ["add", "-A"], { cwd: root, env: { ...process.env, ...gitEnv } });
    execFileSync("git", ["commit", "-qm", "notes"], { cwd: root, env: { ...process.env, ...gitEnv } });
    // A second Roll on this computer, for All Rolls.
    const cabin = GitRoll.init(path.join(tmp(), "Cabin"), { name: "Cabin" });
    cabin.save({ text: "Called the plumber about the cabin's pipes." }, []);
    addRoll("cabin", cabin.root);
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

  it("offers everyday starting points beside the developer ones", { skip }, async () => {
    const page = await browser!.newPage();
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForSelector("#main");
    await page.getByRole("button", { name: /What happened/i }).click();
    await page.waitForTimeout(200);
    await page.getByRole("button", { name: /Start from a template/i }).click();
    await page.waitForTimeout(300);

    await assertVisible(page, "For work in a repository");
    await assertVisible(page, "For everything else");
    await assertVisible(page, "Household maintenance");

    // Picking one fills the box with its headings, and nothing is saved yet.
    await page.getByRole("button", { name: /Journal/ }).first().click();
    await page.waitForTimeout(300);
    const written = await page.locator("textarea").first().inputValue();
    assert.match(written, /^# /, "the template's heading is there, with no {{title}} left in it");
    assert.doesNotMatch(written, /\{\{title\}\}/);
    await page.close();
  });

  it("offers a Roll's own templates, and only the built-ins that Roll keeps", { skip }, async () => {
    const root = path.join(tmp(), "Maple");
    fs.mkdirSync(root, { recursive: true });
    // The Roll first: init refuses to adopt a .gitroll folder it didn't make.
    const own = GitRoll.init(root, { name: "Maple Street" });
    fs.mkdirSync(path.join(root, ".gitroll/templates"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".gitroll/templates/rental-inspection.md"),
      "---\nlabel: Rental inspection\ndescription: What you checked, what needs fixing.\ntags: [inspection]\n---\n\n# {{title}}\n\n## Checked\n",
    );
    fs.appendFileSync(path.join(root, ".gitroll/config.yaml"), "templates:\n  built_in: [everyday]\n");
    own.save({ text: "Something to look at" }, []);

    const its = await serve(own, { port: 0, webDir: WEB_DIR, token: "test-token" });
    try {
      const page = await browser!.newPage();
      await page.goto(its.url, { waitUntil: "networkidle" });
      await page.waitForSelector("#main");
      await page.getByRole("button", { name: /What happened/i }).click();
      await page.waitForTimeout(200);
      await page.getByRole("button", { name: /Start from a template/i }).click();
      await page.waitForTimeout(300);

      await assertVisible(page, "From this Roll");
      await assertVisible(page, "Rental inspection");
      await assertVisible(page, "For everything else");
      const menu = await page.locator('[data-radix-popper-content-wrapper]').first().innerText();
      assert.doesNotMatch(menu, /For work in a repository/, "a Roll that keeps only the everyday ones is offered only those");
      assert.doesNotMatch(menu, /Debugging session/);

      // Choosing the Roll's own fills the box with what that file says.
      await page.getByRole("button", { name: /Rental inspection/ }).first().click();
      await page.waitForTimeout(300);
      assert.match(await page.locator("textarea").first().inputValue(), /## Checked/);
      await page.close();
    } finally {
      its.server.close();
    }
  });

  it("shows the buttons a Roll asked for, and a filter of its own works", { skip }, async () => {
    const root = path.join(tmp(), "Rental");
    fs.mkdirSync(root, { recursive: true });
    const own = GitRoll.init(root, { name: "Maple Street rental" });
    fs.appendFileSync(path.join(root, ".gitroll/config.yaml"), "filters:\n  - today\n  - label: Unpaid\n    query: tag:unpaid\n");
    own.save({ text: "Boiler service #unpaid" }, []);
    own.save({ text: "Bins out" }, []);

    const its = await serve(own, { port: 0, webDir: WEB_DIR, token: "test-token" });
    try {
      const page = await browser!.newPage();
      await page.goto(its.url, { waitUntil: "networkidle" });
      await page.waitForSelector("#main");
      await page.waitForTimeout(300);

      // The Roll's own buttons, not where to search or the searches saved on this computer.
      const chips = page.locator("button[aria-pressed]:not([role=group] > button)");
      assert.deepEqual(await chips.allInnerTexts(), ["Today", "Unpaid"], "what the Roll asked for, in its order");

      // The Roll's own button is a search like any other.
      await page.getByRole("button", { name: "Unpaid", exact: true }).click();
      await page.waitForTimeout(400);
      assert.equal(await page.locator("#q").inputValue(), "tag:unpaid");
      assert.ok(await page.getByText("Boiler service").count(), "the event it matches is there");
      assert.equal(await page.getByText("Bins out").count(), 0, "and the one it doesn't isn't");

      // Pressing it again puts the query back where it was.
      await page.getByRole("button", { name: "Unpaid", exact: true }).click();
      await page.waitForTimeout(400);
      assert.equal(await page.locator("#q").inputValue(), "");
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

  it("shows notes, a collection as a sortable table, and opens a note", { skip }, async () => {
    const page = await browser!.newPage();
    await page.goto(`${url}#/notes`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Notes" }).waitFor();
    await assertVisible(page, "Wi-Fi");
    await page.getByRole("link", { name: /books/ }).click();
    await page.locator("table").waitFor();
    const titles = async () => page.locator("tbody th").allInnerTexts();
    assert.deepEqual(await titles(), ["Dune", "Emma"]);
    await page.getByRole("button", { name: "rating", exact: true }).click();
    assert.deepEqual(await titles(), ["Emma", "Dune"], "sorted by rating, low to high");
    await page.locator("#records-q").fill("rating>=4");
    assert.deepEqual(await titles(), ["Dune"]);
    await page.getByRole("link", { name: "Dune" }).click();
    await page.getByText("A record in").waitFor();
    await page.close();
  });

  it("lists what's coming up, and ticks a to-do off with a commit", { skip }, async () => {
    const page = await browser!.newPage();
    await page.goto(`${url}#/upcoming`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Upcoming" }).waitFor();
    await assertVisible(page, "Renew passport");
    await assertVisible(page, "Garage heat pump");
    // click, not check: the box leaves the list once the commit lands, which can
    // be before check() looks at it again to confirm it changed.
    await page.getByRole("checkbox", { name: "Done: Call the roofer" }).click();
    await page.getByRole("checkbox", { name: "Done: Call the roofer" }).waitFor({ state: "detached" });
    assert.match(execFileSync("git", ["log", "-1", "--format=%s"], { cwd: rollRoot }).toString(), /^done: Call the roofer/);
    assert.match(fs.readFileSync(path.join(rollRoot, ".gitroll/notes/todo.md"), "utf8"), /- \[x\] Call the roofer/);
    await page.close();
  });

  it("shows a due reminder, and notifies only once the person turns it on", { skip }, async () => {
    const root = path.join(tmp(), "Reminders");
    fs.mkdirSync(root, { recursive: true });
    const own = GitRoll.init(root, { name: "Reminders" });
    fs.mkdirSync(path.join(root, ".gitroll/notes"), { recursive: true });
    // One reminder already due, and one two minutes from now (local time, as the browser reads it).
    const pad = (n: number) => String(n).padStart(2, "0");
    const local = (d: Date) => `${isoDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const start = new Date(Math.ceil(Date.now() / 60000) * 60000);
    const soon = new Date(start.getTime() + 2 * 60000);
    fs.writeFileSync(path.join(root, ".gitroll/notes/todo.md"), `# To do\n\n- [ ] Water the plants ⏰ ${local(new Date(start.getTime() - 86400000))}\n- [ ] Take the bread out ⏰ ${local(soon)}\n`);
    own.commitPending();
    const its = await serve(own, { port: 0, webDir: WEB_DIR, token: "test-token" });
    try {
      const page = await browser!.newPage();
      // A stand-in for the browser's Notification, so both answers to the permission request can be tested.
      await page.addInitScript(() => {
        const w = window as any;
        w.__asked = 0;
        w.__answer = "denied";
        w.__told = [];
        w.Notification = class {
          static permission = "default";
          static async requestPermission() {
            w.__asked++;
            w.Notification.permission = w.__answer;
            return w.__answer;
          }
          constructor(title: string) {
            w.__told.push(title);
          }
        };
      });
      await page.clock.install({ time: start });
      await page.goto(`${its.url}#/upcoming`, { waitUntil: "load" });
      await page.getByRole("heading", { name: "Due now" }).waitFor();
      await assertVisible(page, "Water the plants");
      assert.equal(await page.evaluate(() => (window as any).__asked), 0, "permission is never asked for on load");

      const notify = page.getByRole("button", { name: "Notify me" });
      await notify.click();
      await page.getByText("isn't allowing notifications").waitFor();
      assert.equal(await notify.getAttribute("aria-pressed"), "false", "refused, it stays off");

      await page.evaluate(() => ((window as any).__answer = "granted"));
      await notify.click();
      await page.getByRole("button", { name: "Notifications on" }).waitFor();
      assert.deepEqual(await page.evaluate(() => (window as any).__told), [], "one already due is on the page, not notified again");

      await page.clock.fastForward("03:00");
      await page.waitForFunction(() => (window as any).__told.length > 0);
      assert.deepEqual(await page.evaluate(() => (window as any).__told), ["Take the bread out"]);
      await page.close();
    } finally {
      its.server.close();
    }
  });

  it("shows the ledger, the inventory and the files", { skip }, async () => {
    const page = await browser!.newPage();
    await page.goto(`${url}#/ledger`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Ledger" }).waitFor();
    assert.match(await page.locator("main").innerText(), /2,139\.00 USD/, "240 + 1899, per currency");
    await page.goto(`${url}#/inventory`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Inventory" }).waitFor();
    await assertVisible(page, "Warranties ending in the next 90 days");
    await page.goto(`${url}#/files`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Files" }).waitFor();
    await assertVisible(page, "Heat pump manual");
    await assertVisible(page, "Unfiled: nothing links to it yet.");
    await page.close();
  });

  it("draws a number field over time, from the More menu, with a table of the same points", { skip }, async () => {
    const page = await browser!.newPage();
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForSelector("#main");
    await page.getByRole("button", { name: "More" }).click();
    await page.getByRole("link", { name: "Series" }).click();
    await page.getByRole("heading", { name: "Series" }).waitFor();
    assert.equal(await page.locator("#series-field").inputValue(), "odometer", "the numeric field found across notes");
    assert.ok(await page.locator('svg[role="img"] title').count(), "the chart has a text alternative");
    assert.match((await page.locator('svg[role="img"] title').textContent()) ?? "", /47,210 on 2026-01-05 to 48,900 on 2026-03-30/);
    assert.deepEqual(await page.locator("tbody th").allInnerTexts(), ["Oil change", "Fuel in March", "Tyres"], "newest first");
    assert.match(await page.locator("main").innerText(), /\+1,690/, "the change from first to last");
    await assertVisible(page, "1 document with odometer left out: 1 not a number");
    await page.getByRole("button", { name: "By month" }).click();
    assert.deepEqual(await page.locator("tbody td:first-child").allInnerTexts(), ["2026-03", "2026-01"]);
    await assertVisible(page, "(last of 2)");
    await page.locator("#series-q").fill("oil");
    assert.deepEqual(await page.locator("tbody th").allInnerTexts(), ["Oil change"], "filtered with the same queries as search");
    await page.close();
  });

  it("lists contacts from notes/people/, filters them, and opens a person's record", { skip }, async () => {
    const page = await browser!.newPage();
    await page.goto(url, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "More" }).click();
    await page.getByRole("link", { name: "Contacts" }).click();
    await page.getByRole("heading", { name: "Contacts" }).waitFor();
    await assertVisible(page, "ada@example.com");
    assert.equal(await page.getByRole("link", { name: "+44 20 7946 0000" }).getAttribute("href"), "tel:+442079460000");
    await page.getByLabel("Filter").fill("grace");
    await page.getByText("1 person").waitFor();
    assert.equal(await page.getByText("ada@example.com").count(), 0, "filtered out");
    await page.getByRole("link", { name: "Grace Hopper" }).click();
    await page.waitForURL(/#\/entry\//);
    await page.getByRole("heading", { name: "Grace Hopper" }).waitFor();
    await page.close();
  });

  it("lists organizations with their people, from the More menu", { skip }, async () => {
    const page = await browser!.newPage();
    await page.goto(url, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "More" }).click();
    await page.getByRole("link", { name: "Organizations" }).click();
    await page.getByRole("heading", { name: "Organizations" }).waitFor();
    assert.equal(await page.getByRole("link", { name: "engines.example" }).getAttribute("href"), "https://engines.example");
    assert.equal(await page.getByRole("link", { name: "+44 20 7946 0001" }).getAttribute("href"), "tel:+442079460001");
    await page.getByRole("link", { name: "Ada Lovelace" }).click();
    await page.waitForURL(/#\/entry\//);
    await page.getByRole("heading", { name: "Ada Lovelace" }).waitFor();
    await page.close();
  });

  it("shows places as a tree, with what's there, the events there and a geo: link", { skip }, async () => {
    const page = await browser!.newPage();
    await page.goto(url, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "More" }).click();
    await page.getByRole("link", { name: "Places" }).click();
    await page.getByRole("heading", { name: "Places", level: 1 }).waitFor();
    assert.equal(await page.getByRole("link", { name: /51\.5014, -0\.1419/ }).getAttribute("href"), "geo:51.5014,-0.1419");
    const within = page.getByRole("list", { name: "Within House" });
    await within.getByRole("heading", { name: "Garage" }).waitFor();
    assert.equal(await within.getByRole("link", { name: "Lawn mower" }).count(), 1, "the thing whose location is the garage");
    assert.equal(await within.getByRole("link", { name: "Sharpened the mower blade" }).count(), 1, "the event that links to it");
    await page.getByLabel("Filter").fill("garage");
    await page.getByText("1 place", { exact: true }).waitFor();
    await assertVisible(page, "in House");
    await page.close();
  });

  it("pins an event to the top of the timeline from its page, and unpins it", { skip }, async () => {
    const rel = ".gitroll/events/2026/2026-09-02-mower.md";
    const file = path.join(rollRoot, rel);
    const page = await browser!.newPage();
    await page.goto(`${url}#/entry/${encodeURIComponent(rel)}`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Sharpened the mower blade" }).waitFor();
    await page.getByRole("button", { name: "Pin", exact: true }).click();
    await page.getByRole("button", { name: "Unpin", exact: true }).waitFor();
    assert.match(fs.readFileSync(file, "utf8"), /^pinned: true$/m, "one key in its front matter");
    assert.ok(fs.existsSync(file), "the file keeps its name");
    assert.match(lastCommit(), /^pin: Sharpened the mower blade/);

    await page.goto(url, { waitUntil: "networkidle" });
    const pinned = page.getByRole("region", { name: "Pinned" });
    await pinned.waitFor();
    assert.equal((await page.locator("h2").first().innerText()).toLowerCase(), "pinned", "the first section");
    assert.equal(await pinned.locator("article", { hasText: "Sharpened the mower blade" }).count(), 1);
    assert.equal(await page.locator("article", { hasText: "Sharpened the mower blade" }).count(), 1, "not repeated on its day");
    assert.equal(await page.getByRole("region", { name: "Pinned" }).count(), 1);

    await page.goto(`${url}#/entry/${encodeURIComponent(rel)}`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Unpin", exact: true }).click();
    await page.getByRole("button", { name: "Pin", exact: true }).waitFor();
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), /pinned/);
    assert.match(lastCommit(), /^unpin: Sharpened the mower blade/);
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForSelector("article");
    assert.equal(await page.getByRole("region", { name: "Pinned" }).count(), 0);
    await page.close();
  });

  it("lists open issues under More, and resolves one with a note", { skip }, async () => {
    const page = await browser!.newPage();
    await page.goto(url, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "More" }).click();
    await page.getByRole("link", { name: "Issues" }).click();
    await page.getByRole("heading", { name: "Issues", level: 1 }).waitFor();
    await page.getByText("2 open issues", { exact: true }).waitFor();
    const clunk = page.getByRole("row", { name: /Clunk from the front wheel/ });
    assert.match(await clunk.innerText(), /1 event, last/);
    await clunk.getByRole("button", { name: "Resolve Clunk from the front wheel" }).click();
    await page.getByLabel("What fixed it (optional)").fill("New sway bar link");
    await page.getByRole("dialog").getByRole("button", { name: "Resolve" }).click();
    await page.getByText("1 open issue, 1 resolved", { exact: true }).waitFor();
    assert.equal(await page.getByRole("row", { name: /Clunk from the front wheel/ }).count(), 0, "resolved ones are left out");
    assert.match(lastCommit(), /^close: Clunk from the front wheel/);
    const written = fs.readdirSync(path.join(rollRoot, ".gitroll/events")).find((f) => /resolved-clunk-from-the-front-wheel\.md$/.test(f))!;
    const text = fs.readFileSync(path.join(rollRoot, ".gitroll/events", written), "utf8");
    assert.match(text, /^resolves: "?\[Clunk from the front wheel\]\(2026\/2026-08-10-clunk\.md\)"?$/m);
    assert.match(text, /New sway bar link/);
    assert.doesNotMatch(fs.readFileSync(path.join(rollRoot, ".gitroll/events/2026/2026-08-10-clunk.md"), "utf8"), /resolved/, "the issue itself isn't changed");

    await page.getByLabel("Show resolved issues").check();
    const resolved = page.getByRole("row", { name: /Clunk from the front wheel/ });
    await resolved.waitFor();
    assert.match(await resolved.innerText(), /Resolved .* by Resolved: Clunk from the front wheel/);
    await resolved.getByRole("link", { name: "Clunk from the front wheel", exact: true }).click();
    await page.getByText("Resolved issue").waitFor();
    assert.equal(await page.getByRole("button", { name: "Resolve issue" }).count(), 0);
    await page.close();
  });

  const lastCommit = () => execFileSync("git", ["log", "-1", "--format=%s"], { cwd: rollRoot }).toString();

  it("writes a note and a record, and opens each", { skip }, async () => {
    const page = await browser!.newPage();
    await page.goto(`${url}#/notes`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Notes" }).waitFor();
    await page.getByRole("button", { name: "New note" }).click();
    await page.getByLabel("Title").fill("Bin day");
    await page.getByLabel("Text").fill("Bins go out **Tuesday** night.");
    await page.getByRole("button", { name: "Save note" }).click();
    await page.getByText("A note, kept up to date rather than logged").waitFor();
    assert.match(await page.evaluate(() => location.hash), /^#\/entry\/.*bin-day\.md$/, "the new note is open");
    assert.equal(await page.locator("strong", { hasText: "Tuesday" }).count(), 1);
    assert.match(fs.readFileSync(path.join(rollRoot, ".gitroll/notes/bin-day.md"), "utf8"), /^# Bin day\n\nBins go out \*\*Tuesday\*\* night\./m);
    assert.match(lastCommit(), /^note: Bin day/);

    await page.goto(`${url}#/records/books`, { waitUntil: "networkidle" });
    await page.locator("table").waitFor();
    await page.getByRole("button", { name: "New record" }).click();
    await page.getByLabel("Title").fill("Kindred");
    // The collection's own fields are offered; values are YAML, as with --field.
    await page.getByLabel("Value of author").fill("Octavia E. Butler");
    await page.getByLabel("Value of rating").fill("4");
    await page.getByRole("button", { name: "Add a field" }).click();
    await page.getByLabel("Name of field 3").fill("tags");
    await page.getByLabel("Value of tags").fill("[sf, time travel]");
    await page.getByRole("button", { name: "Add record" }).click();
    await page.getByText("A record in").waitFor();
    assert.match(await page.evaluate(() => location.hash), /^#\/entry\/.*books%2Fkindred\.md$/, "the new record is open");
    const kindred = fs.readFileSync(path.join(rollRoot, ".gitroll/notes/books/kindred.md"), "utf8");
    assert.match(kindred, /author: Octavia E\. Butler\nrating: 4\ntags:/);
    assert.match(kindred, /# Kindred/);
    assert.match(lastCommit(), /^add: Kindred/);
    await page.close();
  });

  it("edits a field in place, and refuses to overwrite a file changed since it was read", { skip }, async () => {
    const dune = path.join(rollRoot, ".gitroll/notes/books/dune.md");
    const emma = path.join(rollRoot, ".gitroll/notes/books/emma.md");
    const page = await browser!.newPage();
    await page.goto(`${url}#/records/books`, { waitUntil: "networkidle" });
    await page.locator("table").waitFor();

    // Enter saves, as `gitroll set`.
    await page.getByRole("button", { name: "Edit rating of Dune: 5" }).click();
    assert.equal(await page.getByLabel("rating of Dune", { exact: true }).inputValue(), "5");
    await page.getByLabel("rating of Dune", { exact: true }).fill("4");
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Edit rating of Dune: 4" }).waitFor();
    assert.match(fs.readFileSync(dune, "utf8"), /^rating: 4$/m);
    assert.match(lastCommit(), /^set: Dune/);
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Edit rating of Dune: 4", "focus goes back to the cell");

    // Escape puts it back.
    const before = fs.readFileSync(emma, "utf8");
    await page.getByRole("button", { name: "Edit rating of Emma: 3" }).click();
    await page.getByLabel("rating of Emma", { exact: true }).fill("1");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Edit rating of Emma: 3" }).waitFor();
    assert.equal(fs.readFileSync(emma, "utf8"), before, "nothing written");

    // Empty removes the field.
    await page.getByRole("button", { name: "Edit author of Emma: Jane Austen" }).click();
    await page.getByLabel("author of Emma", { exact: true }).fill("");
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Edit author of Emma:" }).waitFor();
    assert.doesNotMatch(fs.readFileSync(emma, "utf8"), /author/);

    // Changed on disk after the page read it: refused, and the table shows the file.
    await page.getByRole("button", { name: "Edit rating of Emma: 3" }).click();
    await page.getByLabel("rating of Emma", { exact: true }).fill("5");
    fs.writeFileSync(emma, fs.readFileSync(emma, "utf8").replace("rating: 3", "rating: 2"));
    await page.keyboard.press("Enter");
    await page.getByRole("alert").filter({ hasText: "changed on disk" }).waitFor();
    await page.getByRole("button", { name: "Edit rating of Emma: 2" }).waitFor();
    assert.match(fs.readFileSync(emma, "utf8"), /^rating: 2$/m, "the other change was kept, not overwritten");
    execFileSync("git", ["commit", "-qam", "Emma by hand"], { cwd: rollRoot, env: { ...process.env, ...gitEnv } });
    await page.close();
  });

  it("adds a to-do from Upcoming, with a date", { skip }, async () => {
    const soon = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    const page = await browser!.newPage();
    await page.goto(`${url}#/upcoming`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Upcoming" }).waitFor();
    await page.getByLabel("New to-do", { exact: true }).fill("Buy water softener salt");
    await page.getByLabel("Due (optional)").fill(soon);
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await page.getByRole("checkbox", { name: "Done: Buy water softener salt" }).first().waitFor();
    assert.equal(await page.getByLabel("New to-do", { exact: true }).inputValue(), "", "the box is ready for the next one");
    assert.match(fs.readFileSync(path.join(rollRoot, ".gitroll/notes/todo.md"), "utf8"), new RegExp(`- \\[ \\] Buy water softener salt 📅 ${soon}\\n$`));
    assert.match(lastCommit(), /^todo: Buy water softener salt/);
    await page.close();
  });

  it("saves the search in the box under a name, runs it with one click, renames and deletes it", { skip }, async () => {
    const settings = () => JSON.parse(fs.readFileSync(path.join(process.env.GITROLL_HOME!, "config.json"), "utf8")).searches ?? {};
    const page = await browser!.newPage();
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForSelector("#main");
    await page.locator("#q").fill("has:amount");
    await page.locator("#q").press("Enter");
    await page.getByRole("button", { name: "Save search" }).click();
    await page.getByLabel("Name").fill("Money spent");
    await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
    const chip = page.getByRole("group", { name: "Saved searches" }).getByRole("button", { name: "money-spent" });
    await chip.waitFor();
    assert.equal(settings()["money-spent"], "has:amount", "kept where gitroll find --save keeps it");
    assert.equal(await chip.getAttribute("aria-pressed"), "true");
    assert.equal(await page.getByRole("button", { name: "Save search" }).count(), 0, "already saved");

    // One click runs it, another clears it.
    await page.locator("#q").fill("");
    await page.locator("#q").press("Escape"); // close the suggestions that focusing the box opens, which can cover the chips
    await chip.click();
    assert.equal(await page.locator("#q").inputValue(), "has:amount");
    await page.waitForTimeout(300);
    assert.equal(await page.locator("article").count(), 1);
    await chip.click();
    assert.equal(await page.locator("#q").inputValue(), "");

    await page.getByRole("button", { name: "Edit saved" }).click();
    await page.getByRole("button", { name: "Rename money-spent" }).click();
    await page.getByLabel("New name for money-spent").fill("receipts");
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    await page.getByRole("button", { name: "Delete receipts" }).waitFor();
    assert.deepEqual(settings(), { receipts: "has:amount" });
    await page.getByRole("button", { name: "Delete receipts" }).click();
    await page.getByText("No saved searches left.").waitFor();
    assert.deepEqual(settings(), {});
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Undo" }).click();
    await page.getByRole("group", { name: "Saved searches" }).getByRole("button", { name: "receipts" }).waitFor();
    assert.deepEqual(settings(), { receipts: "has:amount" }, "Undo puts it back");
    await page.close();
  });

  it("searches every Roll on this computer and opens a result in its own Roll", { skip }, async () => {
    const page = await browser!.newPage();
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForSelector("#main");
    await page.getByRole("group", { name: "Search in" }).getByRole("button", { name: "All Rolls" }).click();
    await page.getByText("Type a search to look through every Roll on this computer.").waitFor();
    await page.locator("#q").fill("plumber");
    await page.locator("#q").press("Enter");
    const cabin = page.getByRole("region", { name: /Cabin/ });
    await cabin.waitFor();
    assert.equal(await page.getByRole("region", { name: /Test Roll/ }).getByRole("link", { name: "Paid the plumber." }).count(), 1, "this Roll's results link here");
    assert.match(await page.getByRole("status").first().innerText(), /2 results in 2 Rolls/);
    await cabin.getByRole("button", { name: /Called the plumber about the cabin/ }).click();
    await page.waitForURL(/#\/entry\//);
    await page.getByRole("heading", { name: "Called the plumber about the cabin" }).waitFor();
    assert.notEqual(new URL(page.url()).port, new URL(url).port, "opened in Cabin's own app");
    assert.match(await page.getByRole("banner").innerText(), /Cabin/);
    await page.close();
  });

  it("has no automatically detectable WCAG 2.1 AA violation on any view, in light and dark", { skip }, async () => {
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
      ["saved searches", async (p) => {
        await p.locator("#q").fill("tag:plumbing");
        await p.locator("#q").press("Enter");
        await p.getByRole("button", { name: "Save search" }).waitFor();
      }],
      ["saving a search", async (p) => {
        await p.locator("#q").fill("tag:plumbing");
        await p.locator("#q").press("Enter");
        await p.getByRole("button", { name: "Save search" }).click();
        await p.waitForTimeout(300);
      }],
      ["editing saved searches", async (p) => {
        await p.getByRole("button", { name: "Edit saved" }).click();
        await p.getByRole("button", { name: /^Rename / }).first().click();
        await p.waitForTimeout(300);
      }],
      ["all rolls", async (p) => {
        await p.getByRole("button", { name: "All Rolls" }).click();
        await p.locator("#q").fill("plumber");
        await p.locator("#q").press("Enter");
        await p.getByRole("region", { name: /Cabin/ }).waitFor();
      }],
      ["event", async (p) => {
        await p.locator("article a").first().click();
        await p.waitForTimeout(500);
      }],
      ["topics", async (p) => {
        await p.goto(`${url}#/topics`);
        await p.waitForTimeout(400);
      }],
      ...["notes", "records/books", "upcoming", "ledger", "series", "inventory", "contacts", "organizations", "places", "issues", "files"].map((view): [string, (page: any) => Promise<void>] => [
        view,
        async (p) => {
          await p.goto(`${url}#/${view}`);
          await p.waitForSelector("h1");
          await p.waitForTimeout(400);
        },
      ]),
      ["new note", async (p) => {
        await p.goto(`${url}#/notes`);
        await p.getByRole("button", { name: "New note" }).click();
        await p.waitForTimeout(400);
      }],
      ["new record", async (p) => {
        await p.goto(`${url}#/records/books`);
        await p.getByRole("button", { name: "New record" }).click();
        await p.waitForTimeout(400);
      }],
      ["resolving an issue", async (p) => {
        await p.goto(`${url}#/issues`);
        await p.getByRole("button", { name: /^Resolve / }).first().click();
        await p.waitForTimeout(300);
      }],
      ["editing a field", async (p) => {
        await p.goto(`${url}#/records/books`);
        await p.getByRole("button", { name: /^Edit rating of Dune/ }).click();
        await p.waitForTimeout(300);
      }],
      ["more", async (p) => {
        await p.getByRole("button", { name: "More" }).click();
        await p.waitForTimeout(300);
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
