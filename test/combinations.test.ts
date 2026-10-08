// Constructs combined the way a person combines them, in one Roll built with
// the command line: a person whose `org` links to an organization at a place
// within another place; a thing bought there, with a price, a warranty and a
// reminder, in a garage; events about it with an amount, an odometer reading
// and links in their text and in their front matter; an issue about it,
// pinned, with a to-do and a reminder inside, closed by `gitroll close`; an
// event that is an issue and has an amount; recurring notes that are pinned or
// an issue; a custom collection with fields and a saved search; a file with a
// sidecar that has a date and a place; sealed fields and blocks in an issue, a
// contact and a thing; and records that are moved after other things link to
// them, into sub-folders of their collections.
//
// Each view is asked the same questions it would be asked about one construct
// alone, and must agree with the others: nothing counted twice, nothing that
// links to something missing from what it links to, nothing sealed shown, and
// `check` happy with all of it.

import "./helpers.ts";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { after, before, describe, it, test } from "node:test";
import { fileURLToPath } from "node:url";
import { addDays, linkText } from "../src/core/calendar.ts";
import { parseEntry } from "../src/core/entry.ts";
import { setFields } from "../src/core/fields.ts";
import { groupFiles, linkedFrom } from "../src/core/files.ts";
import { inventoryItem } from "../src/core/inventory.ts";
import { issueOf } from "../src/core/issues.ts";
import { moveEntry } from "../src/core/layout.ts";
import { related } from "../src/core/relations.ts";
import { validateRepo } from "../src/core/validate.ts";
import { isoDate } from "../src/core/util.ts";
import { addRecipient, newKey, sealFile } from "../src/node/sealing.ts";
import { GitRoll } from "../src/node/repo.ts";
import { serve } from "../src/node/server.ts";
import { tmp } from "./helpers.ts";

const cli = fileURLToPath(new URL("../src/node/cli.ts", import.meta.url));
const today = isoDate();
const day = (n: number) => addDays(today, n);
const year = today.slice(0, 4);

// Secrets sealed below. None of them may appear anywhere without a key.
const SECRETS = ["7781", "4417", "BV7-99812", "555 0101", "blue box"];

let root = "";
let KEY: NodeJS.ProcessEnv = {};
let NO_KEY: NodeJS.ProcessEnv = {};

function run(args: string[], env: NodeJS.ProcessEnv = KEY) {
  const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", cli, ...args, "-C", root], { encoding: "utf8", cwd: tmp(), env: { ...process.env, ...env }, timeout: 30_000 });
  assert.ifError(result.error);
  return result;
}
function json(args: string[], env: NodeJS.ProcessEnv = KEY) {
  const result = run([...args, "--json"], env);
  assert.equal(result.status, 0, `${args.join(" ")}: ${result.stdout}${result.stderr}`);
  return JSON.parse(result.stdout);
}
function text(args: string[], env: NodeJS.ProcessEnv = KEY): string {
  const result = run(args, env);
  assert.equal(result.status, 0, `${args.join(" ")}: ${result.stdout}${result.stderr}`);
  return result.stdout;
}
const write = (rel: string, body: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body);
};
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const paths = (list: { path: string }[]) => list.map((x) => x.path);

const E = ".gitroll/events";
const N = ".gitroll/notes";
const BOUGHT = `${E}/${day(-200)}-bought-the-e-bike.md`;
const SERVICE = `${E}/${day(-120)}-first-service.md`;
const SQUEAL = `${E}/${year}/${day(-17)}-brake-squeal.md`;
const TOW = `${E}/${day(-6)}-tow-fee.md`;
const COMMUTE = `${E}/${day(-4)}-commute.md`;
const BIKE = `${N}/inventory/commuter-e-bike.md`;
const MARIA = `${N}/people/maria-lopez.md`;
const BOLT = `${N}/organizations/bolt-cycles.md`;

// ── One bug each, found by putting the constructs together ─────────────────

const ARMOR = "-----BEGIN AGE ENCRYPTED FILE-----\nYWdl\n-----END AGE ENCRYPTED FILE-----\n";
const doc = (p: string, source: string) => parseEntry(p, source);

test("a field typed as a Markdown link is written as text, not refused as bad YAML", () => {
  const out = setFields("# Garage\n", [["within", { yaml: "[Home](home.md)" }], ["org", { yaml: "[Acme](acme.md);Research" }]]);
  assert.match(out, /^within: "\[Home\]\(home\.md\)"$/m);
  assert.match(out, /^org: "\[Acme\]\(acme\.md\);Research"$/m);
  assert.match(setFields("# B\n", [["authors", { yaml: "[Le Guin, Delany]" }]]), /^authors: \[ Le Guin, Delany \]$/m, "a list is still a list");
});

test("related reads links in front matter fields as links, both ways", () => {
  const ada = doc(".gitroll/notes/people/ada.md", "# Ada\n");
  const met = doc(".gitroll/events/2026-10-01-met.md", '---\nwith: "[Ada](../notes/people/ada.md)"\nphoto: "[p](../files/p.jpg)"\n---\n# Met\n');
  assert.deepEqual(related(met, [ada, met]).links.map((e) => e.path), [ada.path]);
  assert.deepEqual(related(met, [ada, met]).missing, [], "a field linking to a file isn't a missing note");
  assert.deepEqual(related(ada, [ada, met]).backlinks.map((e) => e.path), [met.path]);
});

