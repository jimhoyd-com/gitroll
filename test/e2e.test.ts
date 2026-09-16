// End to end: the built app (dist/gitroll.mjs), used the way people use it.
// Two people share a Roll through a Git remote, edit the same entry, use the browser
// app over HTTP, drive the terminal app through a real pseudo-terminal, and export.
import "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { fakeGitHubRepo, tmp } from "./helpers.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const bundle = path.join(root, "dist", "gitroll.mjs");

before(() => {
  execFileSync("npm", ["run", "build"], { cwd: root, stdio: ["ignore", "ignore", "inherit"], shell: process.platform === "win32" });
  assert.ok(fs.existsSync(bundle));
});

interface Person {
  env: NodeJS.ProcessEnv;
  run(args: string[], opts?: { cwd?: string; fail?: boolean }): string;
}

function person(name: string): Person {
  const home = tmp();
  const env = {
    ...process.env,
    GITROLL_HOME: path.join(home, "settings"),
    GITROLL_ROLLS: path.join(home, "rolls"),
    GIT_AUTHOR_NAME: name,
    GIT_COMMITTER_NAME: name,
    GIT_AUTHOR_EMAIL: `${name.toLowerCase()}@example.com`,
    GIT_COMMITTER_EMAIL: `${name.toLowerCase()}@example.com`,
  };
  return {
    env,
    run(args, opts = {}) {
      try {
        const out = execFileSync(process.execPath, [bundle, ...args], { cwd: opts.cwd ?? home, env, encoding: "utf8", input: "", stdio: ["pipe", "pipe", "pipe"] });
        if (opts.fail) assert.fail(`gitroll ${args.join(" ")} should have failed:\n${out}`);
        return out;
      } catch (e) {
        const err = e as { stdout?: string; stderr?: string; status?: number };
        if (err.status === undefined) throw e;
        const out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
        if (!opts.fail) assert.fail(`gitroll ${args.join(" ")} failed (${err.status}):\n${out}`);
        return out;
      }
    },
  };
}

const idOf = (p: Person, query: string, roll: string) => (JSON.parse(p.run(["find", query, "--roll", roll, "--json"])) as { id: string }[])[0].id;

test("two people share a Roll: log, back up, join, edit the same entry, sync, check and export", () => {
  const alice = person("Alice");
  const bob = person("Bob");
  const remote = fakeGitHubRepo();

  assert.match(alice.run(["new", "Family"]), /Created the Roll/);
  const receipt = path.join(tmp(), "plumber receipt.pdf");
  fs.writeFileSync(receipt, "%PDF-1.4 receipt");
  assert.match(alice.run(["log", "Plumber fixed the kitchen sink #plumbing", receipt, "--amount", "$120", "-p", "House", "--roll", "family"]), /Logged/);
  alice.run(["backup", remote, "--roll", "family"]);
  assert.match(alice.run(["sync", "--roll", "family"]), /(Backed up|Synced|up to date)/i);

  assert.match(bob.run(["join", remote, "family"]), /Joined/);
  assert.match(bob.run(["find", "sink", "--roll", "family"]), /Plumber fixed the kitchen sink/);
  bob.run(["log", "Bought a spare faucet washer", "--roll", "family"]);

  // Both change the same entry before syncing.
  const id = idOf(alice, "sink", "family");
  alice.run(["edit", id, "--text", "Plumber fixed the kitchen sink. Warranty 1 year. #plumbing", "--roll", "family"]);
  bob.run(["edit", id, "--tag", "paid", "--roll", "family"]);
  bob.run(["sync", "--roll", "family"]);
  alice.run(["sync", "--roll", "family"]);
  bob.run(["sync", "--roll", "family"]);

  for (const p of [alice, bob]) {
    const found = JSON.parse(p.run(["find", "sink", "--roll", "family", "--json"])) as { body: string; tags: string[]; attachments: { name: string }[] }[];
    assert.equal(found.length, 1, "the shared entry isn't duplicated");
    assert.match(found[0].body, /Warranty 1 year/, "Alice's edit reached both people");
    assert.ok(found[0].tags.includes("paid") || found[0].tags.includes("conflict"), "Bob's edit is kept, merged or marked as a conflict");
    assert.equal(found[0].attachments[0].name, "plumber receipt.pdf");
    assert.match(p.run(["find", "washer", "--roll", "family"]), /spare faucet washer/);
    assert.match(p.run(["check", "--roll", "family"]), /looks good/);
  }

  const out = path.join(tmp(), "family.json");
  alice.run(["export", "--format", "json", "-o", out, "--roll", "family"]);
  assert.equal((JSON.parse(fs.readFileSync(out, "utf8")) as { events: unknown[] }).events.length, 2);

  const plan = alice.run(["uninstall", "--dry-run"]);
  assert.match(plan, /all of your Rolls/);
  assert.ok(fs.existsSync(path.join(alice.env.GITROLL_ROLLS!, "family", ".gitroll", "config.yaml")));
});

