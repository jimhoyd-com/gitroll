import "./helpers.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";
import { GitRoll } from "../src/node/repo.ts";
import { serve } from "../src/node/server.ts";
import { tmp } from "./helpers.ts";

let server: http.Server;
let base: string;
let port: number;
let cookie: string;
let repo: GitRoll;
let web: string;

before(async () => {
  repo = GitRoll.init(tmp(), { name: "API Roll" });
  web = tmp();
  fs.writeFileSync(path.join(web, "index.html"), "<!doctype html><title>GitRoll</title>");
  const running = await serve(repo, { port: 0, webDir: web });
  server = running.server;
  const url = new URL(running.url);
  base = url.origin;
  port = Number(url.port);
  const signIn = await fetch(running.url, { redirect: "manual" });
  assert.equal(signIn.status, 303);
  cookie = (signIn.headers.get("set-cookie") ?? "").split(";")[0];
  assert.match(signIn.headers.get("set-cookie") ?? "", /HttpOnly; SameSite=Strict/);
});

after(() => server.close());

async function api(method: string, route: string, body?: unknown, withCookie = true) {
  const res = await fetch(`${base}/api/${route}`, {
    method,
    headers: { "Content-Type": "application/json", ...(withCookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, data: await res.json() };
}

function rawGet(pathname: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: pathname, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    }).on("error", reject);
  });
}

test("log with a photo, read it back, edit it, and see the history", async () => {
  const photo = Buffer.from("\x89PNG fake photo bytes");
  const created = await api("POST", "entries", {
    text: "Landscaper replaced plants #yard",
    tags: ["House"],
    files: [{ name: "after.png", type: "image/png", data: photo.toString("base64") }],
  });
  assert.equal(created.status, 201);
  assert.deepEqual(created.data.notices, []);

  const { data: state } = await api("GET", "state");
  assert.equal(state.info.name, "API Roll");
  const e = state.entries[0];
  assert.deepEqual(e.tags.sort(), ["house", "yard"]);

  const att = await fetch(`${base}/attachments/${e.attachments[0].path.split("/").map(encodeURIComponent).join("/")}`, { headers: { Cookie: cookie } });
  assert.equal(att.status, 200);
  assert.equal(att.headers.get("cache-control"), "no-store", "private files must not stay in the browser cache");
  assert.deepEqual(Buffer.from(await att.arrayBuffer()), photo);

  const edited = await api("PATCH", `entries/${encodeURIComponent(e.path)}`, { text: "Landscaper replaced the front plants #yard" });
  assert.equal(edited.status, 200);
  assert.equal((await api("GET", `entries/${encodeURIComponent(e.path)}/history`)).data.history.length, 2);
});

test("saving warns about sensitive text", async () => {
  const saved = await api("POST", "entries", { text: "Alarm code change. password: hunter22" });
  assert.equal(saved.status, 201);
  assert.match(saved.data.notices.join(" "), /password/);
});

test("bad input gets a clear error and saves nothing", async () => {
  const count = (await api("GET", "state")).data.entries.length;
  const empty = await api("POST", "entries", { text: "   " });
  assert.equal(empty.status, 400);
  assert.match(empty.data.error, /Nothing to log/);
  assert.equal((await api("PATCH", "entries/not-a-real-id", { text: "x" })).status, 404);
  assert.equal((await api("GET", "state")).data.entries.length, count);
});

test("the Roll can't be read without this run's access key", async () => {
  assert.equal((await api("GET", "state", undefined, false)).status, 401);
  assert.equal(await rawGet("/api/state", { Cookie: `gitroll_${port}=wrong-key` }), 401);
  assert.equal(await rawGet("/?key=wrong-key"), 403);
  assert.equal(await rawGet("/theme.css"), 401);
  assert.equal(await rawGet("/"), 200, "the app shell itself holds no data");
});

