// PLACES. A house, a room, a shelf, an office or a town is a record with
// schema.org's Place names for its fields:
//
//   address                                  text, or a PostalAddress mapping
//   latitude, longitude                      WGS 84 decimal degrees: 51.5014, -0.1419
//   telephone, url                           how to reach it
//   within                                   a link to the place it is in
//
// `latitude` and `longitude` are schema.org Place's own properties, and two
// plain numbers are what `find latitude>51` and `--sort` already understand;
// a `geo` field is read too, as a schema.org GeoCoordinates mapping or an
// RFC 5870 `geo:` URI, so either can be pasted in. Nesting is the `within:`
// link the inventory already follows (schema.org's `containedInPlace` is read
// when there's no `within:`).
//
// It is not a new kind of file: `.gitroll/notes/places/` is a collection like
// any other. What is at a place is read from the links that point at it:
// things whose `location` links to it, people and organizations that link to
// it, and events that do, which are its history.

import type { Entry } from "./entry.ts";
import { metaValue } from "./calendar.ts";
import { PEOPLE_COLLECTION, values } from "./contacts.ts";
import type { Interaction } from "./contacts.ts";
import { collectionOf } from "./fields.ts";
import { parentPlaceValue } from "./inventory.ts";
import { ORGANIZATIONS_COLLECTION, addressText, eventsLinking, incomingLinks, refOf } from "./organizations.ts";

export const PLACES_COLLECTION = "places";

/** The schema.org keys a place record may use, in the order a card shows them. */
export const PLACE_FIELDS = ["address", "latitude", "longitude", "geo", "telephone", "url", "within", "containedInPlace"];

export interface Coordinates {
  latitude: number;
  longitude: number;
  /** The same point as an RFC 5870 URI, `geo:51.5014,-0.1419`, which map apps open. */
  uri: string;
}

const num = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.trim();
  return isDecimal(s) ? Number(s) : null;
};

/** A plain decimal, `-0.1419` or `51`: a sign, digits, and at most one point with digits after it. */
function isDecimal(s: string): boolean {
  let i = s[0] === "-" || s[0] === "+" ? 1 : 0;
  let digits = 0;
  while (i < s.length && s[i] >= "0" && s[i] <= "9") (i++, digits++);
  if (s[i] === ".") {
    i++;
    let after = 0;
    while (i < s.length && s[i] >= "0" && s[i] <= "9") (i++, after++);
    if (!after) return false;
  }
  return digits > 0 && i === s.length;
}

/** A number as RFC 5870 writes one: no exponent, at most seven decimals (about a centimetre). */
function degrees(n: number): string {
  let s = n.toFixed(7);
  let end = s.length;
  while (s[end - 1] === "0") end--;
  if (s[end - 1] === ".") end--;
  s = s.slice(0, end);
  return s === "-0" ? "0" : s;
}

/** A point, when the latitude and longitude are numbers in range. */
function point(lat: number | null, lon: number | null): Coordinates | null {
  if (lat === null || lon === null || lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { latitude: lat, longitude: lon, uri: `geo:${degrees(lat)},${degrees(lon)}` };
}

/**
 * An RFC 5870 `geo:` URI, `geo:51.5014,-0.1419` (an altitude and `;u=…`
 * parameters are allowed and not kept), or the same two numbers without the
 * scheme. Null when it isn't one.
 */
export function parseGeoUri(text: string): Coordinates | null {
  let s = text.trim();
  if (s.slice(0, 4).toLowerCase() === "geo:") s = s.slice(4);
  const semi = s.indexOf(";");
  if (semi >= 0) s = s.slice(0, semi);
  const parts = s.split(",");
  if (parts.length < 2 || parts.length > 3) return null;
  const [lat, lon, alt] = parts.map(num);
  if (parts.length === 3 && alt === null) return null;
  return point(lat, lon);
}

/** Where a place is on a map: `latitude` and `longitude`, else `geo` as a mapping or a `geo:` URI. */
export function coordinatesOf(meta: Record<string, unknown>): Coordinates | null {
  const lat = metaValue(meta, "latitude");
  const lon = metaValue(meta, "longitude");
  if (lat !== undefined || lon !== undefined) return point(num(lat), num(lon));
  const geo = metaValue(meta, "geo");
  if (geo && typeof geo === "object" && !Array.isArray(geo) && !(geo instanceof Date)) {
    const g = geo as Record<string, unknown>;
    return point(num(metaValue(g, "latitude")), num(metaValue(g, "longitude")));
  }
  return typeof geo === "string" ? parseGeoUri(geo) : null;
}

export interface Here {
  path: string;
  title: string;
}

export interface PlaceRecord {
  path: string;
  /** The record's title (schema.org's `name`). */
  name: string;
  addresses: string[];
  telephones: string[];
  urls: string[];
  coordinates: Coordinates | null;
  /** The place it is in, from `within:` (or `containedInPlace`), when that is one of the places listed. */
  parent: string | null;
  /** It and every place it is in, outermost first: ["House", "Garage", "Shelf 2"]. */
  trail: string[];
  /** How deep it is in the tree: 0 for a place in no other listed place. */
  depth: number;
  /** The listed places within it, by name. */
  children: string[];
  /** Things whose `location` links here, by title. */
  items: Here[];
  /** People (records in notes/people/) that link here. */
  people: Here[];
  /** Organizations (records in notes/organizations/) that link here. */
  organizations: Here[];
  /** Other notes that link here. */
  notes: Here[];
  /** Events that link here, in their text or a field such as `location`, newest first. */
  events: Interaction[];
}

export interface Places {
  collection: string;
  /** Every place, in the order of the tree: each followed by the places within it. */
  places: PlaceRecord[];
}

const byTitle = (a: Here, b: Here) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) || a.path.localeCompare(b.path);