test("browser app: signs in with the one-time link, serves the built UI securely, and saves through the API", async () => {
  const carol = person("Carol");
  carol.run(["new", "Web"]);
  const child = spawn(process.execPath, [bundle, "open", "web", "--no-browser", "--port", "0"], { env: carol.env, stdio: ["ignore", "pipe", "pipe"] });
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let seen = "";
      const timer = setTimeout(() => reject(new Error(`No address printed:\n${seen}`)), 15000);
      child.stdout.on("data", (d: Buffer) => {
        seen += d.toString();
        const m = /visit: (http:\/\/\S+)/.exec(seen);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]);
        }
      });
      child.on("exit", (code) => reject(new Error(`gitroll open exited (${code}):\n${seen}`)));
    });
    const { hostname, origin } = new URL(url);
    assert.ok(["127.0.0.1", "localhost"].includes(hostname), "only listens on this computer");

    assert.equal((await fetch(`${origin}/api/state`)).status, 401, "nothing without the access key");
    const signIn = await fetch(url, { redirect: "manual" });
    assert.equal(signIn.status, 303);
    const cookie = (signIn.headers.get("set-cookie") ?? "").split(";")[0];

    const page = await fetch(`${origin}/`, { headers: { cookie } });
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src/);
    assert.match(await page.text(), /<script[^>]+src=/, "serves the built interface");

    const saved = await fetch(`${origin}/api/entries`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ text: "Logged from the browser", projects: ["Garden"] }),
    });
    assert.equal(saved.status, 201);
    const forged = await fetch(`${origin}/api/entries`, { method: "POST", headers: { cookie, "content-type": "text/plain" }, body: JSON.stringify({ text: "forged" }) });
    assert.ok(forged.status >= 400, "form-style cross-site posts are refused");

    const state = (await (await fetch(`${origin}/api/state`, { headers: { cookie } })).json()) as { entries: { body: string }[] };
    assert.ok(state.entries.some((e) => e.body === "Logged from the browser"));
  } finally {
    child.kill();
  }
  assert.match(carol.run(["find", "browser", "--roll", "web"]), /Logged from the browser/);
  assert.doesNotMatch(carol.run(["find", "forged", "--roll", "web"]), /forged/);
});

test("terminal app: typing gitroll in a Roll opens the workspace, and the prompt logs an entry", { skip: process.platform === "win32" || !fs.existsSync("/usr/bin/script") }, async () => {
  const dana = person("Dana");
  dana.run(["new", "Keys"]);
  const dir = path.join(dana.env.GITROLL_ROLLS!, "keys");
  let screen = "";
  // script needs a real pipe on stdin (Node gives children a socket, which macOS script rejects), so keys go through cat.
  const inner = process.platform === "darwin" ? 'exec script -q /dev/null "$0" "$1"' : 'exec script -qefc "\\"$0\\" \\"$1\\"" /dev/null';
  const child = spawn("/bin/sh", ["-c", `cat | ${inner}`, process.execPath, bundle], { cwd: dir, env: { ...dana.env, TERM: "xterm-256color" }, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.on("data", (d: Buffer) => (screen += d.toString()));
  child.stdout.on("data", (d: Buffer) => (screen += d.toString()));
  // macOS script buffers its output until the program exits, so keys are sent on a schedule
  // and the screen is checked afterwards.
  const at = (ms: number, keys: string) => setTimeout(() => child.stdin.write(keys), ms);
  const timers = [at(2000, "Typed in the terminal app"), at(3500, "\r"), at(5000, "\x03"), setTimeout(() => child.stdin.end(), 6000)];
  const exited = await new Promise<number | null>((resolve) => {
    const kill = setTimeout(() => child.kill(), 30000);
    child.on("exit", (code) => {
      clearTimeout(kill);
      resolve(code);
    });
  });
  timers.forEach(clearTimeout);
  assert.equal(exited, 0, screen);
  assert.match(screen, /Nothing logged yet/, "opened on the empty workspace");
  assert.match(screen, /What happened\? Type it here/, "the prompt is always there");
  assert.match(screen, /Logged to entries\//, "saving names the file it wrote");
  assert.match(screen, /\x1b\[\?1049l/, "restores the terminal on exit");
  assert.match(dana.run(["find", "terminal", "--roll", "keys"]), /Typed in the terminal app/);
});
