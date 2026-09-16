// Starting points for an event.
//
// A template is text and nothing else: what it produces is an ordinary Markdown
// event, indistinguishable from one typed by hand. What is worth testing is
// that they stay that way, that the everyday ones exist alongside the developer
// ones, and that what a template asks somebody to fill in is something GitRoll
// actually reads back.

import "./helpers.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { TEMPLATES, findTemplate, renderTemplate, templateIds, templatesIn } from "../src/core/templates.ts";
import { GitRoll } from "../src/node/repo.ts";
import { Composer } from "../src/node/tui/compose.ts";
import { tmp } from "./helpers.ts";

test("a Roll has starting points for everyday things, not only for code", () => {
  assert.deepEqual(
    templatesIn("everyday").map((x) => x.id),
    ["progress", "learning", "journal", "maintenance", "purchase"],
  );
  assert.deepEqual(
    templatesIn("developer").map((x) => x.id),
    ["debugging", "incident", "deployment", "experiment", "decision"],
    "and the developer ones are untouched",
  );
  assert.equal(templateIds().length, TEMPLATES.length, "every template is in exactly one group");

  // The words somebody reaches for aren't always the id.
  assert.equal(findTemplate("diary")?.id, "journal");
  assert.equal(findTemplate("repair")?.id, "maintenance");
  assert.equal(findTemplate("adr")?.id, "decision", "the alias that already existed still works");
  assert.equal(findTemplate("nope"), null);
});

test("an everyday template produces an ordinary event, like every other one", () => {
  const roll = GitRoll.init(tmp());
  const chosen = findTemplate("maintenance")!;
  const entry = roll.addEntry({ text: renderTemplate(chosen, "Boiler serviced"), tags: chosen.tags, date: "2026-11-02" });

  assert.equal(entry.path, ".gitroll/events/2026-11-02-boiler-serviced.md");
  assert.equal(entry.title, "Boiler serviced");
  assert.deepEqual(entry.tags, ["maintenance"]);
  assert.equal((entry.body.match(/^# /gm) ?? []).length, 1, "the template's heading isn't repeated");
  assert.doesNotMatch(entry.body, /\{\{title\}\}/);

  // Nothing reads a template back: the event is Markdown, and the headings are
  // the person's to delete.
  const edited = roll.updateEntry(entry.path, { text: "# Boiler serviced\n\nGuy came, cleaned it, gone in an hour.\n" });
  assert.doesNotMatch(edited.body, /Worth knowing next time/);
  assert.deepEqual(edited.tags, ["maintenance"], "the tag it was filed under survives the rewrite");
});

test("what the purchase template asks for is what the composers record", () => {
  // The cost line is written to be filled in with a sum, and a composer offers
  // that sum as the event's amount — which is what makes it count in a total.
  const composer = new Composer({ projects: [], tags: [] });
  composer.input("text").set(renderTemplate(findTemplate("purchase")!, "Dehumidifier").replace("- Cost:", "- Cost: $184.50"));
  assert.deepEqual(composer.suggested(), { value: 184.5, currency: "USD" });
  assert.deepEqual(composer.toInput().amount, { value: 184.5, currency: "USD" });
});
