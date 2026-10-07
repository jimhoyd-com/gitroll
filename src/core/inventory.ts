// INVENTORY. A collection of things, with schema.org's names for their fields:
//
//   brand, model, serialNumber, gtin, sku     what it is
//   purchaseDate, price, priceCurrency        when it was bought, and for how much
//   warranty                                  the day the warranty ends
//   location                                  a link to a place record: "[Garage](../places/garage.md)"
//   quantity, reorderAt                       how many are left, and when to buy more
//
// It is not a new kind of file: `.gitroll/notes/inventory/` is a collection like
// any other, and every view here works on any collection whose records use
// these keys. A place is a record too, and its own `within:` link (or
// schema.org's `containedInPlace`) nests it in another ("Shelf 2" within
// "Garage" within "House"); places.ts is the view of the places themselves.

import type { Amount, Entry } from "./entry.ts";
import { resolveLink } from "./entry.ts";
import { addDays, dateField, linkText, metaValue } from "./calendar.ts";
import { priceOf, totalsByCurrency } from "./ledger.ts";
import type { CurrencyTotal } from "./ledger.ts";
import type { Todo } from "./todos.ts";
import { markdownLinkTarget as linkTarget } from "./relations.ts";

export const INVENTORY_COLLECTION = "inventory";

/** The schema.org keys an inventory record may use, in the order a table shows them. */
export const INVENTORY_FIELDS = ["brand", "model", "serialNumber", "gtin", "sku", "purchaseDate", "price", "priceCurrency", "warranty", "location", "quantity", "reorderAt"];

export interface Place {
  /** As written in the record. */
  text: string;
  /** The place record it links to, when it is a link inside the Roll. */
  path: string | null;
  /** The place and everything it is within, outermost first: ["House", "Garage", "Shelf 2"]. */
  trail: string[];
}

export interface InventoryItem {
  path: string;
  title: string;
  brand: string | null;
  model: string | null;
  serialNumber: string | null;
  gtin: string | null;
  sku: string | null;
  purchaseDate: string | null;
  price: Amount | null;
  warranty: string | null;
  location: Place | null;
  quantity: number | null;
  reorderAt: number | null;
  /** price × quantity (a missing quantity counts as one). */
  value: Amount | null;
  /** quantity has fallen to reorderAt or below. */
  restock: boolean;
}

const text = (v: unknown): string | null => {
  if (v == null || v === "") return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return typeof v === "object" ? JSON.stringify(v) : String(v);
};

const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^-?\d+(?:\.\d+)?$/.test(v.trim())) return Number(v.trim());
  return null;
};

/**
 * The place a place is in: its `within:` link, else schema.org's
 * `containedInPlace`. Either is a Markdown link to another place record.
 */
export function parentPlaceValue(meta: Record<string, unknown>): unknown {
  const within = metaValue(meta, "within");
  return typeof within === "string" && within.trim() ? within : metaValue(meta, "containedInPlace");
}

/** Where a thing is: its location field, following each place's `within:` link outwards. */
export function placeOf(from: Entry, docs: Map<string, Entry>, key = "location"): Place | null {
  const raw = metaValue(from.meta, key);
  if (typeof raw !== "string" || !raw.trim()) return null;
  const target = linkTarget(raw);
  const path = target ? resolveLink(from.path, target) : null;
  const trail: string[] = [];
  const seen = new Set<string>();
  let at: Entry | undefined = path ? docs.get(path) : undefined;
  if (!at) trail.push(linkText(raw));
  // Out through `within:` links; a loop or a chain longer than 20 stops rather than spins.
  while (at && !seen.has(at.path) && seen.size < 20) {
    seen.add(at.path);
    trail.unshift(at.title);
    const within = parentPlaceValue(at.meta);
    if (typeof within !== "string" || !within.trim()) break;
    const next = linkTarget(within);
    const nextPath = next ? resolveLink(at.path, next) : null;
    const parent = nextPath ? docs.get(nextPath) : undefined;
    if (!parent) {
      trail.unshift(linkText(within));
      break;
    }
    at = parent;
  }
  return { text: raw, path, trail };
}