test("check reports a front matter link to a note or file that isn't there, and nothing else", () => {
  const files: Record<string, string> = {
    ".gitroll/config.yaml": "template_version: 1\n",
    ".gitroll/events/2026-10-01-fixed.md": '---\nresolves: "[Leak](2026-09-01-leak.md)"\nreceipt: "[r](../files/r.pdf)"\nsite: "[Acme](https://acme.example)"\n---\n# Fixed\n',
    ".gitroll/events/2026-10-02-ok.md": '---\nwith: "[Ada](../notes/ada.md)"\n---\n# Fine\n',
    ".gitroll/notes/ada.md": "# Ada\n",
  };
  const problems = validateRepo({ paths: Object.keys(files), read: (p) => files[p] });
  assert.deepEqual(problems.map((p) => [p.path, p.error, p.severity]), [
    [".gitroll/events/2026-10-01-fixed.md", "links to .gitroll/events/2026-09-01-leak.md in its front matter, which isn't in this Roll", "error"],
    [".gitroll/events/2026-10-01-fixed.md", "links to .gitroll/files/r.pdf in its front matter, which isn't in this Roll", "warning"],
  ]);
});

test("moving a document rewrites the relative links in its own front matter", () => {
  const source = '---\nabout: "[Bike](../../notes/bike.md)"\nlist: ["[A](../../notes/a.md)", plain]\n---\n\n# Squeal\n\nSee [bike](../../notes/bike.md).\n';
  const moved = moveEntry(source, ".gitroll/events/2026/2026-09-20-squeal.md", ".gitroll/events/2026-09-20-squeal.md");
  assert.match(moved, /^about: "\[Bike\]\(\.\.\/notes\/bike\.md\)"$/m);
  assert.match(moved, /^list: \[ ?"\[A\]\(\.\.\/notes\/a\.md\)", plain ?\]$/m, "a list item too");
  assert.match(moved, /See \[bike\]\(\.\.\/notes\/bike\.md\)\./);
});

test("moving a document rewrites front matter links to it elsewhere: an issue it resolves stays resolved", () => {
  const roll = GitRoll.init(tmp(), { name: "Moves" });
  const put = (rel: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(roll.root, rel)), { recursive: true });
    fs.writeFileSync(path.join(roll.root, rel), body);
  };
  put(".gitroll/events/2026/2026-09-20-clunk.md", "---\nissue: open\n---\n# Clunk\n");
  put(".gitroll/events/2026-10-02-fixed.md", '---\nresolves: "[Clunk](2026/2026-09-20-clunk.md)"\n---\n# Fixed\n');
  put(".gitroll/notes/organizations/acme.md", "# Acme\n");
  put(".gitroll/notes/people/ada.md", '---\norg: "[Acme](../organizations/acme.md);Research"\n---\n# Ada\n');
  put(".gitroll/files/r.pdf", "%PDF\n");
  put(".gitroll/files/r.pdf.md", '---\nfrom: "[Acme](../notes/organizations/acme.md)"\n---\n');
  roll.git(["add", "-A"]);
  roll.git(["commit", "-qm", "fixture"]);
  roll.moveEntry("2026-09-20-clunk", ".gitroll/events/2026-09-20-clunk.md");
  assert.match(fs.readFileSync(path.join(roll.root, ".gitroll/events/2026-10-02-fixed.md"), "utf8"), /^resolves: "\[Clunk\]\(\.\/2026-09-20-clunk\.md\)"$/m);
  assert.equal(issueOf(roll.entry("2026-09-20-clunk"), roll.documents(), isoDate())?.status, "resolved", "still resolved");
  roll.moveEntry("notes/organizations/acme", ".gitroll/notes/organizations/acme-corp.md");
  assert.match(fs.readFileSync(path.join(roll.root, ".gitroll/notes/people/ada.md"), "utf8"), /^org: "\[Acme\]\(\.\.\/organizations\/acme-corp\.md\);Research"$/m);
  assert.match(fs.readFileSync(path.join(roll.root, ".gitroll/files/r.pdf.md"), "utf8"), /^from: "\[Acme\]\(\.\.\/notes\/organizations\/acme-corp\.md\)"$/m, "a sidecar's link too");
  assert.equal(roll.git(["status", "--porcelain"]).trim(), "", "all in the move's commit");
});

test("a front matter link to a file counts as linking to it", () => {
  const files = groupFiles([".gitroll/files/r.pdf"]);
  const e = doc(".gitroll/events/2026-10-01-paid.md", '---\nreceipt: "[Receipt](../files/r.pdf)"\n---\n# Paid\n');
  assert.deepEqual(linkedFrom(files, [e]).get(".gitroll/files/r.pdf"), [e.path]);
});

test("a sealed value is shown as sealed in a thing, its place and its location, never as ciphertext", () => {
  assert.equal(linkText(ARMOR), "[sealed]");
  const garage = doc(".gitroll/notes/places/garage.md", `---\nwithin: |\n${ARMOR.replace(/^/gm, "  ").trimEnd()}\n---\n# Garage\n`);
  const bike = doc(".gitroll/notes/inventory/bike.md", `---\nserialNumber: |\n${ARMOR.replace(/^/gm, "  ").trimEnd()}\nlocation: "[Garage](../places/garage.md)"\n---\n# Bike\n`);
  const item = inventoryItem(bike, new Map([[garage.path, garage]]));
  assert.equal(item.serialNumber, "[sealed]");
  assert.deepEqual(item.location?.trail, ["[sealed]", "Garage"]);
  assert.equal(inventoryItem({ ...bike, meta: { ...bike.meta, serialNumber: { sealed: true } } }, new Map()).serialNumber, "[sealed]");
});

