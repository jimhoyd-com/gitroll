import { useId, useMemo, useState } from "react";
import type { LoadedEntry } from "../../core/layout.ts";
import { SearchIndex } from "../../core/search.ts";
import { formatReading, numericFields, series } from "../../core/series.ts";
import type { SeriesBy, SeriesPoint, SeriesSummary } from "../../core/series.ts";
import { plural } from "../lib/format.ts";
import { navigate } from "../hooks/useStore.ts";
import { DocLink, Empty, PageHeader, dayText, shortPath, tableClass, tdClass, thClass } from "./ViewParts.tsx";
import { Button } from "./ui/button.tsx";
import { Input, Label } from "./ui/input.tsx";
import { QueryError, useSavedQuery } from "./SavedSearches.tsx";

const GROUPS: { by: SeriesBy | ""; label: string }[] = [
  { by: "", label: "Every reading" },
  { by: "week", label: "By week" },
  { by: "month", label: "By month" },
  { by: "year", label: "By year" },
];

export const seriesHref = (field: string) => (field ? `#/series/${encodeURIComponent(field)}` : "#/series");

/**
 * One number field over time: an odometer, a weight, a meter. Every dated event
 * or note with a number in the field is a reading; grouping keeps the last
 * reading in each period. Worked out by the same code as `gitroll series`.
 */
