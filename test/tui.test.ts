import "./helpers.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { GitRoll } from "../src/node/repo.ts";
import { Tui, parsePaths } from "../src/node/tui.ts";
import type { Key } from "../src/node/tui.ts";
import { tmp } from "./helpers.ts";

const plain = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

function app(roll: GitRoll, others: GitRoll[] = []) {
  const tui = new Tui({
    roll,
    rolls: () => [roll, ...others].map((r) => ({ key: r.config().name, name: r.config().name, path: r.root })),
    openRoll: (p) => new GitRoll(p),
    readFile: (p) => ({ name: path.basename(p), type: "image/jpeg", data: fs.readFileSync(p) }),
    openInBrowser: async () => "http://127.0.0.1:1/?key=x",
  });
  const press = async (...keys: (string | Key)[]) => {
    for (const k of keys) await tui.key(typeof k === "string" ? (k.length === 1 ? { ch: k } : { name: k }) : k);
  };
  const type = async (text: string) => {
    for (const ch of text) await tui.key({ ch });
  };
  return { tui, press, type, screen: () => plain(tui.render(100, 30)) };
}

test("full-screen app: log with a project and a dragged file, then find and read it", async () => {
  const roll = GitRoll.init(tmp(), { name: "Home" });
  roll.createProject("Garden");
  roll.save({ text: "Paid the water bill" });
  const photo = path.join(tmp(), "gate photo.jpg");
  fs.writeFileSync(photo, "jpeg");
  const { tui, press, type, screen } = app(roll);

  assert.match(screen(), /GitRoll · Home/);
  assert.match(screen(), /Paid the water bill/);

  await press("n");
  assert.match(screen(), /What happened\?/);
  await type("Fixed the side gate latch");
  await press("return", "right");
  assert.match(screen(), /‹ Garden ›/);
  await press("return");
  await type(photo.replace(/ /g, "\\ "));
  await press("return");
  assert.equal(tui.screen, "timeline");
  assert.match(screen(), /Logged\./);
  assert.match(screen(), /Fixed the side gate latch\s+Garden · 1 file/);

  const saved = roll.entries().find((e) => e.body.includes("latch"))!;
  assert.deepEqual(saved.projects, ["garden"]);
  assert.equal(saved.attachments[0].name, "gate photo.jpg");

  await press("/");
  await type("water");
  assert.doesNotMatch(screen(), /latch/);
  await press("return");
  assert.equal(tui.screen, "entry");
  assert.match(screen(), /Paid the water bill/);
  await press("escape", "escape");
  assert.match(screen(), /latch/, "clearing the search shows everything again");

  await press("q");
  assert.equal(tui.done, true);
});

test("full-screen app: cancel, empty text, delete confirmation and switching Rolls", async () => {
  const home = GitRoll.init(tmp(), { name: "Home" });
  const work = GitRoll.init(tmp(), { name: "Work" });
  work.save({ text: "Quarterly review" });
  home.save({ text: "Keep me" });
  const { tui, press, type, screen } = app(home, [work]);

  await press("n", "escape");
  assert.match(screen(), /Nothing logged\./);
  await press("n", "tab", "tab", "return");
  assert.match(screen(), /Type what happened first\./);
  assert.equal(home.entries().length, 1);
  await press("escape");

  await press("return", "d", "x");
  assert.match(screen(), /Kept it\./);
  assert.equal(home.entries().length, 1);
  await press("d", "y");
  assert.match(screen(), /Deleted\./);
  assert.equal(home.entries().length, 0);
  assert.match(screen(), /Nothing logged yet/);

  await press("s");
  assert.match(screen(), /isn't backed up yet/);

  await press("r", "down", "return");
  assert.match(screen(), /GitRoll · Work/);
  assert.match(screen(), /Quarterly review/);

  await type("o");
  assert.match(screen(), /http:\/\/127\.0\.0\.1/);
  await press({ name: "c", ctrl: true });
  assert.equal(tui.done, true);
});

test("full-screen app stays inside a small window and never prints control characters from entries", async () => {
  const roll = GitRoll.init(tmp(), { name: "Tiny" });
  for (let i = 0; i < 40; i++) roll.save({ text: `Entry ${i} \x1b]0;evil\x07 with a very long line that keeps going and going past the edge` });
  const { tui, press } = app(roll);
  await press(...Array(35).fill("down"));
  const lines = tui.render(40, 12);
  assert.equal(lines.length, 12);
  for (const l of lines) assert.ok([...l.replace(/\x1b\[[0-9;]*m/g, "")].length <= 40, l);
  assert.doesNotMatch(lines.join(""), /\x1b\]|\x07/);
  assert.match(plain(lines), /▸ .*Entry 4\b/, "the selected row scrolls into view");
});

test("dragged paths with spaces or quotes are split correctly", () => {
  assert.deepEqual(parsePaths(`/a/b\\ c.jpg '/d/e f.pdf' "/g h.png" /plain.txt`), ["/a/b c.jpg", "/d/e f.pdf", "/g h.png", "/plain.txt"]);
});