test("records and notes list a sealed field as sealed, never as its ciphertext", () => {
  const roll = GitRoll.init(tmp(), { name: "Lists" });
  fs.mkdirSync(path.join(roll.root, ".gitroll/notes/people"), { recursive: true });
  fs.writeFileSync(path.join(roll.root, ".gitroll/notes/people/ada.md"), `---\nemail: ada@example.com\ntel: |\n${ARMOR.replace(/^/gm, "  ").trimEnd()}\n---\n# Ada\n`);
  const list = (args: string[]) => {
    const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", cli, ...args, "-C", roll.root], { encoding: "utf8", cwd: tmp(), timeout: 20_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /BEGIN AGE/, args.join(" "));
    return r.stdout;
  };
  assert.deepEqual(JSON.parse(list(["records", "people", "--json"])).records[0].fields.tel, { sealed: true });
  assert.match(list(["records", "people"]), /\[sealed\]/);
  assert.deepEqual(JSON.parse(list(["notes", "--json"]))[0].meta.tel, { sealed: true });
});

test("sealing a file takes its sidecar and every link to it along, in text and in fields", async () => {
  const keys = path.join(tmp(), "keys.txt");
  const saved = process.env.GITROLL_IDENTITY;
  process.env.GITROLL_IDENTITY = keys;
  try {
    const made = await newKey("laptop");
    const roll = GitRoll.init(tmp(), { name: "Sidecars" });
    addRecipient(roll, made.recipient, "laptop");
    fs.mkdirSync(path.join(roll.root, ".gitroll/files"), { recursive: true });
    fs.writeFileSync(path.join(roll.root, ".gitroll/files/passport.pdf"), "%PDF\n");
    fs.writeFileSync(path.join(roll.root, ".gitroll/files/passport.pdf.md"), "---\ntitle: Passport\nexpires: 2030-05-01\n---\n");
    const event = ".gitroll/events/2026-10-01-passport.md";
    fs.writeFileSync(path.join(roll.root, event), '---\nscan: "[Scan](../files/passport.pdf)"\n---\n\n# Passport\n\n[passport](../files/passport.pdf)\n');
    roll.git(["add", "-A"]);
    roll.git(["commit", "-qm", "fixture"]);
    await sealFile(roll, ".gitroll/files/passport.pdf");
    assert.ok(fs.existsSync(path.join(roll.root, ".gitroll/files/passport.pdf.age.md")));
    assert.ok(!fs.existsSync(path.join(roll.root, ".gitroll/files/passport.pdf.md")));
    const after = fs.readFileSync(path.join(roll.root, event), "utf8");
    assert.match(after, /^scan: "\[Scan\]\(\.\.\/files\/passport\.pdf\.age\)"$/m);
    assert.match(after, /\[passport\]\(\.\.\/files\/passport\.pdf\.age\)/);
    assert.deepEqual(roll.check(), []);
    assert.equal(roll.git(["status", "--porcelain"]).trim(), "", "in the seal's one commit");
  } finally {
    if (saved === undefined) delete process.env.GITROLL_IDENTITY;
    else process.env.GITROLL_IDENTITY = saved;
  }
});

