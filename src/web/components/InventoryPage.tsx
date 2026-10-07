import { useMemo, useState } from "react";
import type { LoadedEntry } from "../../core/layout.ts";
import { recordsIn } from "../../core/fields.ts";
import { INVENTORY_COLLECTION, inventory } from "../../core/inventory.ts";
import type { InventoryItem } from "../../core/inventory.ts";
import { SearchIndex } from "../../core/search.ts";
import { formatAmount, isoDate } from "../../core/util.ts";
import { plural } from "../lib/format.ts";
import { DocLink, Empty, PageHeader, Totals, dayText, tableClass, tdClass, thClass } from "./ViewParts.tsx";
import { Button } from "./ui/button.tsx";
import { Input, Label } from "./ui/input.tsx";

/**
 * What you own, from the records in .gitroll/notes/inventory/: what each is
 * worth, where it is (places nest with `within:`), which warranties end in the
 * next 90 days, and what is running low. The same view as `gitroll inventory`,
 * using schema.org's names for things.
 */
export function InventoryPage({ notes, docs }: { notes: LoadedEntry[]; docs: LoadedEntry[] }) {
  const [query, setQuery] = useState("");
  const [byPlace, setByPlace] = useState(false);
  const records = useMemo(() => recordsIn(notes, INVENTORY_COLLECTION), [notes]);
  const view = useMemo(() => {
    const chosen = query.trim() ? new SearchIndex(records).search(query) : records;
    return inventory(chosen, docs, { by: byPlace ? "location" : undefined, today: isoDate() });
  }, [records, docs, query, byPlace]);

  if (!records.length) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Inventory" />
        <Empty title="Nothing in the inventory yet" command={'gitroll add inventory "Garage heat pump" --field brand=Daikin --field price=1899'}>
          Things you own are records in .gitroll/notes/inventory/, with fields like brand, model, serialNumber, price, warranty, location and quantity.
        </Empty>
      </div>
    );
  }

  const rowsFor = (items: InventoryItem[]) =>
    items.map((i) => (
      <tr key={i.path}>
        <th scope="row" className={`${tdClass} text-left font-normal`}>
          <DocLink path={i.path}>{i.title}</DocLink>
          {i.restock && <span className="ml-1.5 rounded bg-del-bg px-1 text-xs text-del">restock</span>}
        </th>
        <td className={tdClass}>{[i.brand, i.model].filter(Boolean).join(" ")}</td>
        <td className={tdClass}>{i.location?.trail.join(" › ") ?? ""}</td>
        <td className={`${tdClass} whitespace-nowrap`}>{i.warranty ? dayText(i.warranty.slice(0, 10)) : ""}</td>
        <td className={`${tdClass} text-right tabular-nums`}>{i.quantity ?? ""}</td>
        <td className={`${tdClass} whitespace-nowrap text-right tabular-nums`}>{i.value ? formatAmount(i.value) : ""}</td>
      </tr>
    ));

  const head = (
    <thead>
      <tr>
        {["Item", "Brand and model", "Where", "Warranty until", "Quantity", "Value"].map((h, n) => (
          <th key={h} scope="col" className={n >= 4 ? `${thClass} text-right` : thClass}>
            {h}
          </th>
        ))}
      </tr>
    </thead>
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Inventory" description="Records in .gitroll/notes/inventory/. Value is price × quantity, per currency." />

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-48 flex-1 flex-col gap-1.5">
          <Label htmlFor="inventory-q">Filter</Label>
          <Input id="inventory-q" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Words, or fields: brand:daikin price>100" />
        </div>
        <Button size="sm" variant={byPlace ? "default" : "ghost"} aria-pressed={byPlace} onClick={() => setByPlace((v) => !v)}>
          By place
        </Button>
      </div>

      <p className="rounded-lg border border-border bg-muted px-3 py-2 text-sm">
        <span className="font-medium">Value</span> <Totals totals={view.totals} />{" "}
        <span className="text-muted-foreground">({plural(view.items.length, "item", "items")})</span>
      </p>

      {(view.warranties.length > 0 || view.restock.length > 0) && (
        <div className="grid gap-3 sm:grid-cols-2">
          {view.warranties.length > 0 && (
            <section aria-labelledby="warranties" className="rounded-lg border border-border p-3">
              <h2 id="warranties" className="text-sm font-medium">
                Warranties ending in the next 90 days
              </h2>
              <ul className="mt-1 flex flex-col gap-0.5 text-sm">
                {view.warranties.map((w) => (
                  <li key={w.path}>
                    <span className="text-muted-foreground">{dayText(w.warranty.slice(0, 10))}</span> <DocLink path={w.path}>{w.title}</DocLink>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {view.restock.length > 0 && (
            <section aria-labelledby="restock" className="rounded-lg border border-border p-3">
              <h2 id="restock" className="text-sm font-medium">
                Running low
              </h2>
              <ul className="mt-1 flex flex-col gap-0.5 text-sm">
                {view.restock.map((r) => (
                  <li key={r.path}>
                    <DocLink path={r.path}>{r.title}</DocLink>{" "}
                    <span className="text-muted-foreground">
                      {r.quantity} left, reorder at {r.reorderAt}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}

      {view.groups ? (
        view.groups.map((g) => (
          <section key={g.key} className="flex flex-col gap-1.5">
            <h2 className="text-base font-medium">
              {g.key} <span className="text-sm font-normal text-muted-foreground">· {plural(g.count, "item", "items")} · </span>
              <span className="text-sm font-normal">
                <Totals totals={g.totals} />
              </span>
            </h2>
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className={tableClass}>
                <caption className="sr-only">Items in {g.key}</caption>
                {head}
                <tbody>{rowsFor(view.items.filter((i) => (i.location?.trail.join(" › ") ?? "(nowhere)") === g.key))}</tbody>
              </table>
            </div>
          </section>
        ))
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className={tableClass}>
            <caption className="sr-only">Everything in the inventory</caption>
            {head}
            <tbody>{rowsFor(view.items)}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}
