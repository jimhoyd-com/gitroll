// The buttons under the search box: Today, This month, This year — and
// whatever else a Roll wants there.
//
// A quick filter is a search somebody runs often enough to deserve one click.
// Which searches those are is not something GitRoll can know: a Roll for a
// rental has different ones from a Roll about a service, and the defaults are
// only a guess at a common case. So they are a list in the Roll's own config,
// and the defaults apply to a Roll that hasn't said otherwise.

/** The ones GitRoll knows how to compute. A date chip can't be a fixed query: "today" moves. */
export type BuiltInFilter = "today" | "this-month" | "this-year" | "has-photo";

export type QuickFilter =
  | { kind: BuiltInFilter; label: string }
  /** Anything else somebody wants a button for, as a label and a search. */
  | { kind: "custom"; label: string; query: string };

const BUILT_IN: Record<BuiltInFilter, string> = {
  today: "Today",
  "this-month": "This month",
  "this-year": "This year",
  "has-photo": "With a photo",
};

/** The names a person might reasonably write for a built-in one. */
const NAMES: Record<string, BuiltInFilter> = {
  today: "today",
  "this-month": "this-month",
  "this month": "this-month",
  month: "this-month",
  "this-year": "this-year",
  "this year": "this-year",
  year: "this-year",
  "has-photo": "has-photo",
  "has:photo": "has-photo",
  "with a photo": "has-photo",
  photo: "has-photo",
};

/**
 * What a Roll gets when it says nothing.
 *
 * Three date ranges, and not "With a photo": most Rolls are mostly words, and a
 * button that matches almost nothing in yours is a button in the way. A Roll
 * that keeps photos can put it back in one line.
 */
export const DEFAULT_FILTERS: BuiltInFilter[] = ["today", "this-month", "this-year"];

const filterFor = (id: BuiltInFilter): QuickFilter => ({ kind: id, label: BUILT_IN[id] });

/**
 * Reads `filters:` from a Roll's config.
 *
 * A string is one of GitRoll's own by name, or — when it isn't one — a search,
 * used as both the button and the query. An object is a label and a search of
 * your own. An empty list means no buttons at all, which is a legitimate thing
 * to want; leaving the key out gets the defaults.
 */
export function parseFilters(raw: unknown): QuickFilter[] {
  if (raw === undefined || raw === null) return DEFAULT_FILTERS.map(filterFor);
  if (raw === false) return [];
  if (typeof raw === "string") return parseFilters([raw]);
  if (!Array.isArray(raw)) return DEFAULT_FILTERS.map(filterFor);

  const out: QuickFilter[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      const text = item.trim();
      if (!text) continue;
      const known = NAMES[text.toLowerCase()];
      out.push(known ? filterFor(known) : { kind: "custom", label: text, query: text });
      continue;
    }
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const spec = item as Record<string, unknown>;
      const query = typeof spec.query === "string" ? spec.query.trim() : "";
      const label = typeof spec.label === "string" && spec.label.trim() ? spec.label.trim() : query;
      if (query) out.push({ kind: "custom", label, query });
    }
  }
  return out;
}