/** The Roll: built once, then read by every test below, in order. */
async function build() {
  root = path.join(tmp(), "Bike Roll");
  GitRoll.init(root, { name: "Bike" });
  const keys = path.join(tmp(), "keys.txt");
  const saved = process.env.GITROLL_IDENTITY;
  process.env.GITROLL_IDENTITY = keys;
  const made = await newKey("laptop");
  if (saved === undefined) delete process.env.GITROLL_IDENTITY;
  else process.env.GITROLL_IDENTITY = saved;
  KEY = { GITROLL_IDENTITY: keys };
  const empty = path.join(tmp(), "no-keys.txt");
  fs.writeFileSync(empty, "");
  NO_KEY = { GITROLL_IDENTITY: empty };
  json(["recipients", "add", made.recipient, "--name", "laptop"]);

  // Places that nest, an organization at one, and its people: one links to it, one names it.
  json(["add", "places", "Springfield", "--field", "latitude=39.78", "--field", "longitude=-89.65"]);
  json(["add", "places", "Eastside Plaza", "--field", "within=[Springfield](springfield.md)", "--field", "address=200 East St"]);
  json(["add", "places", "Home", "--field", "within=[Springfield](springfield.md)"]);
  json(["add", "places", "Garage", "--field", "within=[Home](home.md)"]);
  json(["add", "organizations", "Bolt Cycles", "--field", "location=[Eastside Plaza](../places/eastside-plaza.md)", "--field", "alternateName=Bolt", "--field", "telephone=+1 555 0100"]);
  const bday = day(8);
  json(["add", "people", "Maria Lopez", "--field", "org=[Bolt Cycles](../organizations/bolt-cycles.md);Service", "--field", "email=maria@bolt.example", "--field", "tel=+1 555 0101", "--field", `bday=--${bday.slice(5, 7)}${bday.slice(8, 10)}`, "--field", "gate_code=4417"]);
  json(["add", "people", "Sam Chen", "--field", "org=bolt", "--field", "location=[Home](../places/home.md)"]);

  // Things in the garage, bought from Bolt Cycles.
  json(["add", "inventory", "Commuter e-bike", "--field", "brand=Bolt", "--field", "serialNumber=BV7-99812", "--field", "price=$2,400", "--field", `warranty=${day(60)}`, "--field", "location=[Garage](../places/garage.md)", "--field", "vendor=[Bolt Cycles](../organizations/bolt-cycles.md)", "--field", `remind=${day(20)}T09:00`]);
  json(["add", "inventory", "Brake pads", "--field", "quantity=1", "--field", "reorderAt=2", "--field", "price=$18", "--field", "location=[Garage](../places/garage.md)"]);

  // Events: links in the text and in front matter fields, amounts, odometer readings.
  write(BOUGHT, `---\namount: 2400\nprojects: [bike]\nodometer: 0\nvendor: "[Bolt Cycles](../notes/organizations/bolt-cycles.md)"\nwith: "[Maria Lopez](../notes/people/maria-lopez.md)"\nlocation: "[Eastside Plaza](../notes/places/eastside-plaza.md)"\n---\n\n# Bought the e-bike\n\nPicked up the [Commuter e-bike](../notes/inventory/commuter-e-bike.md). #bike\n`);
  write(SERVICE, `---\namount: $89\nprojects: [bike]\nodometer: 812\n---\n\n# First service\n\n[Maria Lopez](../notes/people/maria-lopez.md) at [Bolt Cycles](../notes/organizations/bolt-cycles.md) adjusted the [e-bike](../notes/inventory/commuter-e-bike.md).\n`);
  write(SQUEAL, `---\nissue: open\npinned: true\nprojects: [bike]\nodometer: 1530\nabout: "[Commuter e-bike](../../notes/inventory/commuter-e-bike.md)"\nlock_code: 7781\n---\n\n# Brake squeal on the e-bike\n\nFront brake squeals when wet.\n\n- [ ] Order brake pads 📅 ${day(3)} ⏰ ${day(2)} 18:00\n- [ ] Ask [Maria](../../notes/people/maria-lopez.md) about the rotor\n\nThe spare key is in the blue box.\n`);
  write(TOW, `---\nissue: open\namount: 45\nprojects: [bike]\nvendor: "[Bolt Cycles](../notes/organizations/bolt-cycles.md)"\n---\n\n# Tow fee disputed\n`);
  write(COMMUTE, "---\nodometer: 1602\n---\n\n# Commute\n");
  // A collection of the person's own, with fields.
  write(`${N}/rides/river-loop.md`, "---\ndistance: 24.5\nrating: 5\n---\n\n# River loop\n\nStarts at [Home](../places/home.md).\n");
  write(`${N}/rides/hill-climb.md`, "---\ndistance: 8\nrating: 3\n---\n\n# Hill climb\n");
  // Recurring notes: one pinned with a reminder, one an issue.
  write(`${N}/maintenance/chain-lube.md`, `---\nstart: ${day(-30)}\nrrule: FREQ=MONTHLY\nremind: -P1D\npinned: true\nabout: "[Commuter e-bike](../inventory/commuter-e-bike.md)"\n---\n\n# Lube the chain\n`);
  write(`${N}/maintenance/tire-pressure.md`, `---\nstart: ${day(-2)}\nrrule: FREQ=WEEKLY\nissue: open\n---\n\n# Tires lose pressure\n`);
  json(["save"]);

  // A file with a sidecar that links to the thing and the place; an event's field links to it too.
  const receipt = path.join(tmp(), "receipt.pdf");
  fs.writeFileSync(receipt, "%PDF-1.4 receipt\n");
  json(["attach", receipt, "--to", BOUGHT, "--field", "title=E-bike receipt", "--field", "about=[Commuter e-bike](../notes/inventory/commuter-e-bike.md)", "--field", "location=[Eastside Plaza](../notes/places/eastside-plaza.md)", "--field", `expires=${day(25)}`]);
  json(["set", SERVICE, "receipt=[Receipt](../files/receipt.pdf)"]);

  // Writes on top: a to-do and a reminder in a record, a pin on a person.
  json(["todo", "Buy a spare tube", "--to", BIKE]);
  json(["remind", "Pick up the bike", "--at", `${day(5)} 17:00`, "--to", BIKE]);
  json(["pin", MARIA]);

  // Sealed: a field and a block in the issue, two fields of a contact, a field of a thing.
  json(["seal", SQUEAL, "--field", "lock_code"]);
  const line = read(SQUEAL).split("\n").findIndex((l) => l.includes("blue box")) + 1;
  json(["seal", SQUEAL, "--lines", `${line}-${line}`]);
  json(["seal", MARIA, "--field", "gate_code"]);
  json(["seal", MARIA, "--field", "tel"]);
  json(["seal", BIKE, "--field", "serialNumber"]);

  // The issue is closed with a note that links to the person.
  json(["close", SQUEAL, "--note", "New pads fitted by [Maria](../notes/people/maria-lopez.md).", "--at", day(-1)]);
}

