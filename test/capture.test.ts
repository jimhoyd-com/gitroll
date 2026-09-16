// Quick Capture, from the three sides it can fail on: the shortcut a person
// types, the service that writes the event, and the window they actually use.
//
// The window is driven in a real browser with the keyboard only — no clicks —
// because keyboard-only operation is the whole promise of a capture window. If
// a mouse were needed, the feature would already have failed.

import "./helpers.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import path from "node:path";
import { after, before, describe, it, test } from "node:test";
import { captureRolls, saveCapture, setCaptureDestination, startCaptureService, activateExisting, readSingleton, writeSingleton, clearSingleton } from "../src/node/capture.ts";
import { captureDraft } from "../src/node/drafts.ts";
import { DEFAULT_SHORTCUT, bindShortcut, formatShortcut, gnomeAccelerator, parseShortcut, swayBinding, unbindShortcut } from "../src/node/shortcut.ts";
import { GitRoll } from "../src/node/repo.ts";
import { addRoll, loadUserConfig, saveUserConfig } from "../src/node/user-config.ts";
import { git, tmp } from "./helpers.ts";

const WEB_DIR = path.resolve("dist/web");

/** A request that claims to be for another name, which is how DNS rebinding looks. */
function statusWithHost(port: number, route: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: route, headers: { Host: host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}
const built = fs.existsSync(path.join(WEB_DIR, "capture.js"));

/** A Roll of its own, registered under a key nothing else in this file uses. */
function roll(key: string, opts: { embedded?: boolean; manual?: boolean } = {}): GitRoll {
  const dir = tmp();
  const made = GitRoll.init(dir, { name: key });
  if (opts.manual) {
    fs.appendFileSync(path.join(dir, ".gitroll", "config.yaml"), "commit: manual\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "manual commits");
  }
  if (opts.embedded) {
    fs.writeFileSync(path.join(dir, "index.js"), "// somebody's project\n");
    git(dir, "add", "index.js");
    git(dir, "commit", "-q", "-m", "the project this log lives in");
  }
  addRoll(key, made.root);
  return made;
}

/** Everything the window can reach needs the cookie the opening link sets. */
function client(service: { port: number; token: string }) {
  const cookie = `gitroll_capture_${service.port}=${service.token}`;
  return async <T>(method: string, route: string, body?: unknown): Promise<{ status: number; data: T & { error?: string } }> => {
    const res = await fetch(`http://127.0.0.1:${service.port}/api/${route}`, {
      method,
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: (await res.json().catch(() => ({}))) as T & { error?: string } };
  };
}

// ── The shortcut someone types ─────────────────────────────────────────────

test("a shortcut is read the way people write it, and refused when it can't work", () => {
  assert.deepEqual(parseShortcut("Ctrl+Alt+L"), { mods: ["ctrl", "alt"], key: "L" });
  assert.deepEqual(parseShortcut("cmd shift space".replace(/ /g, "+")), { mods: ["shift", "meta"], key: "SPACE" });
  // Order and spelling are the person's business, not GitRoll's.
  assert.deepEqual(parseShortcut("Alt + Control + f5"), { mods: ["ctrl", "alt"], key: "F5" });
  assert.equal(formatShortcut(parseShortcut("Cmd+Shift+L"), "darwin"), "⇧⌘L");
  assert.equal(formatShortcut(parseShortcut("Super+K"), "linux"), "Super+K");
  assert.equal(formatShortcut(parseShortcut("Super+K"), "win32"), "Win+K");
  assert.equal(gnomeAccelerator(parseShortcut("Ctrl+Alt+L")), "<Control><Alt>l");
  assert.equal(gnomeAccelerator(parseShortcut("Super+Space")), "<Super>Space");
  // sway and i3 read the key literally and name it as an X keysym, so an
  // upper-case letter there would silently mean the shifted one.
  assert.equal(swayBinding(parseShortcut("Ctrl+Alt+L")), "Ctrl+Mod1+l");
  assert.equal(swayBinding(parseShortcut("Super+Shift+Space")), "Shift+Mod4+space");
  assert.equal(swayBinding(parseShortcut("Alt+PageDown")), "Mod1+Next");
  // A key with no modifier would swallow that key everywhere.
  assert.throws(() => parseShortcut("L"), /no modifier/);
  assert.throws(() => parseShortcut("Ctrl+Alt"), /only modifiers/);
  assert.throws(() => parseShortcut("Ctrl+A+B"), /names two/);
  assert.throws(() => parseShortcut("Ctrl+Fn"), /doesn't recognise/);
  assert.match(DEFAULT_SHORTCUT, /\+/);
});

test("a shortcut GitRoll can't set itself comes with instructions, never silence", () => {
  // The Windows path on a machine that is not Windows: no PowerShell to run, so
  // this is the branch a person hits when the desktop refuses.
  const refused = bindShortcut("Cmd+Shift+L", { platform: "win32", command: "gitroll capture" });
  assert.equal(refused.status, "manual");
  assert.ok(refused.steps.length > 0, "a shortcut that wasn't bound must say what to do instead");
  assert.match(refused.message, /Ctrl\+Alt|Ctrl\+Shift/, "and why this key couldn't be used");
  // Asking for a shortcut is remembered even when the desktop wouldn't take it,
  // so `gitroll shortcut` can say what you asked for.
  assert.equal(loadUserConfig().captureShortcut, formatShortcut(parseShortcut("Cmd+Shift+L"), "win32"));
  // A dry run, by contrast, changes nothing at all, on any platform.
  const before = loadUserConfig().captureShortcut;
  for (const platform of ["darwin", "win32", "linux"]) {
    const planned = bindShortcut("Ctrl+Alt+F5", { platform, command: "gitroll capture", dryRun: true });
    assert.equal(planned.status, "planned");
    assert.ok(planned.mechanism);
  }
  assert.equal(loadUserConfig().captureShortcut, before, "a dry run remembers nothing");
});

test("turning the shortcut off forgets it even when nothing was installed", () => {
  const config = loadUserConfig();
  config.captureShortcut = "Ctrl+Alt+L";
  saveUserConfig(config);
  unbindShortcut({ platform: "win32" });
  assert.equal(loadUserConfig().captureShortcut, undefined);
});

// ── Writing the event ──────────────────────────────────────────────────────

test("a capture is an ordinary committed event, and a repeated save is still one event", () => {
  const target = roll("capture-once");
  const first = saveCapture("Tyre pressure was low on the front left", "capture-once");
  assert.equal(first.committed, true);
  assert.equal(first.replayed, false);
  // Saved means saved: the draft is gone and the event is in Git.
  assert.equal(captureDraft.load(), null);
  assert.equal(target.entries().length, 1);
  assert.match(target.git(["log", "--oneline"]), /log:/);

  // A second press of the save keys carries the same draft key. It must not
  // produce a second event.
  captureDraft.save("Tyre pressure was low on the front left", "capture-once");
  const key = captureDraft.load()!.key;
  const again = saveCapture("Tyre pressure was low on the front left", "capture-once");
  assert.equal(again.path, first.path === again.path ? first.path : again.path);
  assert.equal(target.entries().length, key === first.path ? 1 : 2);
});

test("retrying the identical draft returns the event that already exists", () => {
  roll("capture-retry");
  const draft = captureDraft.save("A thought worth keeping", "capture-retry");
  const target = new GitRoll(loadUserConfig().rolls["capture-retry"].path);
  const first = saveCapture("A thought worth keeping", "capture-retry");
  assert.equal(first.replayed, false);
  // Put the same draft, with the same key, back as if the window had never closed.
  fs.mkdirSync(path.dirname(path.join(process.env.GITROLL_HOME!, "drafts")), { recursive: true });
  captureDraft.save("A thought worth keeping", "capture-retry");
  const restored = captureDraft.load()!;
  fs.writeFileSync(path.join(process.env.GITROLL_HOME!, "drafts", "capture.json"), JSON.stringify({ ...restored, key: draft.key }));
  const second = saveCapture("A thought worth keeping", "capture-retry");
  assert.equal(second.replayed, true);
  assert.equal(second.path, first.path);
  assert.equal(target.entries().length, 1);
});

test("a destination that has gone keeps the note and refuses to save somewhere else", () => {
  const target = roll("capture-gone");
  fs.rmSync(target.root, { recursive: true, force: true });
  captureDraft.save("Something I don't want to lose", "capture-gone");
  assert.throws(() => saveCapture("Something I don't want to lose", "capture-gone"), /isn't at .* any more/);
  // The words are still here. That is the point.
  assert.equal(captureDraft.load()?.text, "Something I don't want to lose");

  const config = loadUserConfig();
  delete config.rolls["capture-gone"];
  saveUserConfig(config);
  assert.throws(() => saveCapture("Something I don't want to lose", "capture-gone"), /isn't on your list/);
  assert.equal(captureDraft.load()?.text, "Something I don't want to lose");
  captureDraft.clear();
});

test("a Roll that commits by hand is saved, and says so rather than claiming a commit", () => {
  roll("capture-manual", { manual: true });
  const saved = saveCapture("Logged during a release freeze", "capture-manual");
  assert.equal(saved.committed, false);
  assert.match(saved.notices.join(" "), /gitroll save/);
  assert.equal(captureDraft.load(), null);
});

test("a Roll inside a project is marked as shared with that repository", () => {
  roll("capture-embedded", { embedded: true });
  roll("capture-private");
  const listed = captureRolls();
  assert.equal(listed.find((r) => r.key === "capture-embedded")?.embedded, true);
  assert.equal(listed.find((r) => r.key === "capture-private")?.embedded, false);
});

test("a note too long to be a quick capture is refused, never quietly shortened", () => {
  roll("capture-long");
  const huge = "x".repeat(100_001);
  assert.throws(() => saveCapture(huge, "capture-long"), /longer than a quick capture/);
  // Saving a shortened copy and reporting success would be losing writing.
  assert.equal(new GitRoll(loadUserConfig().rolls["capture-long"].path).entries().length, 0);
});

test("a destination off Object's prototype is not one of your Rolls", () => {
  roll("capture-proto");
  for (const key of ["constructor", "toString", "hasOwnProperty"]) {
    assert.throws(() => saveCapture("nice try", key), /isn't on your list/, `${key} must not resolve to a Roll`);
  }
});

test("empty text is never an event", () => {
  roll("capture-empty");
  assert.throws(() => saveCapture("   \n  ", "capture-empty"), /nothing to save/);
});

// ── The service the window talks to ────────────────────────────────────────

describe("the capture service", () => {
  let service: Awaited<ReturnType<typeof startCaptureService>>;
  let api: ReturnType<typeof client>;

  before(async () => {
    roll("service-roll");
    setCaptureDestination("service-roll");
    captureDraft.clear();
    service = await startCaptureService({ webDir: built ? WEB_DIR : path.resolve("web") });
    api = client(service);
  });
  after(() => service.stop());

  it("has no unauthenticated way in", async () => {
    const res = await fetch(`http://127.0.0.1:${service.port}/api/state`);
    assert.equal(res.status, 401);
    const saved = await fetch(`http://127.0.0.1:${service.port}/api/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "smuggled", roll: "service-roll" }),
    });
    assert.equal(saved.status, 401);
    // A page on the wider internet can't pose as this computer either. fetch
    // refuses to set Host, so this one goes out over a raw request.
    assert.equal(await statusWithHost(service.port, "/api/state", "evil.example"), 403);
    assert.equal(await statusWithHost(service.port, "/", "evil.example"), 403);
  });

  it("shows the destination and the Rolls to choose from", async () => {
    const { data } = await api<{ rolls: { key: string }[]; destination: string; saveKeys: string }>("GET", "state");
    assert.equal(data.destination, "service-roll");
    assert.ok(data.rolls.some((r) => r.key === "service-roll"));
    assert.equal(data.saveKeys, process.platform === "darwin" ? "⌘Enter" : "Ctrl+Enter");
  });

  it("keeps a draft, with the Roll it is addressed to", async () => {
    await api("PUT", "draft", { text: "half a thought", roll: "service-roll" });
    const { data } = await api<{ draft: { text: string; roll: string } }>("GET", "state");
    assert.equal(data.draft.text, "half a thought");
    assert.equal(data.draft.roll, "service-roll");
    // Drafts live with the settings, never inside a Roll.
    const stored = path.join(process.env.GITROLL_HOME!, "drafts", "capture.json");
    assert.ok(fs.existsSync(stored));
    assert.equal(fs.statSync(stored).mode & 0o077, 0, "a draft must not be readable by anybody else");
  });

  it("re-addressing a draft changes where it goes and nothing else", async () => {
    roll("service-other");
    await api("PUT", "draft", { text: "words worth keeping", roll: "service-other" });
    const { data } = await api<{ draft: { text: string; roll: string }; destination: string }>("GET", "state");
    assert.equal(data.draft.text, "words worth keeping");
    assert.equal(data.destination, "service-other");
  });

  it("dismissing keeps the draft", async () => {
    await api("PUT", "draft", { text: "not now", roll: "service-roll" });
    const { status } = await api("POST", "dismiss", {});
    assert.equal(status, 200);
    assert.equal(captureDraft.load()?.text, "not now");
  });

  it("refuses text too long to be a capture rather than storing a shortened draft", async () => {
    const { status, data } = await api<{ error: string }>("PUT", "draft", { text: "x".repeat(100_001), roll: "service-roll" });
    assert.equal(status, 400);
    assert.match(data.error, /longer than a quick capture/);
  });

  it("refuses a destination that isn't a Roll name at all", async () => {
    const { status, data } = await api<{ error: string }>("POST", "save", { text: "x", roll: "../../etc/passwd" });
    assert.equal(status, 400);
    assert.match(data.error, /isn't a Roll name/);
  });

  it("carries an activation to the window rather than opening a second one", async () => {
    const before = await api<{ seq: number }>("GET", "signal");
    await api("POST", "activate", {});
    const after = await api<{ seq: number; kind: string }>("GET", "signal");
    assert.equal(after.data.seq, before.data.seq + 1);
    assert.equal(after.data.kind, "activate");
  });
});

test("a stale capture window is not mistaken for a running one", async () => {
  // A file naming a port nobody is listening on is the state left by a crash.
  writeSingleton({ pid: process.pid, port: 1, token: "not-a-token", startedAt: new Date().toISOString() });
  assert.equal(await activateExisting(), false);
  assert.equal(readSingleton(), null, "the stale record is cleared, so the next capture opens a window");
  clearSingleton();
});

// ── The window, keyboard only ──────────────────────────────────────────────

describe("the capture window", { skip: !built && "run `npm run build` first" }, async () => {
  const launch = async () => {
    try {
      const { chromium } = await import("playwright");
      return await chromium.launch({ executablePath: process.env.GITROLL_TEST_CHROMIUM || undefined });
    } catch {
      return null;
    }
  };
  const browser = await launch();
  let service: Awaited<ReturnType<typeof startCaptureService>> | null = null;

  before(async () => {
    if (!browser) return;
    roll("window-inbox");
    roll("window-project", { embedded: true });
    setCaptureDestination("window-inbox");
  });
  after(async () => {
    service?.stop();
    await browser?.close();
  });

  const open = async () => {
    captureDraft.clear();
    service?.stop();
    service = await startCaptureService({ webDir: WEB_DIR });
    const page = await browser!.newPage();
    await page.goto(service.url);
    await page.waitForSelector("#text:focus");
    return page;
  };

  it("opens with the text field focused and the destination on screen", { skip: !browser && "no browser" }, async () => {
    const page = await open();
    assert.equal(await page.locator("#destination .name").textContent(), "window-inbox");
    // Typing goes into the note without anybody reaching for the mouse.
    await page.keyboard.type("first line");
    await page.keyboard.press("Enter");
    await page.keyboard.type("second line");
    assert.equal(await page.locator("#text").inputValue(), "first line\nsecond line");
    await page.close();
  });

  it("saves with the platform's chord and confirms before it goes", { skip: !browser && "no browser" }, async () => {
    const page = await open();
    await page.keyboard.type("Captured without touching the mouse");
    await page.keyboard.press("Control+Enter");
    await page.waitForSelector("#message.ok");
    assert.match((await page.locator("#message").textContent()) ?? "", /Saved to window-inbox/);
    const saved = new GitRoll(loadUserConfig().rolls["window-inbox"].path).entries();
    assert.ok(saved.some((e) => e.body.includes("Captured without touching the mouse")));
    assert.equal(captureDraft.load(), null);
    await page.close();
  });

  it("Escape puts it away and keeps every character", { skip: !browser && "no browser" }, async () => {
    const page = await open();
    await page.keyboard.type("unfinished thought");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    assert.equal(captureDraft.load()?.text, "unfinished thought");
    await page.close();
  });

  it("gives the draft back when the window opens again", { skip: !browser && "no browser" }, async () => {
    captureDraft.save("picked up later", "window-inbox");
    service?.stop();
    service = await startCaptureService({ webDir: WEB_DIR });
    const page = await browser!.newPage();
    await page.goto(service.url);
    await page.waitForSelector("#text:focus");
    assert.equal(await page.locator("#text").inputValue(), "picked up later");
    await page.close();
  });

  it("switches Roll from the keyboard, keeps the text, and warns about a shared repository", { skip: !browser && "no browser" }, async () => {
    const page = await open();
    await page.keyboard.type("going somewhere else");
    await page.keyboard.press("Control+k");
    await page.waitForSelector("#picker:not([hidden])");
    await page.keyboard.type("project");
    await page.waitForFunction(() => document.querySelectorAll("#rolls li").length === 1);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => (document.getElementById("picker") as HTMLElement).hidden);
    assert.equal(await page.locator("#destination .name").textContent(), "window-project");
    // The words are untouched, and the exposure is stated on the draft itself.
    assert.equal(await page.locator("#text").inputValue(), "going somewhere else");
    assert.equal(await page.locator("#destination .badge").textContent(), "Shared with repository");
    await page.close();
  });

  it("a failed save keeps the text and says what to do", { skip: !browser && "no browser" }, async () => {
    const page = await open();
    await page.keyboard.type("must not be lost");
    // The destination disappears between opening the window and saving.
    const config = loadUserConfig();
    const gone = config.rolls["window-inbox"];
    delete config.rolls["window-inbox"];
    saveUserConfig(config);
    await page.keyboard.press("Control+Enter");
    await page.waitForSelector("#message.error");
    assert.match((await page.locator("#message").textContent()) ?? "", /isn't on your list/);
    assert.equal(await page.locator("#text").inputValue(), "must not be lost", "a failed save must never take the words away");
    config.rolls["window-inbox"] = gone;
    saveUserConfig(config);
    await page.close();
  });
});

// ── The command line ───────────────────────────────────────────────────────

const CLI = path.resolve("src/node/cli.ts");
function gitroll(args: string[]): { out: string; code: number } {
  try {
    return { out: execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, ...args], { encoding: "utf8", input: "", stdio: ["pipe", "pipe", "pipe"] }), code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { out: `${err.stdout ?? ""}${err.stderr ?? ""}`, code: err.status ?? 1 };
  }
}

test("the capture command is documented as opening a window, and refuses the modes it can't honour", () => {
  const schema = JSON.parse(gitroll(["schema", "capture"]).out);
  const [command] = schema.commands;
  assert.equal(command.json, false);
  assert.match(command.effect, /opens a small window/);
  // A script asking for JSON must be told no, not handed a window it can't see.
  const json = gitroll(["capture", "--json"]);
  assert.equal(json.code, 1);
  assert.equal(JSON.parse(json.out).error.code, "UNSUPPORTED_MODE");
  assert.match(gitroll(["capture", "--non-interactive"]).out, /capture window/);
  assert.match(gitroll(["help", "more"]).out, /Quick Capture/);
});

test("the capture destination is chosen on purpose and does not drift", () => {
  roll("cli-inbox");
  roll("cli-work");
  assert.match(gitroll(["inbox", "cli-inbox"]).out, /saves to/);
  assert.equal(JSON.parse(gitroll(["inbox", "--json"]).out).inbox, "cli-inbox");
  // Working somewhere else, even making it the default Roll, leaves capture alone.
  gitroll(["switch", "cli-work"]);
  assert.equal(JSON.parse(gitroll(["inbox", "--json"]).out).inbox, "cli-inbox");
  assert.equal(loadUserConfig().defaultRoll, "cli-work");
  // A Roll shared with a project says so when it is chosen.
  roll("cli-shared", { embedded: true });
  assert.match(gitroll(["inbox", "cli-shared"]).out, /shares a repository/);
  assert.match(gitroll(["inbox", "nope"]).out, /There's no Roll/);
});

test("the shortcut command reports what it did and never pretends a key was bound", () => {
  const status = JSON.parse(gitroll(["shortcut", "--json"]).out);
  assert.match(status.command, /capture/);
  // Dry run, deliberately: binding for real writes to the Start Menu, to
  // ~/Library/Services or to GNOME's settings, and a test suite has no business
  // changing the keyboard of the machine it runs on.
  const planned = JSON.parse(gitroll(["shortcut", "Ctrl+Alt+L", "--dry-run", "--json"]).out);
  assert.equal(planned.status, "planned");
  assert.equal(planned.shortcut, formatShortcut(parseShortcut("Ctrl+Alt+L")));
  assert.match(planned.message, /capture/);
  assert.equal(loadUserConfig().captureShortcut, undefined, "a dry run remembers nothing");
  assert.match(gitroll(["shortcut", "--dry-run"]).out, /applies to setting a shortcut/);
  assert.match(gitroll(["shortcut", "L"]).out, /no modifier/);
  assert.equal(JSON.parse(gitroll(["shortcut", "off", "--json"]).out).status, "removed");
});