export function SeriesPage({ docs, field: wanted }: { docs: LoadedEntry[]; field: string }) {
  const fields = useMemo(() => numericFields(docs), [docs]);
  const field = fields.find((f) => f.name.toLowerCase() === wanted.toLowerCase())?.name ?? wanted ?? "";
  const chosen = field || fields[0]?.name || "";
  const [by, setBy] = useState<SeriesBy | "">("");
  const [query, setQuery] = useState("");
  const saved = useSavedQuery(query);
  const view = useMemo(() => {
    if (!chosen) return null;
    const filtered = saved.query.trim() ? new SearchIndex(docs).search(saved.query) : docs;
    return series(filtered, chosen, by || null);
  }, [docs, chosen, by, saved.query]);

  if (!fields.length && !wanted) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Series" description="A number field followed over time, like an odometer, a weight or a meter reading." />
        <Empty title="No dated numbers yet" command="gitroll log 'Filled up' && gitroll set <file> odometer=48210">
          Give dated events or notes the same number field, like odometer: 48210 in their front matter, and it is drawn here.
        </Empty>
      </div>
    );
  }

  const skipped = view ? view.skipped.items.length : 0;
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Series" description="A number field followed over time from the dated events and notes that have it. Money is only compared within one currency." />

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="series-field">Field</Label>
          <select
            id="series-field"
            value={chosen}
            onChange={(e) => navigate(seriesHref(e.target.value))}
            className="h-9 rounded-md border border-input bg-card px-2 text-sm text-foreground shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-sm:text-base"
          >
            {!fields.some((f) => f.name === chosen) && <option value={chosen}>{chosen}</option>}
            {fields.map((f) => (
              <option key={f.name} value={f.name}>
                {f.name} ({f.count})
              </option>
            ))}
          </select>
        </div>
        <div className="flex min-w-48 flex-1 flex-col gap-1.5">
          <Label htmlFor="series-q">Filter</Label>
          <Input id="series-q" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="tag:car after:2026-01-01" />
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

      {!view || !view.points.length ? (
        <Empty title={`Nothing dated has a number in ${chosen}`}>Only events and notes with a date and a number in this field are drawn.</Empty>
      ) : (
        view.summaries.map((s) => (
          <Unit key={s.currency ?? ""} field={view.field} summary={s} points={view.points.filter((p) => p.currency === s.currency)} grouped={!!view.by} />
        ))
      )}

      {view && view.summaries.length > 1 && <p className="text-sm text-muted-foreground">Each currency is a series of its own; nothing is converted.</p>}

      {view && skipped > 0 && (
        <details className="rounded-lg border border-border bg-muted px-3 py-2 text-sm">
          <summary className="cursor-pointer">
            {plural(skipped, "document", "documents")} with {view.field} left out:{" "}
            {[view.skipped.notNumeric ? `${view.skipped.notNumeric} not a number` : "", view.skipped.undated ? `${view.skipped.undated} with no date` : ""].filter(Boolean).join(", ")}
          </summary>
          <ul className="mt-2 flex flex-col gap-1">
            {view.skipped.items.map((i) => (
              <li key={i.path}>
                <DocLink path={i.path}>{i.title || shortPath(i.path)}</DocLink> <span className="text-muted-foreground">({i.reason})</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function Unit({ field, summary: s, points, grouped }: { field: string; summary: SeriesSummary; points: SeriesPoint[]; grouped: boolean }) {
  const unit = s.currency;
  const read = (n: number, signed = false) => formatReading(n, unit, { signed });
  const rate = (n: number) => formatReading(n, unit, { signed: true, digits: 2 });
  const name = unit ? `${field} (${unit})` : field;
  const newestFirst = [...points].reverse();
  return (
    <section className="flex flex-col gap-3" aria-label={name}>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-lg border border-border bg-muted px-3 py-2 text-sm sm:grid-cols-4">
        <Stat term="Last" value={read(s.last.value)} note={dayText(s.last.date)} />
        <Stat term="Change" value={read(s.change, true)} note={`over ${plural(s.days, "day", "days")}`} />
        <Stat term="Range" value={`${read(s.min.value)} – ${read(s.max.value)}`} note={plural(s.count, "reading", "readings")} />
        <Stat term="Rate" value={s.perMonth !== null ? `${rate(s.perMonth)} a month` : s.perDay !== null ? `${rate(s.perDay)} a day` : "—"} note={s.perMonth !== null && s.perDay !== null ? `${rate(s.perDay)} a day` : ""} />
      </dl>

      <Chart name={name} points={points} unit={unit} />

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className={tableClass}>
          <caption className="sr-only">
            {name}, {grouped ? "the last reading in each period" : "every reading"}, newest first
          </caption>
          <thead>
            <tr>
              <th scope="col" className={thClass}>
                {grouped ? "Period" : "Date"}
              </th>
              <th scope="col" className={thClass}>
                From
              </th>
              <th scope="col" className={`${thClass} text-right`}>
                {field}
              </th>
            </tr>
          </thead>
          <tbody>
            {newestFirst.map((p) => (
              <tr key={`${p.path}:${p.period ?? ""}`}>
                <td className={`${tdClass} whitespace-nowrap text-muted-foreground`}>{grouped ? p.period : dayText(p.date)}</td>
                <th scope="row" className={`${tdClass} text-left font-normal`}>
                  <DocLink path={p.path}>{p.title || shortPath(p.path)}</DocLink>
                  {grouped && (p.readings ?? 1) > 1 && <span className="text-xs text-muted-foreground"> (last of {p.readings})</span>}
                </th>
                <td className={`${tdClass} whitespace-nowrap text-right tabular-nums`}>{read(p.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Stat({ term, value, note }: { term: string; value: string; note?: string }) {
  return (
    <div className="flex flex-col py-1">
      <dt className="text-xs text-muted-foreground">{term}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
      {note && <dd className="text-xs text-muted-foreground">{note}</dd>}
    </div>
  );
}

const W = 640;
const H = 200;
const PAD = { top: 14, right: 14, bottom: 30, left: 76 };

const dayNumber = (date: string) => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / 86_400_000;

/** A small line chart. It is a picture of the table under it, which says the same in words. */
function Chart({ name, points, unit }: { name: string; points: SeriesPoint[]; unit: string | null }) {
  const titleId = useId();
  const xs = points.map((p) => dayNumber(p.date));
  const ys = points.map((p) => p.value);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  const sx = (x: number) => PAD.left + (x1 === x0 ? (W - PAD.left - PAD.right) / 2 : ((x - x0) / (x1 - x0)) * (W - PAD.left - PAD.right));
  const sy = (y: number) => PAD.top + (y1 === y0 ? (H - PAD.top - PAD.bottom) / 2 : (1 - (y - y0) / (y1 - y0)) * (H - PAD.top - PAD.bottom));
  const line = points.map((p, i) => `${sx(xs[i]).toFixed(1)},${sy(p.value).toFixed(1)}`).join(" ");
  const first = points[0];
  const last = points[points.length - 1];
  const label = `${name}: ${formatReading(first.value, unit)} on ${first.date.slice(0, 10)} to ${formatReading(last.value, unit)} on ${last.date.slice(0, 10)}, lowest ${formatReading(y0, unit)}, highest ${formatReading(y1, unit)}. The table below lists every point.`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={titleId} className="h-auto w-full rounded-lg border border-border bg-card">
      <title id={titleId}>{label}</title>
      <g className="text-border" stroke="currentColor" strokeWidth="1">
        <line x1={PAD.left} y1={sy(y1)} x2={W - PAD.right} y2={sy(y1)} />
        <line x1={PAD.left} y1={sy(y0)} x2={W - PAD.right} y2={sy(y0)} />
      </g>
      <g className="fill-muted-foreground text-[11px] max-sm:text-[19px]" aria-hidden="true">
        <text x={PAD.left - 6} y={sy(y1)} textAnchor="end" dominantBaseline="middle">
          {formatReading(y1)}
        </text>
        {y1 !== y0 && (
          <text x={PAD.left - 6} y={sy(y0)} textAnchor="end" dominantBaseline="middle">
            {formatReading(y0)}
          </text>
        )}
        <text x={PAD.left} y={H - 6} textAnchor="start">
          {first.date.slice(0, 10)}
        </text>
        {points.length > 1 && (
          <text x={W - PAD.right} y={H - 6} textAnchor="end">
            {last.date.slice(0, 10)}
          </text>
        )}
      </g>
      <g className="text-link" aria-hidden="true">
        {points.length > 1 && <polyline points={line} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />}
        {points.length <= 120 && points.map((p, i) => <circle key={`${p.path}:${i}`} cx={sx(xs[i])} cy={sy(p.value)} r="3" fill="currentColor" />)}
      </g>
    </svg>
  );
}