describe("constructs combined in one Roll", async () => {
  before(build, { timeout: 180_000 });

  it("writes a field that is a Markdown link as text, as `add places … --field 'within=[Home](home.md)'` is documented", () => {
    assert.match(read(`${N}/places/garage.md`), /^within: "\[Home\]\(home\.md\)"$/m);
    assert.match(read(MARIA), /^org: "\[Bolt Cycles\]\(\.\.\/organizations\/bolt-cycles\.md\);Service"$/m);
    assert.equal(json(["set", `${N}/places/garage.md`, "within=[Home](home.md)"]).changed, false, "the same text again: nothing to change");
  });

  it("places, organizations, people and things agree on who is where", () => {
    const { places } = json(["places"]);
    const by = (name: string) => places.find((p: { name: string }) => p.name === name);
    assert.deepEqual(by("Garage").trail, ["Springfield", "Home", "Garage"]);
    assert.deepEqual(by("Garage").items.map((i: { title: string }) => i.title).sort(), ["Brake pads", "Commuter e-bike"]);
    assert.deepEqual(by("Home").people.map((i: { title: string }) => i.title), ["Sam Chen"]);
    assert.deepEqual(by("Home").notes.map((i: { title: string }) => i.title), ["River loop"], "a note linking in its text");
    assert.deepEqual(by("Eastside Plaza").organizations.map((i: { title: string }) => i.title), ["Bolt Cycles"]);
    assert.deepEqual(paths(by("Eastside Plaza").events), [BOUGHT], "an event's location: field");
    assert.deepEqual(by("Eastside Plaza").files, [{ path: ".gitroll/files/receipt.pdf", title: "E-bike receipt" }], "a sidecar's location: field");

    const [bolt] = json(["organizations"]).organizations;
    assert.deepEqual(bolt.location, { name: "Eastside Plaza", path: `${N}/places/eastside-plaza.md` });
    assert.deepEqual(bolt.members.map((m: { name: string }) => m.name), ["Maria Lopez", "Sam Chen"], "linked, and named by alternateName");
    assert.deepEqual(paths(bolt.interactions), [TOW, SERVICE, BOUGHT], "vendor: fields and links in the text alike");

    const maria = json(["contacts"]).contacts.find((c: { name: string }) => c.name === "Maria Lopez");
    assert.equal(maria.orgPath, BOLT);
    assert.equal(maria.org, "Bolt Cycles, Service");
    assert.ok(paths(maria.interactions).includes(BOUGHT), "a with: field is history too");
    assert.equal(maria.lastContacted, day(-1), "the event that closed the issue links to her");
    assert.deepEqual(maria.tels, [], "a sealed tel is left out, not shown as ciphertext");

    const view = json(["inventory"]);
    const bike = view.items.find((i: { title: string }) => i.title === "Commuter e-bike");
    assert.deepEqual(bike.location.trail, ["Springfield", "Home", "Garage"]);
    assert.equal(bike.serialNumber, "[sealed]");
    assert.deepEqual(view.warranties.map((w: { title: string }) => w.title), ["Commuter e-bike"]);
    assert.deepEqual(view.restock.map((r: { title: string }) => r.title), ["Brake pads"]);
  });

  it("counts every amount once: an issue with an amount, a purchase, and the event that resolves an issue", () => {
    const ledger = json(["ledger"]);
    const counted = paths(ledger.entries);
    assert.equal(new Set(counted).size, counted.length, "no entry twice");
    assert.deepEqual(counted.filter((p) => p.startsWith(E)).sort(), [BOUGHT, SERVICE, TOW].sort());
    // The purchase is the event's amount; the e-bike's price is what it is worth, not a second purchase.
    assert.ok(!counted.includes(BIKE), "a price an event with an amount links to isn't counted again");
    assert.deepEqual(counted.filter((p) => p.startsWith(N)), [`${N}/inventory/brake-pads.md`], "a price nothing paid for is");
    assert.deepEqual(ledger.totals, [{ currency: "USD", total: 2400 + 89 + 45 + 18, count: 4 }]);
    assert.deepEqual(json(["ledger", "brand:bolt"]).entries, [], "a search for the thing alone still leaves its price out");
    // The inventory still says what the thing is worth.
    const bike = json(["inventory"]).items.find((i: { title: string }) => i.title === "Commuter e-bike");
    assert.deepEqual(bike.value, { value: 2400, currency: "USD" });
  });

  it("follows the odometer through events in any folder, the issue among them", () => {
    const s = json(["series", "odometer"]);
    assert.deepEqual(s.points.map((p: { value: number }) => p.value), [0, 812, 1530, 1602]);
    assert.equal(s.points[2].path, SQUEAL);
  });

  it("resolves the pinned issue once and keeps it pinned, first and not repeated", () => {
    const list = json(["issues", "--all"]);
    assert.deepEqual([list.open, list.resolved], [2, 1]);
    const squeal = list.issues.find((i: { path: string }) => i.path === SQUEAL);
    assert.equal(squeal.status, "resolved");
    assert.equal(squeal.resolved, day(-1));
    assert.equal(squeal.resolvedBy.length, 1);
    assert.deepEqual(json(["issues"]).issues.map((i: { title: string }) => i.title).sort(), ["Tires lose pressure", "Tow fee disputed"], "an issue that is a recurring note, and one with an amount");

    const recent = json(["recent"]);
    assert.equal(recent[0].path, SQUEAL, "pinned first");
    assert.equal(paths(recent).filter((p) => p === SQUEAL).length, 1);
    assert.deepEqual(paths(json(["find", "is:pinned"])).sort(), [SQUEAL, `${N}/maintenance/chain-lube.md`, MARIA].sort());
    assert.deepEqual(paths(json(["find", "is:issue is:pinned"])), [SQUEAL]);
  });

  it("puts reminders, recurring notes, the warranty, a file's expiry and a birthday on the calendar, and not what a resolved issue left open", () => {
    const items = json(["upcoming", "--days", "40"]) as { kind: string; title: string; path: string; field?: string }[];
    const has = (kind: string, title: string) => items.some((i) => i.kind === kind && i.title === title);
    assert.ok(has("reminder", "Pick up the bike"), "⏰ on a to-do inside a record");
    assert.ok(has("reminder", "Commuter e-bike"), "remind: on a thing with no start");
    assert.ok(has("occurrence", "Lube the chain"));
    assert.ok(has("reminder", "Lube the chain"), "remind: -P1D on a pinned recurring note");
    assert.ok(has("occurrence", "Tires lose pressure"), "an issue that repeats");
    assert.ok(items.some((i) => i.kind === "field" && i.field === "bday" && i.path === MARIA));
    assert.ok(items.some((i) => i.kind === "field" && i.field === "expires" && i.title === "E-bike receipt"), "a sidecar's dated field");
    const ics = text(["calendar", "--ics"]);
    assert.match(ics, /RRULE:FREQ=MONTHLY/);
    assert.match(ics, /TRIGGER:-P1D/);
    assert.match(ics, /SUMMARY:E-bike receipt: expires/);
    assert.ok(json(["calendar"]).some((i: { field?: string; path: string }) => i.field === "expires" && i.path === ".gitroll/files/receipt.pdf.md"));

    // The brake squeal is resolved: its open to-do and its reminder are dealt with, though still in its file.
    assert.ok(!has("todo", "Order brake pads"), "a resolved issue's to-do");
    assert.ok(!has("reminder", "Order brake pads"), "a resolved issue's ⏰");
    assert.ok(!json(["reminders"]).some((r: { path: string }) => r.path === SQUEAL));
    assert.doesNotMatch(ics, /Order brake pads/);
    assert.ok(!paths(json(["todos"])).includes(SQUEAL));
    assert.ok(json(["todos", "--all"]).some((t: { path: string; done: boolean; text: string }) => t.path === SQUEAL && !t.done && t.text.startsWith("Order brake pads")), "--all still lists it");
    assert.match(read(SQUEAL), /- \[ \] Order brake pads/);

    // A recurring issue stops recurring once it is resolved, and starts again if it is reopened.
    const tires = `${N}/maintenance/tire-pressure.md`;
    json(["set", tires, `resolved=${today}`]);
    const after = json(["upcoming", "--days", "40"]) as { kind: string; path: string }[];
    assert.ok(!after.some((i) => i.path === tires && i.kind === "occurrence"));
    assert.doesNotMatch(text(["calendar", "--ics"]), /RRULE:FREQ=WEEKLY/);
    json(["set", tires, "--unset", "resolved"]);
    assert.ok((json(["upcoming", "--days", "40"]) as { kind: string; path: string }[]).some((i) => i.path === tires && i.kind === "occurrence"));
  });

  it("finds by field, sorts by field, and keeps a saved search", () => {
    assert.deepEqual(paths(json(["find", "distance>10"])), [`${N}/rides/river-loop.md`]);
    assert.deepEqual(paths(json(["find", "is:note", "rating>=4"])), [`${N}/rides/river-loop.md`]);
    assert.deepEqual(paths(json(["find", "has:odometer", "--sort=-odometer"])), [COMMUTE, SQUEAL, SERVICE, BOUGHT]);
    assert.deepEqual(paths(json(["find", "vendor:bolt"])).sort(), [BOUGHT, TOW, BIKE].sort(), "a link's text is searchable");
    json(["find", "is:issue project:bike", "--save", "bike-issues"]);
    assert.deepEqual(paths(json(["find", "@bike-issues"])).sort(), [SQUEAL, TOW].sort());
    assert.deepEqual(json(["records", "rides", "rating>=4"]).records.map((r: { title: string }) => r.title), ["River loop"]);
    // A saved search works wherever a query does, beside other words and filters.
    assert.deepEqual(paths(json(["find", "@bike-issues amount>10"])), [TOW]);
    assert.deepEqual(paths(json(["issues", "@bike-issues"]).issues), [TOW], "only the open one");
    assert.deepEqual(paths(json(["ledger", "@bike-issues"]).entries), [TOW]);
    assert.deepEqual(paths(json(["find", '"@bike-issues"'])), [], "in quotes it is text to find");
    for (const args of [["find", "@no-such-search"], ["ledger", "@no-such-search"], ["issues", "bike @no-such-search"]]) {
      const r = run(args);
      assert.notEqual(r.status, 0, `${args.join(" ")} is an error, not nothing found`);
      assert.match(r.stderr, /no saved search called "@no-such-search"/);
    }
  });

  it("reads links in front matter as links, in related, show and files as in contacts and places", () => {
    const maria = json(["related", MARIA]);
    assert.ok(maria.backlinks.includes(BOUGHT), "with: links to her");
    assert.ok(maria.backlinks.includes(SERVICE), "and so does text");
    const bike = json(["related", BIKE]);
    assert.ok(bike.links.includes(`${N}/places/garage.md`), "location:");
    assert.ok(bike.links.includes(BOLT), "vendor:");
    assert.ok(bike.backlinks.includes(SQUEAL), "about: on the issue");
    assert.ok(bike.backlinks.includes(`${N}/maintenance/chain-lube.md`));
    assert.ok(bike.backlinks.includes(".gitroll/files/receipt.pdf.md"), "a sidecar's about: links to it too");
    assert.deepEqual(bike.missing, []);
    assert.match(text(["show", MARIA]), new RegExp(`linked from: ${path.basename(BOUGHT, ".md")}`));

    const [receipt] = json(["files"]);
    assert.equal(receipt.title, "E-bike receipt");
    assert.deepEqual(receipt.linkedFrom.sort(), [BOUGHT, SERVICE].sort(), "a receipt: field counts as linking to the file");
  });

  it("shows nothing sealed without a key, in any view, and opens it with one", () => {
    const views = [
      ["recent"], ["find", "bike"], ["find", "is:pinned"], ["notes"], ["records", "people"], ["records", "inventory"], ["todos"], ["upcoming", "--days", "40"],
      ["reminders"], ["calendar", "--ics"], ["ledger"], ["series", "odometer"], ["inventory"], ["contacts"], ["contacts", "--vcf"], ["organizations"], ["places"],
      ["issues", "--all"], ["files"], ["related", MARIA], ["show", SQUEAL], ["show", MARIA], ["show", BIKE], ["check"],
    ];
    for (const v of views) {
      for (const asJson of [false, true]) {
        const out = asJson ? JSON.stringify(json(v, NO_KEY)) : text(v, NO_KEY);
        for (const s of SECRETS) assert.ok(!out.includes(s), `${v.join(" ")}${asJson ? " --json" : ""} shows ${s}`);
      }
    }
    assert.deepEqual(json(["find", "7781"], NO_KEY), [], "search never indexes sealed content");
    assert.deepEqual(json(["find", "7781"]), [], "not even with a key");

    // Lists give a sealed field as sealed, never as its ciphertext.
    const people = json(["records", "people"], NO_KEY).records.find((r: { title: string }) => r.title === "Maria Lopez");
    assert.deepEqual([people.fields.tel, people.fields.gate_code], [{ sealed: true }, { sealed: true }]);
    assert.match(text(["records", "people"], NO_KEY), /\[sealed\]/);
    for (const v of [["records", "people"], ["records", "inventory"], ["notes"], ["inventory"]]) {
      assert.doesNotMatch(text([...v, "--json"], NO_KEY), /BEGIN AGE/, `${v.join(" ")} --json`);
      assert.doesNotMatch(text(v, NO_KEY), /BEGIN AGE/, v.join(" "));
    }

    const opened = json(["show", MARIA, "--unsealed"]);
    assert.deepEqual(opened.meta.gate_code, { sealed: true, text: "4417" });
    assert.match(text(["show", SQUEAL, "--unsealed"]), /blue box/);
  });

  it("answers the same over MCP as on the command line", async () => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", cli, "mcp", "-C", root], { cwd: tmp(), env: { ...process.env, ...NO_KEY, GITROLL_AGENT: "" }, stdio: ["pipe", "pipe", "pipe"] });
    const waiting = new Map<number, (m: any) => void>();
    readline.createInterface({ input: child.stdout }).on("line", (l) => {
      const m = JSON.parse(l);
      waiting.get(m.id)?.(m);
    });
    let id = 0;
    const call = (method: string, params: unknown): Promise<any> =>
      new Promise((resolve) => {
        waiting.set(++id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "combinations", version: "1" } });
    const cases: [string, Record<string, unknown>, string[]][] = [
      ["issues", { all: true }, ["issues", "--all"]],
      ["ledger", {}, ["ledger"]],
      ["places", {}, ["places"]],
      ["related", { file: MARIA }, ["related", MARIA]],
      ["records", { collection: "people" }, ["records", "people"]],
      ["issues", { query: ["@bike-issues"] }, ["issues", "@bike-issues"]],
      ["ledger", { query: "@bike-issues tow" }, ["ledger", "@bike-issues", "tow"]],
    ];
    try {
      for (const [tool, args, argv] of cases) {
        const r = await call("tools/call", { name: `gitroll_${tool}`, arguments: args });
        assert.ok(!r.error && !r.result.isError, `${tool}: ${JSON.stringify(r)}`);
        assert.deepEqual(JSON.parse(r.result.content[0].text), json(argv, NO_KEY), tool);
      }
    } finally {
      child.stdin.end();
    }
  });

  it("seals and unseals a file with a sidecar: the sidecar and every link follow it", () => {
    json(["seal", ".gitroll/files/receipt.pdf"]);
    assert.ok(fs.existsSync(path.join(root, ".gitroll/files/receipt.pdf.age.md")), "the sidecar is named after the sealed file");
    assert.ok(!fs.existsSync(path.join(root, ".gitroll/files/receipt.pdf.md")));
    assert.match(read(SERVICE), /^receipt: "\[Receipt\]\(\.\.\/files\/receipt\.pdf\.age\)"$/m, "a front matter link follows");
    const files = json(["files"]);
    assert.deepEqual(files.map((f: { path: string; title: string }) => [f.path, f.title]), [[".gitroll/files/receipt.pdf.age", "E-bike receipt"]]);
    assert.match(text(["check"]), /looks good/);

    json(["unseal", ".gitroll/files/receipt.pdf.age", "--yes"]);
    assert.ok(fs.existsSync(path.join(root, ".gitroll/files/receipt.pdf.md")));
    assert.match(read(SERVICE), /\(\.\.\/files\/receipt\.pdf\)"$/m);
    assert.match(text(["check"]), /looks good/);
  });

  it("moves what others link to, in text and in fields, without breaking a link or reopening an issue", () => {
    // The resolved issue moves out of its year folder: the close event's resolves: follows it, and so does its own about: link.
    const squeal = `${E}/${day(-17)}-brake-squeal.md`;
    json(["move", SQUEAL, squeal]);
    assert.equal(json(["issues", "--all"]).issues.find((i: { path: string }) => i.path === squeal).status, "resolved");
    assert.match(read(squeal), /^about: "\[Commuter e-bike\]\(\.\.\/notes\/inventory\/commuter-e-bike\.md\)"$/m);
    // The organization is renamed: Maria's org (with its unit), the vendor: fields and the text follow.
    json(["move", BOLT, `${N}/organizations/bolt.md`]);
    assert.match(read(MARIA), /^org: "\[Bolt Cycles\]\(\.\.\/organizations\/bolt\.md\);Service"$/m);
    assert.match(read(TOW), /^vendor: "\[Bolt Cycles\]\(\.\.\/notes\/organizations\/bolt\.md\)"$/m);
    const [bolt] = json(["organizations"]).organizations;
    assert.equal(bolt.members.length, 2);
    assert.equal(bolt.interactions.length, 3);
    // The garage moves into a sub-folder of places: the things in it keep their place, and it stays in the tree.
    json(["move", `${N}/places/garage.md`, `${N}/places/home/garage.md`]);
    assert.deepEqual(json(["inventory"]).items.map((i: { location: { trail: string[] } }) => i.location.trail), [["Springfield", "Home", "Garage"], ["Springfield", "Home", "Garage"]]);
    const garage = json(["places"]).places.find((p: { name: string }) => p.name === "Garage");
    assert.equal(garage?.parent, `${N}/places/home.md`, "a place in places/home/ is still within Home");
    assert.equal(garage.items.length, 2);
    // The thing moves into a sub-folder of inventory: the sidecar's about: follows it, and every view still has it.
    const ebike = `${N}/inventory/bikes/e-bike.md`;
    json(["move", BIKE, ebike]);
    assert.match(read(".gitroll/files/receipt.pdf.md"), /^about: "\[Commuter e-bike\]\(\.\.\/notes\/inventory\/bikes\/e-bike\.md\)"$/m);
    assert.ok(paths(json(["inventory"]).items).includes(ebike), "inventory reads its sub-folders");
    assert.ok(paths(json(["records", "inventory"]).records).includes(ebike), "and so do records");
    assert.equal(json(["records"]).find((c: { name: string }) => c.name === "inventory").records, 2);
    assert.ok(paths(json(["places"]).places.find((p: { name: string }) => p.name === "Garage").items).includes(ebike));
    assert.match(text(["check"]), /looks good/);
    assert.equal(json(["status"]).uncommitted, 0, "every move committed what it changed");
  });

  it("check reports a front matter link that leads nowhere", () => {
    const tow = read(TOW);
    write(TOW, tow.replace("vendor: ", 'resolves: "[Gone](gone.md)"\nvendor: '));
    const result = run(["check"]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /links to \.gitroll\/events\/gone\.md in its front matter, which isn't in this Roll/);
    write(TOW, tow);
    assert.match(text(["check"]), /looks good/);
  });
});

// The same Roll in the browser app: every page loads without an error, an
// entry's page lists the notes it links to, and a sealed field is [sealed].
const WEB_DIR = path.resolve("dist/web");
describe("constructs combined, in the browser app", { skip: !fs.existsSync(path.join(WEB_DIR, "app.js")) && "run `npm run build` first" }, async () => {
  let browser: any = null;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ executablePath: process.env.GITROLL_TEST_CHROMIUM || undefined });
  } catch {
    browser = null;
  }
  const skip = browser ? false : "no browser installed (npx playwright install chromium)";
  let server: Awaited<ReturnType<typeof serve>> | null = null;
  const saved = process.env.GITROLL_IDENTITY;

  before(async () => {
    if (!browser) return;
    await build();
    process.env.GITROLL_IDENTITY = NO_KEY.GITROLL_IDENTITY;
    json(["find", "is:issue project:bike", "--save", "bike-issues"]);
    server = await serve(new GitRoll(root), { port: 0, webDir: WEB_DIR, token: "test-token" });
  }, { timeout: 180_000 });
  after(() => {
    server?.server.close();
    void browser?.close();
    if (saved === undefined) delete process.env.GITROLL_IDENTITY;
    else process.env.GITROLL_IDENTITY = saved;
  });

  const load = async (hash: string) => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("console", (m: any) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e: Error) => errors.push(e.message));
    await page.goto(`${server!.url}#/${hash}`, { waitUntil: "networkidle" });
    await page.waitForSelector("#main");
    return { page, errors };
  };

  it("loads every page without an error or anything sealed", { skip }, async () => {
    const expect: Record<string, string> = {
      "": "Brake squeal on the e-bike", upcoming: "Lube the chain", ledger: "2,552.00 USD", series: "1,602", inventory: "Springfield › Home › Garage",
      contacts: "Maria Lopez", organizations: "Bolt Cycles", places: "Eastside Plaza", issues: "Tow fee disputed", files: "E-bike receipt", notes: "maintenance",
    };
    for (const [hash, words] of Object.entries(expect)) {
      const { page, errors } = await load(hash);
      await page.getByText(words, { exact: false }).first().waitFor();
      const shown = await page.locator("#main").innerText();
      assert.deepEqual(errors, [], `#/${hash}`);
      for (const s of [...SECRETS, "BEGIN AGE"]) assert.ok(!shown.includes(s), `#/${hash} shows ${s}`);
      await page.close();
    }
  });

  it("lists the notes an event links to on its page, opened directly", { skip }, async () => {
    const { page, errors } = await load(`entry/${encodeURIComponent(SQUEAL)}`);
    const related = page.getByRole("region", { name: "Related" });
    await related.getByText("Commuter e-bike").waitFor();
    const shown = await related.innerText();
    assert.match(shown, /Maria Lopez/, "a link in the text");
    assert.match(shown, /Commuter e-bike/, "a link in a field");
    assert.doesNotMatch(shown, /isn't in this Roll/);
    assert.deepEqual(errors, []);
    await page.close();
  });

  it("shows a resolved issue's status, not its issue: field, and leaves its to-do off Upcoming", { skip }, async () => {
    const { page, errors } = await load(`entry/${encodeURIComponent(SQUEAL)}`);
    await page.getByText("Resolved issue").waitFor();
    const shown = await page.locator("#main").innerText();
    assert.doesNotMatch(shown, /^issue\s+open$/m, "no raw issue: open row");
    await page.close();

    const timeline = await load("");
    const card = timeline.page.locator("article", { hasText: "Brake squeal on the e-bike" }).first();
    await card.getByText("Resolved issue").waitFor();
    assert.doesNotMatch(await card.innerText(), /^issue\s+open$/m);
    await timeline.page.close();

    const upcoming = await load("upcoming");
    await upcoming.page.getByText("Lube the chain").first().waitFor();
    await upcoming.page.getByText("E-bike receipt").first().waitFor();
    assert.doesNotMatch(await upcoming.page.locator("#main").innerText(), /Order brake pads/);
    assert.deepEqual([...errors, ...timeline.errors, ...upcoming.errors], []);
    await upcoming.page.close();
  });

  it("reads a saved search in a page's search box, and says when there is none by that name", { skip }, async () => {
    const { page, errors } = await load("ledger");
    await page.getByText("2,552.00 USD").first().waitFor();
    await page.getByLabel("Filter").fill("@bike-issues");
    await page.getByText("1 entry").first().waitFor();
    await page.getByLabel("Filter").fill("@no-such-search");
    await page.getByRole("alert").filter({ hasText: 'no saved search called "@no-such-search"' }).waitFor();
    assert.deepEqual(errors, []);
    await page.close();
  });

  it("shows a sealed field as [sealed] on a record's page", { skip }, async () => {
    const { page } = await load(`entry/${encodeURIComponent(MARIA)}`);
    await page.getByRole("heading", { name: "Maria Lopez" }).waitFor();
    const shown = await page.locator("#main").innerText();
    assert.match(shown, /gate code\s+\[sealed\]/);
    assert.doesNotMatch(shown, /BEGIN AGE/);
    await page.close();
  });
});