/**
 * The places view: the records given, as a tree made from their `within:`
 * links, each with what is there and what happened there. `docs` is every
 * document, so links to each place are found.
 */
export function places(records: Entry[], docs: Entry[], collection = PLACES_COLLECTION): Places {
  const into = incomingLinks(docs);
  const all = new Map(docs.map((d) => [d.path, d]));
  const listed = new Map(records.map((r) => [r.path, r]));
  const parentOf = (r: Entry): string | null => refOf(r, parentPlaceValue(r.meta))?.path ?? null;

  const trailOf = (r: Entry): string[] => {
    const trail: string[] = [];
    const seen = new Set<string>();
    let at: Entry | undefined = r;
    // Out through `within:` links; a loop or a chain longer than 20 stops rather than spins.
    while (at && !seen.has(at.path) && seen.size < 20) {
      seen.add(at.path);
      trail.unshift(at.title);
      const up = parentOf(at);
      at = up ? all.get(up) : undefined;
    }
    return trail;
  };

  const read = (r: Entry): PlaceRecord => {
    const items: Here[] = [];
    const people: Here[] = [];
    const orgs: Here[] = [];
    const notes: Here[] = [];
    for (const d of into.get(r.path) ?? []) {
      if (d.path.toLowerCase().startsWith(".gitroll/events/")) continue;
      const here = { path: d.path, title: d.title };
      const collection = collectionOf(d.path)?.toLowerCase();
      if (parentOf(d) === r.path && (listed.has(d.path) || collection === PLACES_COLLECTION)) continue; // a place within it
      if (collection === PEOPLE_COLLECTION) people.push({ ...here, title: values(metaValue(d.meta, "fn"))[0] ?? d.title });
      else if (collection === ORGANIZATIONS_COLLECTION) orgs.push(here);
      else if (refOf(d, metaValue(d.meta, "location"))?.path === r.path) items.push(here);
      else notes.push(here);
    }
    const parent = parentOf(r);
    return {
      path: r.path,
      name: r.title,
      addresses: addressText(metaValue(r.meta, "address")),
      telephones: values(metaValue(r.meta, "telephone")),
      urls: values(metaValue(r.meta, "url")),
      coordinates: coordinatesOf(r.meta),
      parent: parent && parent !== r.path && listed.has(parent) ? parent : null,
      trail: trailOf(r),
      depth: 0,
      children: [],
      items: items.sort(byTitle),
      people: people.sort(byTitle),
      organizations: orgs.sort(byTitle),
      notes: notes.sort(byTitle),
      events: eventsLinking(r.path, into),
    };
  };

  const byPath = new Map(records.map((r) => [r.path, read(r)]));
  const sorted = [...byPath.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.path.localeCompare(b.path));
  for (const p of sorted) if (p.parent) byPath.get(p.parent)!.children.push(p.path);

  // Depth first from the places in no other, then from whatever a loop of
  // `within:` links left unvisited, so every place is listed exactly once.
  const out: PlaceRecord[] = [];
  const visited = new Set<string>();
  const visit = (p: PlaceRecord, depth: number) => {
    const stack: [PlaceRecord, number][] = [[p, depth]];
    while (stack.length) {
      const [at, d] = stack.pop()!;
      if (visited.has(at.path)) continue;
      visited.add(at.path);
      at.depth = d;
      out.push(at);
      for (const c of [...at.children].reverse()) stack.push([byPath.get(c)!, d + 1]);
    }
  };
  for (const p of sorted) if (!p.parent) visit(p, 0);
  for (const p of sorted) {
    if (visited.has(p.path)) continue;
    p.parent = null;
    visit(p, 0);
  }
  // A child seen first through another branch of a loop keeps only real edges.
  for (const p of out) p.children = p.children.filter((c) => byPath.get(c)!.parent === p.path);
  return { collection, places: out };
}
