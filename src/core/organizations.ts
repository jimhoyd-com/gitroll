// ORGANIZATIONS. A company, a club, a school or a council is a record with
// schema.org's Organization names for its fields:
//
//   url, email, telephone, sameAs            where to find it (one, or a list)
//   address                                  where it is: text, or a PostalAddress mapping
//   legalName, alternateName                 its other names
//   foundingDate                             when it began
//   parentOrganization                       a link to the organization it is part of
//   location                                 a link to a place record
//
// It is not a new kind of file: `.gitroll/notes/organizations/` is a
// collection like any other. Its people are the contacts whose `org` names it
// or links to it, so nothing is written twice; the things it supplied are the
// records whose `vendor` links to it; and events that link to it are its
// history, read as backlinks, as they are for a person.

import type { Entry } from "./entry.ts";
import { linkText, metaValue } from "./calendar.ts";
import { ORGANIZATIONS_COLLECTION, goesBy, organizationNames, orgReference, values } from "./contacts.ts";
import type { Interaction } from "./contacts.ts";
import { fieldLink, frontMatterLinks } from "./relations.ts";

export { ORGANIZATIONS_COLLECTION };

/** The schema.org keys an organization record may use, in the order a card shows them. */
export const ORGANIZATION_FIELDS = ["legalName", "alternateName", "url", "email", "telephone", "address", "foundingDate", "sameAs", "parentOrganization", "location"];

const isEvent = (e: Entry) => e.path.toLowerCase().startsWith(".gitroll/events/");
const isNote = (e: Entry) => e.path.toLowerCase().startsWith(".gitroll/notes/");

/** schema.org's PostalAddress parts, in the order an address is read. */
const ADDRESS_PARTS = ["streetAddress", "postOfficeBoxNumber", "addressLocality", "addressRegion", "postalCode", "addressCountry"];

/**
 * Every address in an `address` field, as somebody reads it: text as written,
 * or a schema.org PostalAddress mapping (`{streetAddress, addressLocality, …}`)
 * with its parts joined by commas.
 */
export function addressText(v: unknown): string[] {
  return (Array.isArray(v) ? v : [v]).flatMap((x) => {
    if (x && typeof x === "object" && !Array.isArray(x) && !(x instanceof Date)) {
      const parts = ADDRESS_PARTS.flatMap((k) => values(metaValue(x as Record<string, unknown>, k)));
      return parts.length ? [parts.join(", ")] : [];
    }
    return values(x);
  });
}

/** A link field read as a reference: the record it links to when it is in the Roll, and its text. */
export interface Ref {
  name: string;
  path: string | null;
}

/** A front matter value that may be a link: `[Acme](acme.md)` is Acme, at acme.md. */
export function refOf(from: Entry, v: unknown): Ref | null {
  const s = values(v)[0];
  if (!s) return null;
  return { name: linkText(s), path: fieldLink(from, s) };
}

/**
 * Who links to what, worked out once: for each document, the documents that
 * link to it in their text or in their front matter. Keys and values are paths.
 */
export function incomingLinks(docs: Entry[]): Map<string, Entry[]> {
  const into = new Map<string, Entry[]>();
  for (const d of docs) {
    for (const to of new Set([...d.links, ...frontMatterLinks(d)])) {
      if (to === d.path) continue;
      const list = into.get(to);
      if (list) list.push(d);
      else into.set(to, [d]);
    }
  }
  return into;
}

/** Events that link to `path`, newest first. */
export function eventsLinking(path: string, into: Map<string, Entry[]>): Interaction[] {
  return (into.get(path) ?? [])
    .filter(isEvent)
    .map((e) => ({ path: e.path, title: e.title, date: e.date }))
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "") || a.title.localeCompare(b.title));
}

export interface Member {
  path: string;
  /** The formatted name: `fn`, else the record's title. */
  name: string;
  jobTitle: string | null;
  /** The units after the organization in their `org` ("Research"), or null. */
  units: string | null;
}

