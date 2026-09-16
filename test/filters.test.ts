// The buttons under the search box.
//
// Which searches deserve one click is the Roll's business: a Roll for a rental
// wants different ones from a Roll about a service, and GitRoll's three are a
// guess at a common case rather than a fact about anybody's logbook.

import "./helpers.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { DEFAULT_FILTERS, parseFilters } from "../src/core/filters.ts";
import { parseConfig } from "../src/core/layout.ts";
import { GitRoll } from "../src/node/repo.ts";
import { tmp } from "./helpers.ts";

const labels = (raw: unknown) => parseFilters(raw).map((f) => f.label);

test("a Roll that says nothing gets the defaults, and With a photo isn't one", () => {
  assert.deepEqual(labels(undefined), ["Today", "This month", "This year"]);
  assert.deepEqual(DEFAULT_FILTERS, ["today", "this-month", "this-year"]);
  assert.ok(!DEFAULT_FILTERS.includes("has-photo" as never), "a button that matches nothing in most Rolls is a button in the way");
});

test("a Roll lists the buttons it wants, in the order it wants them", () => {
  assert.deepEqual(labels(["this-year", "today"]), ["This year", "Today"], "order is the Roll's");
  assert.deepEqual(labels(["has:photo"]), ["With a photo"], "and it can have the photo one back");

  // The names people actually write.
  assert.deepEqual(labels(["This month"]), ["This month"]);
  assert.deepEqual(labels(["photo"]), ["With a photo"]);
});

test("a Roll can have buttons of its own, and can have none at all", () => {
  const mine = parseFilters([{ label: "Unpaid", query: "tag:unpaid" }, { label: "Big", query: "amount:>100 topic:house" }]);
  assert.deepEqual(mine.map((f) => f.kind), ["custom", "custom"]);
  assert.deepEqual(mine.map((f) => f.label), ["Unpaid", "Big"]);
  assert.equal(mine[1].kind === "custom" && mine[1].query, "amount:>100 topic:house");

  // A bare search is both the button and the query, so the short form works.
  assert.deepEqual(labels(["tag:unpaid"]), ["tag:unpaid"]);

  assert.deepEqual(parseFilters([]), [], "no buttons is a legitimate thing to want");
  assert.deepEqual(parseFilters(false), []);

  // Nonsense doesn't take somebody's buttons away.
  assert.deepEqual(labels(42), ["Today", "This month", "This year"]);
  assert.deepEqual(labels([{ label: "No query" }]), [], "a button with no search would do nothing, so it isn't one");
});

test("the Roll's config is where they come from", () => {
  const config = parseConfig("template_version: 1\nfilters:\n  - today\n  - label: Unpaid\n    query: tag:unpaid\n", "x");
  assert.deepEqual(config.quickFilters.map((f) => f.label), ["Today", "Unpaid"]);

  const roll = GitRoll.init(tmp(), { name: "Maple" });
  fs.appendFileSync(path.join(roll.root, ".gitroll/config.yaml"), "filters: []\n");
  assert.deepEqual(roll.config().quickFilters, [], "and a Roll that wants none has none");
});
