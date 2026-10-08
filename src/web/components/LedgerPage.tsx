import { useMemo, useState } from "react";
import type { LoadedEntry } from "../../core/layout.ts";
import { ledger } from "../../core/ledger.ts";
import { SearchIndex } from "../../core/search.ts";
import { formatAmount } from "../../core/util.ts";
import { plural } from "../lib/format.ts";
import { DocLink, Empty, PageHeader, Totals, dayText, tableClass, tdClass, thClass } from "./ViewParts.tsx";
import { Button } from "./ui/button.tsx";
import { Input, Label } from "./ui/input.tsx";
import { QueryError, useSavedQuery } from "./SavedSearches.tsx";

const GROUPS = [
  { by: "", label: "Every entry" },
  { by: "month", label: "By month" },
  { by: "year", label: "By year" },
  { by: "project", label: "By topic" },
  { by: "tag", label: "By tag" },
];

/**
 * Totals of every event's `amount`, and the `price` of every record no such
 * event links to (that event is the purchase), per currency
 * and never converted. A view, not an accounting system: `gitroll ledger
 * --hledger` hands the same entries to one.
 */
export function LedgerPage({ docs }: { docs: LoadedEntry[] }) {
  const [by, setBy] = useState("month");
  const [query, setQuery] = useState("");
  const saved = useSavedQuery(query);
  const view = useMemo(() => {
    const chosen = saved.query.trim() ? new SearchIndex(docs).search(saved.query) : docs;
    return ledger(chosen, by || undefined, docs);
  }, [docs, by, saved.query]);
  const newestFirst = useMemo(() => [...view.entries].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "")), [view.entries]);
  const groups = useMemo(() => (by === "month" || by === "year" ? [...view.groups].reverse() : view.groups), [view.groups, by]);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Ledger" description="Amounts on events and prices on records, totalled per currency. Nothing is converted between currencies." />

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-48 flex-1 flex-col gap-1.5">
          <Label htmlFor="ledger-q">Filter</Label>
          <Input id="ledger-q" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="topic:house after:2026-01-01" />
          <QueryError error={saved.error} />
        </div>
        <div role="group" aria-label="Group by" className="flex flex-wrap gap-1">
          {GROUPS.map((g) => (
            <Button key={g.by} size="sm" variant={by === g.by ? "default" : "ghost"} aria-pressed={by === g.by} onClick={() => setBy(g.by)}>
              {g.label}
            </Button>
          ))}
        </div>
      </div>

      {view.entries.length === 0 ? (
        <Empty title="Nothing with an amount or a price" command={"gitroll log 'Paid the plumber' --amount '$240'"}>
          An event with an amount, like $240 in its text or amount: 240 in its front matter, or a record with a price, is counted here.
        </Empty>
      ) : (
        <>
          <p className="rounded-lg border border-border bg-muted px-3 py-2 text-sm">
            <span className="font-medium">Total</span> <Totals totals={view.totals} />{" "}
            <span className="text-muted-foreground">({plural(view.entries.length, "entry", "entries")})</span>
          </p>

          <div className="overflow-x-auto rounded-lg border border-border">
            {by ? (
              <table className={tableClass}>
                <caption className="sr-only">Totals {GROUPS.find((g) => g.by === by)?.label.toLowerCase()}</caption>
                <thead>
                  <tr>
                    <th scope="col" className={thClass}>
                      {by === "project" ? "topic" : by}
                    </th>
                    <th scope="col" className={thClass}>
                      Total
                    </th>
                    <th scope="col" className={`${thClass} text-right`}>
                      Entries
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((g) => (
                    <tr key={g.key}>
                      <th scope="row" className={`${tdClass} text-left font-medium`}>
                        {g.key}
                      </th>
                      <td className={tdClass}>
                        <Totals totals={g.totals} />
                      </td>
                      <td className={`${tdClass} text-right tabular-nums`}>{g.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <table className={tableClass}>
                <caption className="sr-only">Every entry with an amount or a price</caption>
                <thead>
                  <tr>
                    <th scope="col" className={thClass}>
                      Date
                    </th>
                    <th scope="col" className={thClass}>
                      What
                    </th>
                    <th scope="col" className={`${thClass} text-right`}>
                      Amount
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {newestFirst.map((e) => (
                    <tr key={`${e.path}:${e.field}`}>
                      <td className={`${tdClass} whitespace-nowrap text-muted-foreground`}>{e.date ? dayText(e.date) : "undated"}</td>
                      <th scope="row" className={`${tdClass} text-left font-normal`}>
                        <DocLink path={e.path}>{e.title || e.path}</DocLink>
                        {e.field === "price" && <span className="text-xs text-muted-foreground"> (price)</span>}
                      </th>
                      <td className={`${tdClass} whitespace-nowrap text-right tabular-nums`}>{formatAmount(e.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}
