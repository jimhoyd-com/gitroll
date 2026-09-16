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
import fs from "node:fs";
import path from "node:path";
import { BUILT_IN_TEMPLATES, TEMPLATES, findTemplate, renderTemplate, templateIds, templatesIn } from "../src/core/templates.ts";
import { GitRoll } from "../src/node/repo.ts";
import { Composer } from "../src/node/tui/compose.ts";
import { tmp } from "./helpers.ts";

/** A Roll with templates of its own, written the way a person would write them. */
function withTemplates(files: Record<string, string>, config = ""): GitRoll {
  const roll = GitRoll.init(tmp(), { name: "Maple Street" });
  fs.mkdirSync(path.join(roll.root, ".gitroll/templates"), { recursive: true });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(roll.root, ".gitroll/templates", name), body);
  if (config) fs.appendFileSync(path.join(roll.root, ".gitroll/config.yaml"), config);
  return roll;
}

const ids = (roll: GitRoll) => roll.templates().map((t) => t.id);

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

// ── Templates somebody wrote themselves ─────────────────────────────────────

test("a Roll's own templates are ordinary Markdown files, read like events are", () => {
  const roll = withTemplates({
    "rental inspection.md": `---
label: Rental inspection
description: What you checked, what needs fixing.
tags: [inspection, rental]
aliases: [inspect]
---

# {{title}}

## Checked
`,
    "walkthrough.md": "# {{title}}\n\nRoom by room.\n",
  });

  const [first, second] = roll.templates();
  assert.equal(first.id, "rental-inspection", "the file name is the identity, slugified");
  assert.equal(first.label, "Rental inspection");
  assert.deepEqual(first.tags, ["inspection", "rental"]);
  assert.deepEqual(first.aliases, ["inspect"]);
  assert.equal(first.group, "roll");
  assert.equal(first.path, ".gitroll/templates/rental inspection.md");

  // Front matter is optional, exactly as it is for an event.
  assert.equal(second.id, "walkthrough");
  assert.equal(second.label, "Walkthrough", "the file name, made readable");
  assert.deepEqual(second.tags, []);

  // And one produces an ordinary event.
  const entry = roll.addEntry({ text: renderTemplate(first, "Front bedroom"), tags: first.tags, date: "2026-04-02" });
  assert.equal(entry.title, "Front bedroom");
  assert.deepEqual(entry.tags, ["inspection", "rental"]);
  assert.doesNotMatch(entry.body, /\{\{title\}\}/);
});

test("a Roll's template replaces the built-in it is named after, and only that one", () => {
  const roll = withTemplates({ "incident.md": "# {{title}}\n\nOurs, not GitRoll's.\n" });

  const mine = roll.templates().find((t) => t.id === "incident")!;
  assert.equal(mine.group, "roll");
  assert.equal(mine.replaces, "incident", "and it says what it stands in place of");
  assert.match(mine.body, /Ours, not GitRoll's/);
  assert.equal(roll.templates().filter((t) => t.id === "incident").length, 1, "one incident, not two");

  // Everything else GitRoll ships is untouched.
  for (const built of BUILT_IN_TEMPLATES.filter((t) => t.id !== "incident")) {
    assert.ok(ids(roll).includes(built.id), `${built.id} is still offered`);
  }
});

test("a Roll keeps as many of the built-ins as it likes, down to none", () => {
  assert.deepEqual(ids(withTemplates({}, "templates:\n  built_in: none\n")), [], "none means none");

  const everyday = withTemplates({ "inspection.md": "# {{title}}\n" }, "templates:\n  built_in: [everyday]\n");
  assert.deepEqual(ids(everyday), ["inspection", "progress", "learning", "journal", "maintenance", "purchase"]);

  const picked = withTemplates({}, "templates:\n  built_in: [decision, journal]\n");
  assert.deepEqual(ids(picked), ["decision", "journal"], "ids can be named one by one");

  // A Roll that says nothing gets all of them, as it always did.
  assert.deepEqual(ids(withTemplates({})), templateIds());
});

test("a template file that can't be read costs the list nothing, and check says why", () => {
  const roll = withTemplates({
    "broken.md": "---\nlabel: [unclosed\n---\n\n# x\n",
    "fine.md": "# {{title}}\n",
  });
  assert.deepEqual(ids(roll).slice(0, 1), ["fine"], "the readable one is still offered");

  const problems = roll.check();
  const broken = problems.find((p) => p.path.endsWith("broken.md"));
  assert.ok(broken, "the broken file is reported");
  assert.match(broken!.error, /invalid YAML/);
});

test("two files that would be the same template are reported rather than silently one", () => {
  const roll = withTemplates({
    "rental inspection.md": "# {{title}}\n\nFirst.\n",
    "rental-inspection.md": "# {{title}}\n\nSecond.\n",
  });
  assert.deepEqual(ids(roll).filter((id) => id === "rental-inspection").length, 1, "one of them is offered");
  assert.match(roll.templates()[0].body, /First\./, "the first by file name");

  const clash = roll.check().find((p) => /same template/.test(p.error));
  assert.ok(clash, "and the other is reported");
});