export interface Organization {
  path: string;
  /** The record's title (schema.org's `name`). */
  name: string;
  legalName: string | null;
  alternateNames: string[];
  urls: string[];
  emails: string[];
  telephones: string[];
  addresses: string[];
  foundingDate: string | null;
  sameAs: string[];
  /** `parentOrganization`: the organization it is part of. */
  parent: Ref | null;
  /** Organizations whose `parentOrganization` links to this one, by name. */
  subOrganizations: { path: string; name: string }[];
  /** `location`: where it is, often a link to a place record. */
  location: Ref | null;
  /** People whose `org` links to this record or names it, by name. */
  members: Member[];
  /** Things (any note, such as an inventory record) whose `vendor` links to it, by title. */
  supplied: { path: string; title: string }[];
  /** Events that link to it, newest first. */
  interactions: Interaction[];
  /** The date of the newest of those. */
  lastContacted: string | null;
}

export interface Organizations {
  collection: string;
  organizations: Organization[];
}

const byName = <T extends { name: string; path: string }>(a: T, b: T) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.path.localeCompare(b.path);
const first = (meta: Record<string, unknown>, k: string): string | null => values(metaValue(meta, k))[0] ?? null;

/**
 * The organizations view: the records given, by name, each with its people
 * and its history. `docs` is every document, so people and events are found.
 */
export function organizations(records: Entry[], docs: Entry[], collection = ORGANIZATIONS_COLLECTION): Organizations {
  const into = incomingLinks(docs);
  const all = new Map(docs.map((d) => [d.path, d]));
  // Everyone with an org, read once: what it links to, or the name it gives.
  const affiliations = docs.flatMap((d) => {
    if (!isNote(d)) return [];
    const org = values(metaValue(d.meta, "org"))[0];
    return org ? [{ doc: d, ref: orgReference(d, org) }] : [];
  });
  const orgs = records.map((r): Organization => {
    const names = organizationNames(r);
    const members = affiliations
      .filter(({ doc, ref }) => doc.path !== r.path && (ref.path ? ref.path === r.path : goesBy(names, ref.name)))
      .map(({ doc, ref }) => ({ path: doc.path, name: first(doc.meta, "fn") ?? doc.title, jobTitle: first(doc.meta, "jobTitle"), units: ref.units ? ref.units.split(";").map((p) => p.trim()).filter(Boolean).join(", ") || null : null }))
      .sort(byName);
    const subOrganizations = (into.get(r.path) ?? [])
      .filter((d) => d.path !== r.path && refOf(d, metaValue(d.meta, "parentOrganization"))?.path === r.path)
      .map((d) => ({ path: d.path, name: d.title }))
      .sort(byName);
    const supplied = (into.get(r.path) ?? [])
      .filter((d) => isNote(d) && d.path !== r.path && refOf(d, metaValue(d.meta, "vendor"))?.path === r.path)
      .map((d) => ({ path: d.path, title: d.title }))
      .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) || a.path.localeCompare(b.path));
    const interactions = eventsLinking(r.path, into);
    const dated = interactions.find((i) => i.date);
    const parent = refOf(r, metaValue(r.meta, "parentOrganization"));
    if (parent?.path && all.has(parent.path)) parent.name = all.get(parent.path)!.title;
    const location = refOf(r, metaValue(r.meta, "location"));
    if (location?.path && all.has(location.path)) location.name = all.get(location.path)!.title;
    return {
      path: r.path,
      name: r.title,
      legalName: first(r.meta, "legalName"),
      alternateNames: values(metaValue(r.meta, "alternateName")),
      urls: values(metaValue(r.meta, "url")),
      emails: values(metaValue(r.meta, "email")),
      telephones: values(metaValue(r.meta, "telephone")),
      addresses: addressText(metaValue(r.meta, "address")),
      foundingDate: first(r.meta, "foundingDate"),
      sameAs: values(metaValue(r.meta, "sameAs")),
      parent,
      subOrganizations,
      location,
      members,
      supplied,
      interactions,
      lastContacted: dated?.date ? dated.date.slice(0, 10) : null,
    };
  });
  return { collection, organizations: orgs.sort(byName) };
}
