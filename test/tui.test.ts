import "./helpers.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { GitRoll } from "../src/node/repo.ts";
import { Tui, matchCommands } from "../src/node/tui/app.ts";
import type { Key } from "../src/node/tui/app.ts";
import type { Draft } from "../src/node/tui/compose.ts";
import { Input, escapePath, parsePaths } from "../src/node/tui/text.ts";
import { git, tmp } from "./helpers.ts";

const plain = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

function app(roll: GitRoll, others: GitRoll[] = []) {
  const state: { drafts: Map<string, Draft>; remembered: string[]; editorText: string | null } = { drafts: new Map(), remembered: [], editorText: null };
  const tui = new Tui({
    roll,
    rolls: () => [roll, ...others].map((r) => ({ key: r.config().name, name: r.config().name, path: r.root })),
    openRoll: (p: string) => new GitRoll(p),
    readFile: (p: string) => ({ name: path.basename(p), type: "image/jpeg", data: fs.readFileSync(p) }),
    openInBrowser: async () => "http://127.0.0.1:1/?key=x",
    rememberRoll: (p: string) => state.remembered.push(p),
    drafts: {
      load: (root: string) => state.drafts.get(root) ?? null,
      save: (root: string, draft: Draft) => void state.drafts.set(root, draft),
      clear: (root: string) => void state.drafts.delete(root),
    },
    editExternally: () => state.editorText,
  });
  const press = async (...keys: (string | Key)[]) => {
    for (const k of keys) await tui.key(typeof k === "string" ? (k.length === 1 ? { ch: k } : { name: k }) : k);
  };
  const type = async (text: string) => {
    for (const ch of text) await tui.key({ ch });
  };
  const ctrl = (name: string) => ({ name, ctrl: true });
  return { tui, press, type, ctrl, state, screen: (w = 100, h = 30) => plain(tui.render(w, h)) };
}

/** Moves to a composer field by its label. */
async function focus(tui: Tui, label: string): Promise<void> {
  for (let i = 0; i < 30; i++) {
    if (tui.composer!.field().label === label) return;
    await tui.key({ name: "tab" });
  }
  throw new Error(`no composer field called ${label}`);
}

test("workspace: the prompt logs an entry, and recent entries sit above it", async () => {
  const roll = GitRoll.init(tmp(), { name: "Home" });
  const { tui, press, type, screen } = app(roll);

  assert.match(screen(), /GitRoll · Home/);
  assert.match(screen(), /GitRoll · Home · main/, "the Roll, and the branch it writes to");
  assert.match(screen(), /saved · not backed up/, "a Roll with no backup says so");
  assert.match(screen(), /Nothing logged yet/);
  assert.match(screen(), /What happened\? Type it here/);

  await type("Paid the water bill");
  await press("return");
  assert.equal(roll.entries().length, 1);
  assert.equal(roll.entries()[0].title, "Paid the water bill");
  assert.match(screen(), /Logged to \.gitroll\/events\/\d{4}-\d{2}-\d{2}-[\w-]+\.md\. Committed on this computer\./, "saving names the file it wrote");
  assert.match(screen(), /Paid the water bill/);
  assert.equal(tui.prompt.value, "", "the prompt is ready for the next entry");

  await press("up", "return");
  assert.equal(tui.screen, "entry", "↑ picks an entry and Enter opens it");
  assert.match(screen(), /Paid the water bill/);
  await press("escape");
  assert.equal(tui.screen, "home");
});

test("↑ picks the newest entry first and keeps going back through older ones", async () => {
  const roll = GitRoll.init(tmp(), { name: "Home" });
  roll.save({ text: "Oldest thing", date: "2026-09-01" });
  roll.save({ text: "Middle thing", date: "2026-09-08" });
  roll.save({ text: "Newest thing", date: "2026-09-15" });
  const { tui, press } = app(roll);

  await press("up", "return");
  assert.equal(tui.current!.title, "Newest thing", "the entry nearest the prompt comes first");
  await press("escape", "up", "return");
  assert.equal(tui.current!.title, "Middle thing", "the selection is still where you left it");
  await press("escape", "down", "down");
  assert.equal(tui.homeIndex, -1, "coming back down lands on the prompt");
});

