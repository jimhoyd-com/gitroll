import { useMemo, useState } from "react";
import type { LoadedEntry } from "../../core/layout.ts";
import { collectionOf, collections } from "../../core/fields.ts";
import { SearchIndex } from "../../core/search.ts";
import { recordsHref } from "../hooks/useStore.ts";
import { plural } from "../lib/format.ts";
import { DocLink, Empty, PageHeader } from "./ViewParts.tsx";
import { Input, Label } from "./ui/input.tsx";

const rowClass =
  "flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5 transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/**
 * Notes are pages kept up to date rather than logged, so they are not on the
 * timeline. Notes in a folder are a collection of records, listed first with a
 * link to their table; the rest are listed by title.
 */
export function NotesPage({ notes }: { notes: LoadedEntry[] }) {
  const [query, setQuery] = useState("");
  const groups = useMemo(() => collections(notes), [notes]);
  const loose = useMemo(() => notes.filter((n) => collectionOf(n.path) === null), [notes]);
  const index = useMemo(() => new SearchIndex(notes), [notes]);
  const hits = useMemo(() => (query.trim() ? index.search(query) : null), [index, query]);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Notes"
        description="Pages you keep up to date, like the Wi-Fi details or a runbook. A folder of notes is a collection, and each note in it a record with fields."
      />

      {notes.length === 0 ? (
        <Empty title="No notes yet" command={'gitroll note "Wi-Fi" "Network: maple"'}>
          A note is a Markdown file in .gitroll/notes/. Write one in any editor, or from the command line:
        </Empty>
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="notes-q">Search notes</Label>
            <Input id="notes-q" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Words, or a field like rating>=4" />
          </div>

          {hits ? (
            <section aria-label="Matching notes" className="flex flex-col gap-1">
              <p className="text-sm text-muted-foreground" aria-live="polite">
                {plural(hits.length, "note matches", "notes match")}
              </p>
              <NoteList notes={hits} />
            </section>
          ) : (
            <>
              {groups.length > 0 && (
                <section className="flex flex-col gap-2">
                  <h2 className="text-base font-medium">Collections</h2>
                  <ul className="flex flex-col gap-1">
                    {groups.map((c) => (
                      <li key={c.name}>
                        <a href={recordsHref(c.name)} className={rowClass}>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">{c.name}</span>
                            {c.description && <span className="block truncate text-xs text-muted-foreground">{c.description}</span>}
                          </span>
                          <span className="shrink-0 text-xs text-muted-foreground">{plural(c.records, "record", "records")}</span>
                        </a>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {loose.length > 0 && (
                <section className="flex flex-col gap-2">
                  <h2 className="text-base font-medium">Pages</h2>
                  <NoteList notes={loose} />
                </section>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

function NoteList({ notes }: { notes: LoadedEntry[] }) {
  return (
    <ul className="flex flex-col gap-1">
      {notes.map((n) => {
        const open = (n.body.match(/^\s*(?:[-*+]|\d+[.)])\s+\[ \]/gm) ?? []).length;
        const where = collectionOf(n.path);
        return (
          <li key={n.path}>
            <DocLink path={n.path} className={rowClass}>
              <span className="min-w-0 flex-1 truncate font-medium">{n.title || n.path}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {[where, open ? plural(open, "open to-do", "open to-dos") : ""].filter(Boolean).join(" · ")}
              </span>
            </DocLink>
          </li>
        );
      })}
    </ul>
  );
}
