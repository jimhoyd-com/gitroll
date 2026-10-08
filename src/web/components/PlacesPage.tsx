import { useMemo, useState } from "react";
import type { LoadedEntry } from "../../core/layout.ts";
import { recordsIn } from "../../core/fields.ts";
import { PLACES_COLLECTION, places } from "../../core/places.ts";
import type { Here, PlaceRecord } from "../../core/places.ts";
import { SearchIndex } from "../../core/search.ts";
import { plural } from "../lib/format.ts";
import { DocLink, Empty, PageHeader, dayText } from "./ViewParts.tsx";
import { Input, Label } from "./ui/input.tsx";
import { QueryError, useSavedQuery } from "./SavedSearches.tsx";

const linkClass = "rounded underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/** How many events each place lists before saying how many more there are. */
const EVENTS_SHOWN = 5;

function Links({ label, list, files = false }: { label: string; list: Here[]; files?: boolean }) {
  if (!list.length) return null;
  return (
    <p>
      <span className="text-muted-foreground">{label}: </span>
      {list.map((h, i) => (
        <span key={h.path}>
          {i > 0 && ", "}
          {files ? (
            // A file has no page of its own; the Files page lists it with its fields.
            <a href="#/files" className={linkClass}>
              {h.title}
            </a>
          ) : (
            <DocLink path={h.path} className={linkClass}>
              {h.title}
            </DocLink>
          )}
        </span>
      ))}
    </p>
  );
}

function PlaceCard({ place, byPath, nested }: { place: PlaceRecord; byPath: Map<string, PlaceRecord>; nested: boolean }) {
  const p = place;
  const id = `place-${p.path.replace(/[^A-Za-z0-9]/g, "-")}`;
  const children = p.children.map((c) => byPath.get(c)).filter((c): c is PlaceRecord => !!c);
  const inside = !nested && p.trail.length > 1 ? p.trail.slice(0, -1).join(" › ") : "";
  return (
    <li className="flex flex-col gap-2">
      <section aria-labelledby={id} className="flex flex-col gap-1 rounded-lg border border-border p-3 text-sm">
        <h2 id={id} className="text-base font-medium">
          <DocLink path={p.path}>{p.name}</DocLink>
          {inside && <span className="text-sm font-normal text-muted-foreground"> in {inside}</span>}
        </h2>
        {p.addresses.map((a) => (
          <p key={a}>{a}</p>
        ))}
        {(p.telephones.length > 0 || p.coordinates) && (
          <p className="flex flex-wrap gap-x-3">
            {p.telephones.map((t) => (
              <a key={t} href={`tel:${t.replace(/[^\d+]/g, "")}`} className={linkClass}>
                {t}
              </a>
            ))}
            {p.coordinates && (
              <a href={p.coordinates.uri} className={linkClass}>
                {p.coordinates.latitude}, {p.coordinates.longitude}
                <span className="sr-only"> (open in a map app)</span>
              </a>
            )}
          </p>
        )}
        <Links label="Things" list={p.items} />
        <Links label="People" list={p.people} />
        <Links label="Organizations" list={p.organizations} />
        <Links label="Notes" list={p.notes} />
        <Links label="Files" list={p.files} files />
        {p.events.length > 0 && (
          <div>
            <p className="text-muted-foreground">{plural(p.events.length, "event", "events")} here, newest first:</p>
            <ul className="flex flex-col gap-0.5">
              {p.events.slice(0, EVENTS_SHOWN).map((e) => (
                <li key={e.path}>
                  {e.date && <span className="text-muted-foreground">{dayText(e.date.slice(0, 10))} </span>}
                  <DocLink path={e.path} className={linkClass}>
                    {e.title}
                  </DocLink>
                </li>
              ))}
            </ul>
            {p.events.length > EVENTS_SHOWN && <p className="text-muted-foreground">and {p.events.length - EVENTS_SHOWN} more</p>}
          </div>
        )}
      </section>
      {children.length > 0 && (
        <ul className="ml-4 flex flex-col gap-2 border-l border-border pl-3" aria-label={`Within ${p.name}`}>
          {children.map((c) => (
            <PlaceCard key={c.path} place={c} byPath={byPath} nested />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * The places in .gitroll/notes/places/, as a tree made from their `within:`
 * links, with schema.org's names for their fields: what is at each (things
 * whose location links to it, people and organizations that link to it) and
 * the events that link to it. The same view as `gitroll places`.
 */
export function PlacesPage({ notes, docs }: { notes: LoadedEntry[]; docs: LoadedEntry[] }) {
  const [query, setQuery] = useState("");
  const saved = useSavedQuery(query);
  const records = useMemo(() => recordsIn(notes, PLACES_COLLECTION), [notes]);
  const view = useMemo(() => places(saved.query.trim() ? new SearchIndex(records).search(saved.query) : records, docs), [records, docs, saved.query]);
  const byPath = useMemo(() => new Map(view.places.map((p) => [p.path, p])), [view]);

  if (!records.length) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Places" />
        <Empty title="No places here yet" command={'gitroll add places "Garage" --field "within=[House](house.md)"'}>
          Places are records in .gitroll/notes/places/, with schema.org's field names: address, telephone, latitude and longitude. A within: link puts
          one inside another, and a thing's location: link puts it there.
        </Empty>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Places"
        description="Records in .gitroll/notes/places/, nested by their within: links. What's here is whatever links to the place: things by their location, people, organizations and events."
      />

      <div className="flex min-w-48 flex-col gap-1.5">
        <Label htmlFor="places-q">Filter</Label>
        <Input id="places-q" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Words, or fields: has:address latitude>50" />
        <QueryError error={saved.error} />
      </div>

      <p className="text-sm text-muted-foreground" aria-live="polite">
        {plural(view.places.length, "place", "places")}
      </p>

      <ul className="flex flex-col gap-2" aria-label="Places">
        {view.places
          .filter((p) => !p.parent)
          .map((p) => (
            <PlaceCard key={p.path} place={p} byPath={byPath} nested={false} />
          ))}
      </ul>
    </div>
  );
}
