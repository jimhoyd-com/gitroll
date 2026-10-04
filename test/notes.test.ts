// Notes and to-dos.
//
// A note is a Markdown file under .gitroll/notes/: the same format as an event,
// kept off the timeline because it is about something kept up to date rather
// than a moment. A to-do is GitHub's task-list line, "- [ ] …", wherever it is
// written. What is worth testing is that both stay plain Markdown a person could
// have typed, and that ticking one off changes that one character and nothing
// else.

import "./helpers.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { appendTodo, setTodo, todosIn } from "../src/core/todos.ts";
import { searchEntries } from "../src/core/search.ts";
import { GitRoll } from "../src/node/repo.ts";
import { git, tmp } from "./helpers.ts";

const cli = fileURLToPath(new URL("../src/node/cli.ts", import.meta.url));
function json(roll: GitRoll, args: string[]) {
  const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", cli, ...args, "-C", roll.root, "--json"], { encoding: "utf8", cwd: tmp(), timeout: 10_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout);
}

test("a to-do is a task-list line, and examples of one are not", () => {
  const source = [
    "---",
    "tags: [house]",
    "- [ ] not a to-do: this is front matter",
    "---",
    "",
    "# Deck",
    "",
    "- [ ] Buy stain",
    "  * [x] Sand it",
    "1. [X] Measure",
    "- [ ]",
    "- [] not a checkbox",
    "-[ ] not a list item",
    "",
    "```markdown",
    "- [ ] an example in a fence",
    "```",
    "<!--",
    "- [ ] a comment",
    "-->",
    "- [ ] Seal it",
  ].join("\n");
  assert.deepEqual(
    todosIn(source, "x.md").map((t) => [t.line, t.done, t.text]),
    [
      [8, false, "Buy stain"],
      [9, true, "Sand it"],
      [10, true, "Measure"],
      [11, false, ""],
      [21, false, "Seal it"],
    ],
  );
});

test("ticking one off changes one character, and a stale line changes nothing", () => {
  const source = "# Deck\r\n\r\n  - [ ] Buy stain  \r\n- [x] Sand it\r\n";
  const ticked = setTodo(source, 3, true);
  assert.equal(ticked, "# Deck\r\n\r\n  - [x] Buy stain  \r\n- [x] Sand it\r\n");
  assert.equal(setTodo(ticked, 4, false), "# Deck\r\n\r\n  - [x] Buy stain  \r\n- [ ] Sand it\r\n");
  assert.throws(() => setTodo(source, 1, true), /not a to-do/);
});

test("a new to-do joins the list it follows", () => {
  assert.equal(appendTodo("", "Call the plumber"), "- [ ] Call the plumber\n");
  assert.equal(appendTodo("# To do\n", "Call the plumber"), "# To do\n\n- [ ] Call the plumber\n");
  assert.equal(appendTodo("# To do\n\n- [x] One\n\n", "Two"), "# To do\n\n- [x] One\n- [ ] Two\n");
});

test("notes are kept off the timeline but found, shown and edited like events", () => {
  const roll = GitRoll.init(tmp(), { name: "Notes" });
  roll.save({ text: "Router replaced", date: "2026-09-15" });
  const { entry: note } = roll.saveNote({ title: "Wi-Fi", text: "Network: maple. Router in the hall closet." });

  assert.equal(note.path, ".gitroll/notes/wi-fi.md");
  assert.equal(note.date, null);
  assert.equal(fs.readFileSync(path.join(roll.root, note.path), "utf8"), "# Wi-Fi\n\nNetwork: maple. Router in the hall closet.\n", "a heading and the words: nothing else");
  assert.deepEqual(roll.entries().map((e) => e.title), ["Router replaced"], "not on the timeline");
  assert.deepEqual(roll.notes().map((e) => e.title), ["Wi-Fi"]);
  assert.equal(roll.entry("wi-fi").path, note.path, "found by name, as an event is");
  assert.equal(roll.entry("notes/wi-fi").path, note.path);

  roll.saveChanges("wi-fi", { text: "# Wi-Fi\n\nNetwork: maple-5g" });
  assert.match(roll.entrySource("wi-fi"), /maple-5g/);
  assert.match(git(roll.root, "log", "-1", "--format=%s"), /^edit: Wi-Fi/);

  const docs = roll.documents();
  assert.deepEqual(searchEntries(docs, "is:note").map((e) => e.title), ["Wi-Fi"]);
  assert.deepEqual(searchEntries(docs, "is:event").map((e) => e.title), ["Router replaced"]);
  assert.deepEqual(searchEntries(docs, "maple").map((e) => e.title), ["Wi-Fi"]);
  assert.deepEqual(roll.check(), [], "a note without a date is not worth a warning");
});

