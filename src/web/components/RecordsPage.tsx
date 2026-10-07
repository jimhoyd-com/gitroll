import { ArrowDown, ArrowUp } from "lucide-react";
import { useMemo, useState } from "react";
import type { LoadedEntry } from "../../core/layout.ts";
import { collections, columnsOf, recordsIn, sortByFields } from "../../core/fields.ts";
import { SearchIndex } from "../../core/search.ts";
import { plural } from "../lib/format.ts";
import { DocLink, Empty, PageHeader, fieldText, tableClass, tdClass, thClass } from "./ViewParts.tsx";
import { Input, Label } from "./ui/input.tsx";

/**
 * One collection as a table: a row per record, a column for every field in
 * use. The same table `gitroll records <collection>` prints, with the same
 * filters and the same sort, so nothing has to be declared before it shows.
 */
export function RecordsPage({ notes, collection }: { notes: LoadedEntry[]; collection: string }) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: string; descending: boolean } | null>(null);
  const info = useMemo(() => collections(notes).find((c) => c.name.toLowerCase() === collection.toLowerCase()) ?? null, [notes, collection]);
  const records = useMemo(() => recordsIn(notes, collection), [notes, collection]);
  const columns = useMemo(() => columnsOf(records), [records]);
  const rows = useMemo(() => {
    const found = query.trim() ? new SearchIndex(records).search(query) : records;
    return sort ? sortByFields(found, [sort]) : [...found].sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
  }, [records, query, sort]);

  const title = info?.name ?? collection;
  if (!info) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title={title} />
        <Empty title={`There's no collection called "${collection}"`} command={`gitroll add ${collection || "books"} "Dune" --field rating=5`}>
          A collection is any folder under .gitroll/notes/, and it appears here once it has a note in it. Adding the first record makes one:
        </Empty>
      </div>
    );
  }

  const toggle = (key: string) =>
    setSort((cur) => (cur?.key !== key ? { key, descending: false } : cur.descending ? null : { key, descending: true }));

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={title} description={info.description ?? `Records in .gitroll/notes/${info.name}/. Any front matter key is a column.`}>
        <span className="text-sm text-muted-foreground">{plural(info.records, "record", "records")}</span>
      </PageHeader>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="records-q">Filter</Label>
        <Input
          id="records-q"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Words, or fields: status:reading rating>=4 has:isbn"
        />
      </div>

      {records.length === 0 ? (
        <Empty title="No records yet" command={`gitroll add ${info.name} "Title" --field key=value`} />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground" aria-live="polite">
          No record matches.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className={tableClass}>
            <caption className="sr-only">
              {title}: {plural(rows.length, "record", "records")}. Column headings sort the table.
            </caption>
            <thead>
              <tr>
                {["title", ...columns].map((c) => {
                  const active = sort?.key === c;
                  return (
                    <th key={c} scope="col" className={thClass} aria-sort={active ? (sort.descending ? "descending" : "ascending") : undefined}>
                      <button
                        type="button"
                        onClick={() => toggle(c)}
                        className="inline-flex items-center gap-1 rounded hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                      >
                        {c}
                        {active && (sort.descending ? <ArrowDown aria-hidden="true" className="size-3" /> : <ArrowUp aria-hidden="true" className="size-3" />)}
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.path}>
                  <th scope="row" className={`${tdClass} text-left font-normal`}>
                    <DocLink path={r.path}>{r.title || r.path}</DocLink>
                  </th>
                  {columns.map((c) => (
                    <td key={c} className={tdClass}>
                      {fieldText(r.meta[c])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