test("protects against cross-site requests, DNS rebinding, traversal and network exposure", async () => {
  const form = await fetch(`${base}/api/entries`, { method: "POST", headers: { "Content-Type": "text/plain", Cookie: cookie }, body: '{"text":"csrf"}' });
  assert.equal(form.status, 415);
  assert.equal(await rawGet("/api/state", { Host: "evil.example", Cookie: cookie }), 403);
  assert.equal(await rawGet("/..%2f..%2fpackage.json"), 404);
  const page = await fetch(`${base}/`);
  assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/);

  await assert.rejects(serve(repo, { port: 0, host: "0.0.0.0", webDir: web }), /only runs on this computer/);
});

test("sync without a backup reports no-remote", async () => {
  const { status, data } = await api("POST", "sync", {});
  assert.equal(status, 200);
  assert.equal(data.code, "no-remote");
});

test("an earlier version can be restored, and a conflict settled, through the app", async () => {
  const created = await api("POST", "entries", { text: "# Deploy\n\nWent out at 14:00." });
  const entryPath = created.data.entry.path as string;
  await api("PATCH", `entries/${encodeURIComponent(entryPath)}`, { text: "# Deploy\n\nWent out at 14:00. Rolled back." });
  const history = (await api("GET", `entries/${encodeURIComponent(entryPath)}/history`)).data.history as { commit: string }[];

  const restored = await api("POST", `entries/${encodeURIComponent(entryPath)}/restore`, { commit: history[1].commit });
  assert.equal(restored.status, 200);
  assert.match(restored.data.entry.body, /Went out at 14:00\.$/);
  assert.equal((await api("GET", `entries/${encodeURIComponent(entryPath)}/history`)).data.history.length, 3);

  assert.deepEqual((await api("GET", "conflicts")).data.conflicts, []);
  const file = path.join(repo.root, entryPath);
  fs.writeFileSync(
    file,
    `# Deploy\n\nWent out at 14:00.\n\n---\n\n**Sync note (2026-09-16):** this event was changed on another device too. That version said: #conflict\n\n> # Deploy\n>\n> Went out at 15:00.\n`,
  );
  repo.git(["commit", "-qam", "as a sync would leave it"]);

  const conflicts = (await api("GET", "conflicts")).data.conflicts as { entry: { path: string }; mine: string; theirs: string }[];
  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0].theirs, /15:00/);
  const settled = await api("POST", `entries/${encodeURIComponent(entryPath)}/resolve`, { keep: "theirs" });
  assert.match(settled.data.entry.body, /15:00/);
  assert.deepEqual((await api("GET", "conflicts")).data.conflicts, []);
});

test("a deleted entry can be found and put back through the app", async () => {
  // The browser used to be the one place with no way back from a deletion:
  // History showed an entry's versions, but an entry that had left the Roll
  // could only be recovered from the terminal.
  const created = await api("POST", "entries", { text: "# Receipt\n\nDeleted by mistake." });
  const entryPath = created.data.entry.path as string;
  const id = created.data.entry.id as string;
  assert.equal((await api("DELETE", `entries/${encodeURIComponent(entryPath)}`)).status, 200);

  const removed = (await api("GET", "removed")).data.removed as { id: string; title: string; body: string }[];
  const mine = removed.find((r) => r.id === id);
  assert.ok(mine, "the deletion is listed");
  assert.equal(mine.title, "Receipt");
  assert.match(mine.body, /Deleted by mistake/, "enough of it to tell which one it was");

  const back = await api("POST", `removed/${encodeURIComponent(id)}/restore`, {});
  assert.equal(back.status, 200);
  assert.match(back.data.entry.body, /Deleted by mistake/);
  assert.ok(((await api("GET", "state")).data.entries as { id: string }[]).some((e) => e.id === id), "and it is in the timeline again");
  assert.ok(!((await api("GET", "removed")).data.removed as { id: string }[]).some((r) => r.id === id));

  // Asking twice is a mistake with an answer, not a second copy.
  assert.equal((await api("POST", `removed/${encodeURIComponent(id)}/restore`, {})).status, 404);
});