test("the / menu lists commands with descriptions, completes them and runs them", async () => {
  const roll = GitRoll.init(tmp(), { name: "Home" });
  roll.save({ text: "Quarterly review" });
  const { tui, press, type, screen } = app(roll);

  await type("/");
  assert.match(screen(), /Commands/);
  assert.match(screen(), /\/find\s+Search your entries as you type/);
  assert.match(screen(), /\/sync\s+Back up/);

  await type("fi");
  assert.equal(matchCommands("/fi")[0].name, "find");
  await press("tab");
  assert.equal(tui.prompt.value, "/find ");
  await press("return");
  assert.equal(tui.screen, "find");
  assert.match(screen(), /Quarterly review/);

  await press("escape");
  assert.equal(tui.screen, "home");
  await type("/nope");
  await press("return");
  assert.match(screen(), /No command by that name/);
});

test("the composer saves every field, completes projects, and keeps the entry findable", async () => {
  const roll = GitRoll.init(tmp(), { name: "Home" });
  roll.save({ text: "Picked tiles", projects: ["bathroom-remodel"] });
  const receipt = path.join(tmp(), "tile receipt.pdf");
  fs.writeFileSync(receipt, "pdf");
  const { tui, press, type, ctrl, screen } = app(roll);

  await press(ctrl("o"));
  assert.equal(tui.screen, "compose");
  assert.match(screen(), /Log something/);
  await type("Bought tiles\nfor the floor");
  assert.match(screen(), /for the floor/, "the text field takes more than one line");

  await focus(tui, "Date");
  await type("2026-03-04");
  await focus(tui, "Amount");
  await type("$248.50");
  await focus(tui, "Topics");
  await type("bath");
  assert.match(screen(), /bathroom-remodel/, "topics autocomplete from the Roll");
  await press("tab");
  await focus(tui, "Tags");
  await type("supplies");
  await focus(tui, "Photos or files");
  await type(escapePath(receipt));
  await press(ctrl("s"));

  assert.equal(tui.screen, "home");
  assert.match(screen(), /Logged\./);
  const saved = roll.entries().find((e) => e.title.startsWith("Bought tiles"))!;
  // The first line became the heading; the rest is the body, written once.
  assert.match(saved.body, /^# Bought tiles\n\nfor the floor/);
  assert.equal(saved.date, "2026-03-04");
  assert.equal(saved.path, ".gitroll/events/2026-03-04-bought-tiles.md");
  assert.deepEqual(saved.amount, { value: 248.5, currency: "USD" });
  assert.deepEqual(saved.projects, ["bathroom-remodel"]);
  assert.deepEqual(saved.tags, ["supplies"]);
  assert.equal(saved.attachments[0].path, ".gitroll/files/tile-receipt.pdf");
});

test("an unsaved composer draft survives cancelling, quitting and restarting", async () => {
  const roll = GitRoll.init(tmp(), { name: "Home" });
  const { tui, press, type, ctrl, state, screen } = app(roll);

  await press(ctrl("o"));
  await type("Half-written thought");
  await press("escape");
  assert.match(screen(), /Leave without saving\?/);
  await press("y");
  assert.equal(tui.screen, "home");
  assert.match(screen(), /Draft kept/);
  assert.equal(roll.entries().length, 0);
  assert.equal(state.drafts.get(roll.root)!.values.text, "Half-written thought");

  await press(ctrl("o"));
  assert.match(screen(), /Half-written thought/, "the draft comes back");
  await press("escape");

  const second = app(roll);
  second.tui.env.drafts = { load: () => state.drafts.get(roll.root) ?? null, save: () => {}, clear: () => {} };
  const restarted = new Tui(second.tui.env);
  assert.match(restarted.message, /unsaved draft/, "a restart says the draft is waiting");
  await restarted.key({ name: "o", ctrl: true });
  assert.equal(restarted.composer!.value("text"), "Half-written thought");
});

test("search: results as you type, a preview beside them, and actions on the selection", async () => {
  const roll = GitRoll.init(tmp(), { name: "Home" });
  roll.save({ text: "Paid the water bill", projects: ["house"] });
  roll.save({ text: "Fixed the side gate latch", projects: ["garden"] });
  const { tui, press, type, ctrl, screen } = app(roll);

  await type("/find");
  await press("return");
  await type("gate");
  assert.match(screen(), /1 of 2/);
  assert.doesNotMatch(screen(), /water bill/);
  assert.match(screen(), /Fixed the side gate latch[\s\S]*│/, "a wide terminal previews the selection beside the list");
  assert.match(screen(), /filters: topic:/, "filters are discoverable");

  await press("escape");
  assert.equal(tui.screen, "find", "the first Esc only clears the search");
  await type("topic:garden");
  assert.match(screen(), /1 of 2/);

  await press(ctrl("e"));
  assert.equal(tui.screen, "compose");
  assert.equal(tui.composer!.mode, "edit");
  await type(" again");
  await press(ctrl("s"));
  assert.equal(tui.screen, "find", "editing returns to the search you came from");
  assert.equal(tui.find.value, "topic:garden", "the query is preserved");
  assert.ok(roll.entries().some((e) => e.body.endsWith("again")));

  await press("escape", "escape");
  assert.equal(tui.screen, "home");
});

test("an entry can be edited, duplicated, attached to, deleted and undeleted", async () => {
  const roll = GitRoll.init(tmp(), { name: "Home" });
  roll.save({ text: "Serviced the furnace" });
  const photo = path.join(tmp(), "furnace.jpg");
  fs.writeFileSync(photo, "jpeg");
  const { tui, press, type, ctrl, screen } = app(roll);

  await press("up", "return");
  assert.equal(tui.screen, "entry");
  await press("a");
  await type(photo);
  await press("return");
  assert.match(screen(), /Attached 1 file/);
  assert.equal(roll.entries()[0].attachments.length, 1);

  await press("y");
  assert.equal(tui.composer!.mode, "duplicate");
  await press(ctrl("s"));
  assert.equal(roll.entries().length, 2, "a duplicate is a new entry");

  await press("up", "return", "h");
  assert.equal(tui.screen, "history");
  assert.match(screen(), /Every change to this entry/);
  await press("escape");

  await press("d");
  assert.match(screen(), /Delete this entry\?/);
  await press("y");
  assert.equal(roll.entries().length, 1);
  assert.match(screen(), /Press Ctrl\+Z to undo/);
  await press(ctrl("z"));
  assert.equal(roll.entries().length, 2, "undo puts it back");
  assert.match(screen(), /Restored\./);
});

test("/topics lists what's logged in each topic, and opens a search for one", async () => {
  const roll = GitRoll.init(tmp(), { name: "Home" });
  roll.save({ text: "Tiles arrived", projects: ["bathroom-remodel"] });
  roll.save({ text: "Grout too", projects: ["bathroom-remodel"] });
  roll.save({ text: "Mowed the lawn", projects: ["garden"] });
  const { tui, press, type, screen } = app(roll);

  await type("/topics");
  await press("return");
  assert.match(screen(), /Topics/);
  assert.match(screen(), /bathroom-remodel\s+2 entries/);
  assert.match(screen(), /garden\s+1 entry/);

  await press("return");
  assert.equal(tui.screen, "find");
  assert.equal(tui.find.value, "topic:bathroom-remodel");
  assert.match(screen(), /2 of 3/);
  assert.doesNotMatch(screen(), /Mowed the lawn/);
});

test("switching Rolls remembers the choice, and /status says where the Roll lives", async () => {
  const home = GitRoll.init(tmp(), { name: "Home" });
  const work = GitRoll.init(tmp(), { name: "Work" });
  work.save({ text: "Quarterly review" });
  const { press, type, state, screen } = app(home, [work]);

  await type("/roll");
  await press("return", "down", "return");
  assert.match(screen(), /GitRoll · Work/);
  assert.match(screen(), /Quarterly review/);
  assert.deepEqual(state.remembered, [work.root]);

  await type("/status");
  await press("return");
  assert.match(screen(), /Work · .*· main · no backup/, "status names the Roll, its folder, its branch and its backup");
});

test("the three states are kept apart, and a Git blocker says what to do", async () => {
  const roll = GitRoll.init(tmp(), { name: "Home" });
  roll.save({ text: "Committed by GitRoll" });
  const { tui, press, type, screen } = app(roll);

  // A file written into the folder by hand: saved, not committed.
  fs.writeFileSync(path.join(roll.root, ".gitroll", "events", "notes.txt"), "scratch");
  tui.reload();
  assert.match(screen(), /saved · 1 not committed · not backed up/);

  // HEAD off a branch: logging still works, syncing can't.
  git(roll.root, "checkout", "--detach", "--quiet", "HEAD");
  tui.reload();
  assert.match(screen(), /GitRoll · Home · detached HEAD/);
  assert.match(screen(), /needs a hand/);

  await type("/status");
  await press("return");
  assert.match(screen(), /isn't on a branch.*Logging still works.*git checkout main/s, "what still works, and the way back");

  await type("/sync");
  await press("return");
  assert.match(screen(), /isn't on a branch/, "and syncing says the blocker, not something vaguer");

  await type("Logged while detached");
  await press("return");
  assert.equal(roll.entries().length, 2, "logging never depended on Git being tidy");
});

test("the workspace stays inside a small window and never prints control characters from entries", async () => {
  const roll = GitRoll.init(tmp(), { name: "Tiny" });
  for (let i = 0; i < 40; i++) roll.save({ text: `Entry ${i} \x1b]0;evil\x07 with a very long line that keeps going and going past the edge` });
  const { tui, press } = app(roll);
  await press("up", "up", "up");
  const lines = tui.render(40, 12);
  assert.equal(lines.length, 12);
  for (const l of lines) assert.ok([...l.replace(/\x1b\[[0-9;]*m/g, "")].length <= 40, l);
  assert.doesNotMatch(lines.join(""), /\x1b\]|\x07/);
});

test("quitting protects text that hasn't been logged", async () => {
  const roll = GitRoll.init(tmp(), { name: "Home" });
  const { tui, press, type, ctrl, screen } = app(roll);
  await type("Not logged yet");
  await press(ctrl("c"));
  assert.equal(tui.done, false);
  assert.match(screen(), /unsaved text in the prompt/);
  await press("return");
  assert.equal(roll.entries().length, 1);
  await press(ctrl("c"));
  assert.equal(tui.done, true);
});

test("multiline editing and dragged paths", () => {
  const input = new Input("one\ntwo", true);
  input.key({ name: "home" });
  input.key({ name: "up" });
  assert.deepEqual(input.position(), { row: 0, column: 0 });
  input.key({ ch: "x" });
  assert.equal(input.value, "xone\ntwo");
  assert.deepEqual(parsePaths(`/a/b\\ c.jpg '/d/e f.pdf' "/g h.png" /plain.txt`), ["/a/b c.jpg", "/d/e f.pdf", "/g h.png", "/plain.txt"]);
  const awkward = "/tmp/a b\\c d.jpg"; // a name with a space and a backslash in it
  assert.deepEqual(parsePaths(escapePath(awkward)), [awkward], "an escaped path reads back exactly");
});
