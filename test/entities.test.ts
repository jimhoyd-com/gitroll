// Organizations and places: records with schema.org's names for their
// fields, read as views of their own. An organization's people are the
// contacts whose org names or links it; a place nests with within: and is
// whatever links to it; events that link to either are its history.

import "./helpers.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { contacts, orgReference, toVCard } from "../src/core/contacts.ts";
import { parseEntry } from "../src/core/entry.ts";
import { inventory } from "../src/core/inventory.ts";
import { addressText, organizations } from "../src/core/organizations.ts";
import { coordinatesOf, parseGeoUri, places } from "../src/core/places.ts";
import { frontMatterLinks } from "../src/core/relations.ts";
import { recordsIn } from "../src/core/fields.ts";
import { parseSidecar } from "../src/core/files.ts";
import * as core from "../src/core/index.ts";
import { GitRoll } from "../src/node/repo.ts";
import { tmp } from "./helpers.ts";

const cli = fileURLToPath(new URL("../src/node/cli.ts", import.meta.url));
function run(roll: GitRoll, args: string[]) {
  return spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", cli, ...args, "-C", roll.root], { encoding: "utf8", cwd: tmp(), timeout: 10_000 });
}
function json(roll: GitRoll, args: string[]) {
  const result = run(roll, [...args, "--json"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout);
}
const doc = (p: string, front: string, body = "# Untitled") => parseEntry(p, `---\n${front}\n---\n\n${body}\n`);

const acme = doc(
  ".gitroll/notes/organizations/acme.md",
  'legalName: Acme Corporation Ltd\nalternateName: ACME\nurl: https://acme.example\ntelephone: "+1 555 0100"\nemail: hello@acme.example\nfoundingDate: 1949-03-01\nsameAs: [https://en.wikipedia.org/wiki/Acme]\naddress: {streetAddress: 1 Road Runner Way, addressLocality: Mesa, addressCountry: US}\nlocation: "[Head office](../places/office.md)"',
  "# Acme",
);
const labs = doc(".gitroll/notes/organizations/acme-labs.md", 'parentOrganization: "[Acme](acme.md)"', "# Acme Labs");
const ada = doc(".gitroll/notes/people/ada.md", 'org: "[Acme](../organizations/acme.md);Research"\njobTitle: Engineer', "# Ada Lovelace");
const grace = doc(".gitroll/notes/people/grace.md", "org: acme corporation ltd", "# Grace Hopper");
const alan = doc(".gitroll/notes/people/alan.md", "org: Acme Labs;Crypto\nlocation: \"[Garage](../places/garage.md)\"", "# Alan Turing");
const kim = doc(".gitroll/notes/people/kim.md", 'org: "[Other](../organizations/other.md)"', "# Kim");
const meeting = doc(".gitroll/events/2026/2026-09-01-meeting.md", "", "# Met Acme\n\nAt [Acme](../../notes/organizations/acme.md) with [Ada](../../notes/people/ada.md).");
const invoice = doc(".gitroll/events/2026/2026-09-20-invoice.md", 'vendor: "[Acme](../../notes/organizations/acme.md)"', "# Invoice");

const house = doc(".gitroll/notes/places/house.md", "address: 12 Main St, Springfield\nlatitude: 51.5014\nlongitude: -0.1419", "# House");
const garage = doc(".gitroll/notes/places/garage.md", 'within: "[House](house.md)"', "# Garage");
const shelf = doc(".gitroll/notes/places/shelf.md", 'containedInPlace: "[Garage](garage.md)"\ngeo: "geo:51.5,-0.14;u=10"', "# Shelf 2");
const office = doc(".gitroll/notes/places/office.md", "geo: {latitude: 40.7, longitude: -74}", "# Head office");
const loopA = doc(".gitroll/notes/places/loop-a.md", 'within: "[B](loop-b.md)"', "# Loop A");
const loopB = doc(".gitroll/notes/places/loop-b.md", 'within: "[A](loop-a.md)"', "# Loop B");
const pump = doc(".gitroll/notes/inventory/pump.md", 'location: "[Garage](../places/garage.md)"', "# Heat pump");
const filters = doc(".gitroll/notes/inventory/filters.md", 'location: "[Shelf](../places/shelf.md)"', "# Filters");
const tools = doc(".gitroll/notes/garage-notes.md", "", "# Garage notes\n\nThe [garage](places/garage.md) leaks.");
const service = doc(".gitroll/events/2026/2026-08-01-service.md", 'location: "[Garage](../../notes/places/garage.md)"', "# Serviced the heat pump");
const party = doc(".gitroll/events/2026/2026-10-01-party.md", "", "# Party\n\nIn the [garage](../../notes/places/garage.md).");

const orgDocs = [acme, labs, ada, grace, alan, kim, meeting, invoice];
const placeRecords = [loopB, shelf, office, house, garage, loopA];
const allDocs = [...orgDocs, ...placeRecords, pump, filters, tools, service, party];

test("organizations: schema.org fields, people by org name or link, parent and sub-organizations, history from links", () => {
  const view = organizations([labs, acme], allDocs);
  assert.equal(view.collection, "organizations");
  assert.deepEqual(view.organizations.map((o) => o.name), ["Acme", "Acme Labs"]);
  const a = view.organizations[0];
  assert.equal(a.legalName, "Acme Corporation Ltd");
  assert.deepEqual(a.alternateNames, ["ACME"]);
  assert.deepEqual([a.urls, a.telephones, a.emails, a.sameAs], [["https://acme.example"], ["+1 555 0100"], ["hello@acme.example"], ["https://en.wikipedia.org/wiki/Acme"]]);
  assert.equal(a.foundingDate, "1949-03-01");
  assert.deepEqual(a.addresses, ["1 Road Runner Way, Mesa, US"], "a PostalAddress mapping reads as one line");
  assert.deepEqual(a.location, { name: "Head office", path: ".gitroll/notes/places/office.md" });
  assert.deepEqual(
    a.members.map((m) => [m.name, m.jobTitle, m.units]),
    [["Ada Lovelace", "Engineer", "Research"], ["Grace Hopper", null, null]],
    "a link, or the legal name in any case; a link to another record never matches by name",
  );
  assert.deepEqual(a.subOrganizations, [{ path: ".gitroll/notes/organizations/acme-labs.md", name: "Acme Labs" }]);
  assert.deepEqual(a.interactions.map((i) => i.title), ["Invoice", "Met Acme"], "body links and front matter links, newest first");
  assert.equal(a.lastContacted, "2026-09-20");
  const l = view.organizations[1];
  assert.deepEqual(l.parent, { name: "Acme", path: ".gitroll/notes/organizations/acme.md" });
  assert.deepEqual(l.members.map((m) => [m.name, m.units]), [["Alan Turing", "Crypto"]]);
  assert.equal(l.lastContacted, null);
});

test("a contact's org may be a link to an organization: read as its name, and written to vCard as text", () => {
  assert.deepEqual(orgReference(ada, ada.meta.org as string), { name: "Acme", units: "Research", path: ".gitroll/notes/organizations/acme.md" });
  assert.deepEqual(orgReference(grace, "Acme;Research; Lab"), { name: "Acme", units: "Research; Lab", path: null });
  assert.deepEqual(orgReference(grace, "[Odd] name"), { name: "[Odd] name", units: "", path: null });
  const people = contacts([ada, grace], allDocs).contacts;
  assert.deepEqual(people.map((c) => [c.org, c.orgPath]), [["Acme, Research", ".gitroll/notes/organizations/acme.md"], ["acme corporation ltd", null]]);
  assert.match(toVCard([ada]), /\r\nORG:Acme;Research\r\n/);
});

test("places: a tree from within: (or containedInPlace), what's there, events newest first, and geo: links", () => {
  const view = places(placeRecords, allDocs);
  assert.deepEqual(
    view.places.map((p) => [p.name, p.depth]),
    [["Head office", 0], ["House", 0], ["Garage", 1], ["Shelf 2", 2], ["Loop A", 0], ["Loop B", 1]],
    "each place once, followed by those within it; a loop of within: links is broken, not followed for ever",
  );
  const [office_, house_, garage_, shelf_, loopA_, loopB_] = view.places;
  assert.deepEqual(house_.coordinates, { latitude: 51.5014, longitude: -0.1419, uri: "geo:51.5014,-0.1419" });
  assert.deepEqual(house_.addresses, ["12 Main St, Springfield"]);
  assert.deepEqual(house_.children, [garage_.path]);
  assert.equal(garage_.parent, house_.path);
  assert.deepEqual(shelf_.trail, ["House", "Garage", "Shelf 2"]);
  assert.equal(shelf_.coordinates!.uri, "geo:51.5,-0.14");
  assert.equal(office_.coordinates!.uri, "geo:40.7,-74");
  assert.deepEqual(garage_.items.map((i) => i.title), ["Heat pump"], "things whose location links here; the shelf's are the shelf's");
  assert.deepEqual(shelf_.items.map((i) => i.title), ["Filters"]);
  assert.deepEqual(garage_.people.map((p) => p.title), ["Alan Turing"]);
  assert.deepEqual(garage_.notes.map((n) => n.title), ["Garage notes"]);
  assert.deepEqual(office_.organizations.map((o) => o.title), ["Acme"]);
  assert.deepEqual(garage_.events.map((e) => e.title), ["Party", "Serviced the heat pump"], "text links and location:, newest first");
  assert.deepEqual([loopA_.parent, loopB_.parent, loopA_.children, loopB_.children], [null, loopA_.path, [loopB_.path], []]);

  const some = places([garage, shelf], allDocs);
  assert.deepEqual(some.places.map((p) => [p.name, p.depth, p.trail]), [["Garage", 0, ["House", "Garage"]], ["Shelf 2", 1, ["House", "Garage", "Shelf 2"]]], "a place whose parent isn't listed starts the tree, and keeps its trail");
});

test("coordinates: schema.org latitude and longitude, a GeoCoordinates mapping, or an RFC 5870 geo: URI", () => {
  assert.deepEqual(parseGeoUri("geo:48.2010,16.3695,183;crs=wgs84;u=40"), { latitude: 48.201, longitude: 16.3695, uri: "geo:48.201,16.3695" });
  assert.deepEqual(parseGeoUri("-33.8688, 151.2093")?.uri, "geo:-33.8688,151.2093");
  assert.equal(parseGeoUri("geo:91,0"), null, "out of range");
  assert.equal(parseGeoUri("geo:1e5,0"), null, "no exponents");
  assert.equal(parseGeoUri("geo:1,2,x"), null);
  assert.equal(parseGeoUri("somewhere"), null);
  assert.equal(coordinatesOf({ latitude: "0.00000001", longitude: 0 })!.uri, "geo:0,0", "no exponent in the URI");
  assert.equal(coordinatesOf({ latitude: 10 }), null, "both, or none");
  assert.deepEqual(addressText([{ streetAddress: "1 A St", postalCode: "N1" }, "Box 5"]), ["1 A St, N1", "Box 5"]);
  const t = performance.now();
  parseGeoUri(`geo:${"1".repeat(100_000)}.${"2".repeat(100_000)},${"-".repeat(100_000)}`);
  assert.ok(performance.now() - t < 500, "read in time proportional to its length");
});

test("front matter links are links too, and places still nest the inventory with containedInPlace", () => {
  assert.deepEqual(frontMatterLinks(invoice), [".gitroll/notes/organizations/acme.md"]);
  assert.deepEqual(frontMatterLinks(doc(".gitroll/notes/x.md", 'a: ["[One](one.md)", plain, 3]\nb: {c: "[Two](two.md)"}')), [".gitroll/notes/one.md"], "lists are read; nested mappings aren't");
  const view = inventory([filters], allDocs, { today: "2026-10-07" });
  assert.deepEqual(view.items[0].location!.trail, ["House", "Garage", "Shelf 2"]);
  assert.equal(typeof core.organizations, "function");
  assert.equal(typeof core.places, "function");
  assert.equal(core.PLACES_COLLECTION, "places");
  assert.equal(core.ORGANIZATIONS_COLLECTION, "organizations");
});

test("gitroll organizations and gitroll places, with --json, a query and --collection", () => {
  const roll = GitRoll.init(tmp(), { name: "Entities" });
  const empty = run(roll, ["organizations"]);
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout, /No organizations in organizations yet\. Add one with: gitroll add organizations/);
  assert.match(run(roll, ["places"]).stdout, /No places in places yet/);
  for (const d of allDocs) {
    const file = path.join(roll.root, d.path);
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const write = (rel: string, text: string) => fs.writeFileSync(path.join(roll.root, rel), text);
  write(".gitroll/notes/organizations/acme.md", '---\nurl: https://acme.example\ntelephone: "+1 555 0100"\nlocation: "[Garage](../places/garage.md)"\n---\n\n# Acme\n');
  write(".gitroll/notes/organizations/acme-labs.md", '---\nparentOrganization: "[Acme](acme.md)"\n---\n\n# Acme Labs\n');
  write(".gitroll/notes/people/ada.md", '---\norg: "[Acme](../organizations/acme.md)"\n---\n\n# Ada Lovelace\n');
  write(".gitroll/notes/people/grace.md", "---\norg: Acme\n---\n\n# Grace Hopper\n");
  write(".gitroll/notes/places/house.md", "---\nlatitude: 51.5014\nlongitude: -0.1419\n---\n\n# House\n");
  write(".gitroll/notes/places/garage.md", '---\nwithin: "[House](house.md)"\n---\n\n# Garage\n');
  write(".gitroll/notes/inventory/pump.md", '---\nlocation: "[Garage](../places/garage.md)"\n---\n\n# Heat pump\n');
  write(".gitroll/events/2026/2026-09-01-meeting.md", "# Met Acme\n\nAt the [garage](../../notes/places/garage.md) with [Acme](../../notes/organizations/acme.md).\n");
  roll.commitPending();

  const orgs = json(roll, ["organizations"]);
  assert.equal(orgs.collection, "organizations");
  assert.deepEqual(orgs.organizations.map((o: { name: string; members: { name: string }[]; lastContacted: string | null }) => [o.name, o.members.map((m) => m.name), o.lastContacted]), [
    ["Acme", ["Ada Lovelace", "Grace Hopper"], "2026-09-01"],
    ["Acme Labs", [], null],
  ]);
  assert.equal(json(roll, ["organizations", "has:parentOrganization"]).organizations.length, 1);
  assert.match(run(roll, ["organizations"]).stdout, /^Acme {2}https:\/\/acme\.example {2}\+1 555 0100 {2}2 people: Ada Lovelace, Grace Hopper {2}last contacted 2026-09-01\nAcme Labs {2}part of Acme$/m);

  const view = json(roll, ["places"]);
  assert.deepEqual(view.places.map((p: { name: string; depth: number }) => [p.name, p.depth]), [["House", 0], ["Garage", 1]]);
  assert.equal(view.places[0].coordinates.uri, "geo:51.5014,-0.1419");
  assert.equal(run(roll, ["places"]).stdout, "House  geo:51.5014,-0.1419\n  Garage  1 thing, 1 organization, 1 event  last 2026-09-01\n");
  assert.deepEqual(json(roll, ["places", "garage"]).places.map((p: { trail: string[] }) => p.trail), [["House", "Garage"]]);
  assert.deepEqual(json(roll, ["places", "--collection", "organizations"]).places.map((p: { name: string }) => p.name), ["Acme", "Acme Labs"]);
  const bad = run(roll, ["places", "--collection", "..", "--json"]);
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stderr).error.code, "INVALID_ARGUMENT");
  assert.equal(run(roll, ["organizations", "--by", "x", "--json"]).status, 1, "only --collection");
  const schema = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", cli, "schema", "places"], { encoding: "utf8", cwd: tmp(), timeout: 10_000 });
  assert.deepEqual(Object.keys(JSON.parse(schema.stdout).commands[0].options), ["repo", "roll", "collection"]);
});

test("places: sub-folders of places and people count as theirs, and a file is where its sidecar says", () => {
  const attic = doc(".gitroll/notes/places/house/attic.md", 'within: "[House](../house.md)"', "# Attic");
  const cousin = doc(".gitroll/notes/people/family/cousin.md", 'location: "[Attic](../../places/house/attic.md)"', "# Cousin");
  const deeds = parseSidecar(".gitroll/files/deeds.pdf.md", '---\ntitle: House deeds\nlocation: "[Attic](../notes/places/house/attic.md)"\nexpires: 2030-01-01\n---\n', ".gitroll/files/deeds.pdf");
  const records = recordsIn([house, attic, cousin], "places");
  assert.deepEqual(records.map((r) => r.title), ["House", "Attic"]);
  const view = places(records, [house, attic, cousin, deeds]);
  const at = view.places.find((p) => p.name === "Attic")!;
  assert.deepEqual([at.parent, at.depth], [house.path, 1], "a place in places/house/ is in the tree");
  assert.deepEqual(at.people.map((p) => p.title), ["Cousin"], "someone in people/family/ is a person");
  assert.deepEqual(at.files, [{ path: ".gitroll/files/deeds.pdf", title: "House deeds" }]);
  assert.deepEqual(at.items, []);
});