test("backing up for the first time, and filing periods, work from the app", async () => {
  // Both used to be terminal-only: the browser could tell you a Roll wasn't
  // backed up, and not do anything about it.
  const dir = path.join(tmp(), "browser-roll");
  fs.mkdirSync(dir, { recursive: true });
  const own = GitRoll.init(dir, { name: "Browser" });
  own.setStorage({ ...own.store.settings(), mode: "monthly", timezone: "UTC" });
  own.save({ text: "Boiler serviced", date: "2026-02-10" });
  own.save({ text: "Logged this month" });
  const web2 = tmp();
  fs.writeFileSync(path.join(web2, "index.html"), "<!doctype html><title>GitRoll</title>");
  const running = await serve(own, { port: 0, webDir: web2 });
  const signIn = await fetch(running.url, { redirect: "manual" });
  const jar = (signIn.headers.get("set-cookie") ?? "").split(";")[0];
  const at = async (method: string, route: string, body?: unknown) => {
    const r = await fetch(`${new URL(running.url).origin}/api/${route}`, {
      method,
      headers: { "Content-Type": "application/json", Cookie: jar },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, data: await r.json() };
  };

  try {
    // A folder is a backup, and the app can make one: no account, no CLI.
    const destination = path.join(tmp(), "from-the-app.git");
    const backed = await at("POST", "backup", { destination });
    assert.equal(backed.status, 200, JSON.stringify(backed.data));
    assert.equal(backed.data.created, true, "GitRoll made the repository");
    assert.equal(backed.data.sync.ok, true, JSON.stringify(backed.data.sync));
    assert.ok(fs.existsSync(path.join(destination, "HEAD")));
    assert.equal((await at("POST", "backup", { destination })).status, 409, "and only once");

    // Filing periods, with archiving that takes nothing away.
    const listed = await at("GET", "periods");
    const periods = listed.data.periods as { period: string; entries: number; archived: boolean }[];
    assert.deepEqual(periods.map((p) => p.period), ["2026-09", "2026-02"], "newest first");
    assert.equal(periods.find((p) => p.period === "2026-02")!.entries, 1);

    const archived = await at("POST", "periods/2026-02/archive", { compress: true });
    const after = archived.data.periods as { period: string; archived: boolean; compressed: boolean }[];
    assert.equal(after.find((p) => p.period === "2026-02")!.archived, true);
    assert.equal(after.find((p) => p.period === "2026-02")!.compressed, true);
    assert.equal(own.store.entries({ includeArchived: true }).length, 2, "nothing was deleted");
    assert.equal(((await at("GET", "state")).data.entries as unknown[]).length, 1, "and it is out of the timeline");

    const reopened = await at("POST", "periods/2026-02/unarchive", {});
    assert.equal((reopened.data.periods as { period: string; archived: boolean }[]).find((p) => p.period === "2026-02")!.archived, false);
    assert.equal(((await at("GET", "state")).data.entries as unknown[]).length, 2, "and back in it");
  } finally {
    running.server.close();
  }
});

test("naming the Roll from the app names it for the terminal too", async () => {
  const before = (await api("GET", "state")).data.info.name as string;
  const renamed = await api("PATCH", "roll", { name: "The Workshop" });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.data));
  assert.equal(renamed.data.name, "The Workshop");
  // The key is what `--roll` takes in the terminal, so it has to follow.
  assert.equal(renamed.data.key, "the-workshop");
  assert.equal((await api("GET", "state")).data.info.name, "The Workshop");
  assert.notEqual(before, "The Workshop", "and it really changed");
  assert.equal((await api("PATCH", "roll", { name: "   " })).status, 400, "a blank name is refused");
  await api("PATCH", "roll", { name: before });
});

test("a branch switched in another terminal shows up on the next refresh", async () => {
  const before = (await api("GET", "state")).data.info.sync;
  assert.equal(before.branch, "main");

  repo.git(["checkout", "-q", "-b", "experiment"]);
  const after = (await api("GET", "state")).data.info.sync;
  assert.equal(after.branch, "experiment", "the app reads the branch from Git, not from a cache");

  repo.git(["checkout", "-q", "--detach", "HEAD"]);
  const detached = (await api("GET", "state")).data.info.sync;
  assert.equal(detached.blocker, "detached");
  assert.equal(detached.branch, "", "GitRoll never invents a branch it isn't on");
  repo.git(["checkout", "-q", "main"]);
});
