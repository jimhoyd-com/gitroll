// Searching, and the look at whichever result is chosen. On a wide terminal the
// two sit side by side, because reading an event shouldn't cost the list.

import type { LoadedEntry } from "../../../core/layout.ts";
import { formatAmount } from "../../../core/util.ts";
import { Input, bold, caret, dim, fit, pad, when, wrap } from "../text.ts";
import { list, note, row } from "./chrome.ts";
import type { Names, Scrolled } from "./chrome.ts";

/** Where the list stops and the preview starts. Below this there is only room for one. */
const SIDE_BY_SIDE = 100;

export interface FindView {
  query: Input;
  results: LoadedEntry[];
  total: number;
  selected: number;
  scroll: number;
  names: Names;
  width: number;
  rows: number;
}

export function find(v: FindView): Scrolled {
  const head = [
    ` Find: ${caret(v.query.value, v.query.cursor, v.width - 9)}`,
    dim(fit(`  ${v.results.length} of ${v.total} · filters: topic: tag: type: after: before: amount:>100 has:photo`, v.width)),
  ];
  if (!v.results.length) {
    return {
      lines: [
        ...head,
        "",
        ...note("Nothing found. Search reads what you wrote — an entry's words, its topics, tags, amount, front matter and the names of the files attached to it — and not what is inside those files.", v.width),
        ...note("It looks at this Roll as it is now: not other Rolls, not deleted entries, not older versions. Esc clears the search.", v.width),
      ],
      scroll: v.scroll,
    };
  }
  const side = v.width >= SIDE_BY_SIDE;
  const listWidth = side ? Math.floor(v.width * 0.52) : v.width;
  const height = v.rows - head.length;
  const { lines, scroll } = list(v.results.map((e) => row(e, listWidth, v.names)), v.selected, v.scroll, listWidth, height);
  if (!side) {
    const chosen = v.results[v.selected];
    return { lines: [...head, ...lines, ...(chosen ? [dim("─".repeat(v.width)), ...preview(chosen, v.width, 3, v.names)] : [])], scroll };
  }
  const beside = preview(v.results[v.selected], v.width - listWidth - 3, height, v.names);
  const body = Array.from({ length: height }, (_, i) => `${pad(lines[i] ?? "", listWidth)} ${dim("│")} ${beside[i] ?? ""}`);
  return { lines: [...head, ...body], scroll };
}

/** A short read-only look at an event, for the side of the search screen. */
export function preview(e: LoadedEntry | undefined, w: number, rows: number, names: Names): string[] {
  if (!e) return [];
  const out = [bold(fit(when(e.date), w)), ...(e.projects.length ? [dim(fit(e.projects.map(names).join(" · "), w))] : []), ""];
  for (const l of wrap(e.body || "(no text)", w)) out.push(fit(l, w));
  if (e.amount) out.push(dim(fit(`Amount: ${formatAmount(e.amount)}`, w)));
  if (e.tags.length) out.push(dim(fit(e.tags.map((t) => `#${t}`).join(" "), w)));
  for (const a of e.attachments) out.push(dim(fit(`File: ${a.name}`, w)));
  return out.slice(0, rows);
}