/** One record, read as a thing that is kept. `docs` lets places be followed. */
export function inventoryItem(r: Entry, docs: Map<string, Entry>): InventoryItem {
  const price = priceOf(r.meta);
  const quantity = num(metaValue(r.meta, "quantity"));
  const reorderAt = num(metaValue(r.meta, "reorderAt"));
  return {
    path: r.path,
    title: r.title,
    brand: text(metaValue(r.meta, "brand")),
    model: text(metaValue(r.meta, "model")),
    serialNumber: text(metaValue(r.meta, "serialNumber")),
    gtin: text(metaValue(r.meta, "gtin")),
    sku: text(metaValue(r.meta, "sku")),
    purchaseDate: dateField(metaValue(r.meta, "purchaseDate")),
    price,
    warranty: dateField(metaValue(r.meta, "warranty")),
    location: placeOf(r, docs),
    quantity,
    reorderAt,
    value: price ? { value: Math.round(price.value * (quantity ?? 1) * 1e6) / 1e6, currency: price.currency } : null,
    restock: quantity !== null && reorderAt !== null && quantity <= reorderAt,
  };
}

export interface Inventory {
  collection: string;
  items: InventoryItem[];
  /** Total value per currency (never mixed). */
  totals: CurrencyTotal[];
  /** With --by location: each place, its items' total value and count. */
  groups?: { key: string; totals: CurrencyTotal[]; count: number }[];
  /** Warranties ending between today and `warrantyDays` from now, soonest first. */
  warranties: { path: string; title: string; warranty: string }[];
  /** Items to buy more of: quantity at or under reorderAt. */
  restock: { path: string; title: string; quantity: number; reorderAt: number }[];
}

/** The inventory view over some records. `docs` is every document, so links to places resolve. */
export function inventory(records: Entry[], docs: Entry[], opts: { collection?: string; by?: string; today: string; warrantyDays?: number }): Inventory {
  const byPath = new Map(docs.map((d) => [d.path, d]));
  const items = records.map((r) => inventoryItem(r, byPath));
  const until = addDays(opts.today, opts.warrantyDays ?? 90);
  const out: Inventory = {
    collection: opts.collection ?? INVENTORY_COLLECTION,
    items,
    totals: totalsByCurrency(items.flatMap((i) => (i.value ? [i.value] : []))),
    warranties: items
      .filter((i) => i.warranty && i.warranty.slice(0, 10) >= opts.today && i.warranty.slice(0, 10) <= until)
      .map((i) => ({ path: i.path, title: i.title, warranty: i.warranty! }))
      .sort((a, b) => a.warranty.localeCompare(b.warranty)),
    restock: items.filter((i) => i.restock).map((i) => ({ path: i.path, title: i.title, quantity: i.quantity!, reorderAt: i.reorderAt! })),
  };
  if (opts.by) {
    const field = opts.by.toLowerCase();
    const groups = new Map<string, InventoryItem[]>();
    for (const i of items) {
      const key = field === "location" ? (i.location?.trail.join(" › ") ?? "(nowhere)") : (text(metaValue(byPath.get(i.path)?.meta ?? {}, opts.by)) ?? "(none)");
      groups.set(key, [...(groups.get(key) ?? []), i]);
    }
    out.groups = [...groups]
      .sort((a, b) => (a[0].startsWith("(") ? 1 : 0) - (b[0].startsWith("(") ? 1 : 0) || a[0].localeCompare(b[0]))
      .map(([key, xs]) => ({ key, totals: totalsByCurrency(xs.flatMap((i) => (i.value ? [i.value] : []))), count: xs.length }));
  }
  return out;
}

/** A to-do that isn't written anywhere: worked out from a record whose quantity is at or under its reorderAt. */
export interface DerivedTodo extends Todo {
  title: string;
  derived: true;
  line: 0;
}

/**
 * Restock to-dos for every record (in any collection) that is running low.
 * They are derived on read, the way backlinks are, and never written to a file;
 * raising `quantity` is what makes one go away.
 */
export function restockTodos(docs: Entry[]): DerivedTodo[] {
  const out: DerivedTodo[] = [];
  for (const d of docs) {
    const quantity = num(metaValue(d.meta, "quantity"));
    const reorderAt = num(metaValue(d.meta, "reorderAt"));
    if (quantity === null || reorderAt === null || quantity > reorderAt) continue;
    out.push({ path: d.path, line: 0, text: `Restock ${d.title} (${quantity} left, reorder at ${reorderAt})`, done: false, title: d.title, derived: true });
  }
  return out;
}