test("to-dos are added to a note, listed across the Roll, and ticked off as commits", () => {
  const roll = GitRoll.init(tmp(), { name: "Todos" });
  roll.save({ text: "# Deck\n\n- [ ] Buy stain\n- [x] Sand it", date: "2026-09-15" });

  const first = roll.addTodo("Call  the plumber");
  assert.equal(first.entry.path, ".gitroll/notes/todo.md", "created the first time it is needed");
  roll.addTodo("Book the AC service");
  assert.equal(fs.readFileSync(path.join(roll.root, ".gitroll/notes/todo.md"), "utf8"), "# To do\n\n- [ ] Call the plumber\n- [ ] Book the AC service\n");
  assert.match(git(roll.root, "log", "-1", "--format=%s"), /^todo: Book the AC service/);

  assert.deepEqual(
    roll.todos().filter((t) => !t.done).map((t) => t.text),
    ["Call the plumber", "Book the AC service", "Buy stain"],
    "notes first, where lists are kept, then the timeline",
  );
  assert.deepEqual(searchEntries(roll.documents(), "has:todo").length, 2);
  assert.deepEqual(searchEntries(roll.documents(), "has:done").map((e) => e.title), ["Deck"]);

  const deck = roll.todos().find((t) => t.text === "Buy stain")!;
  const { todo } = roll.markTodo(deck.path, deck.line, true);
  assert.equal(todo.done, true);
  assert.equal(roll.entrySource(deck.path).includes("- [x] Buy stain"), true);
  assert.match(git(roll.root, "log", "-1", "--format=%s"), /^done: Buy stain/);
  assert.throws(() => roll.markTodo(deck.path, 1, true), /isn't a to-do/);

  roll.addTodo("Seal it", "deck");
  assert.match(roll.entrySource("deck"), /- \[x\] Sand it\n- \[ \] Seal it\n$/);
});

test("the CLI adds, lists and ticks off to-dos, and lists notes", () => {
  const roll = GitRoll.init(tmp(), { name: "CLI" });
  const added = json(roll, ["todo", "Call", "the", "plumber"]);
  assert.deepEqual(added.todo, { path: ".gitroll/notes/todo.md", line: 3, text: "Call the plumber", done: false });
  json(roll, ["todo", "Fix the plumbing leak"]);
  json(roll, ["note", "Paint colours", "Hallway: Swiss Coffee"]);

  assert.deepEqual(json(roll, ["notes"]).map((n: { title: string }) => n.title), ["Paint colours", "To do"]);
  assert.deepEqual(json(roll, ["todos"]).map((t: { text: string }) => t.text), ["Call the plumber", "Fix the plumbing leak"]);

  const ambiguous = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", cli, "done", "plumb", "-C", roll.root, "--json"], { encoding: "utf8", cwd: tmp() });
  assert.equal(ambiguous.status, 1, "two to-dos match: never guessed");
  assert.match(JSON.parse(ambiguous.stderr).error.message, /notes\/todo:3/);

  assert.equal(json(roll, ["done", "notes/todo:4"]).todo.done, true);
  assert.equal(json(roll, ["done", "call"]).todo.text, "Call the plumber");
  assert.deepEqual(json(roll, ["todos"]), []);
  assert.equal(json(roll, ["todos", "--all"]).length, 2);
  assert.equal(json(roll, ["undone", "leak"]).todo.done, false);
  assert.equal(json(roll, ["show", "notes/paint-colours"]).title, "Paint colours");
});
