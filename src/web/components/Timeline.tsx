import { Paperclip } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { LoadedEntry } from "../../core/layout.ts";
import { DEFAULT_TYPE } from "../../core/entry.ts";
import type { EventType } from "../../core/types.ts";
import { typeFor } from "../../core/types.ts";
import { COPY } from "../copy.ts";
import { dayLabel, fmtAmount, fmtTime, isImage, plural } from "../lib/format.ts";
import { contextFor, embeddedHashes, markdownToText, renderMarkdown } from "../lib/markdown.ts";
import { tagsIn } from "./Composer.tsx";
import type { Attachment } from "../../core/entry.ts";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";

/*
  Pagination.

  The old timeline rendered every matching event into one HTML string on every
  keystroke. A Roll is meant to be kept for years, so that cost grows forever.
  Here a page is a fixed number of events; more are added when the sentinel at
  the bottom scrolls into view, and the count resets whenever the query changes.
  Everything stays in one list, so Cmd+F and "show older" both still work.
*/
const PAGE_SIZE = 40;

export interface TimelineProps {
  entries: LoadedEntry[];
  registry: Map<string, EventType>;
  projectName(slug: string): string;
  attachmentUrl(a: Attachment): string;
  showAuthor: boolean;
  onFilter(key: string, value: string): void;
  emptyState: React.ReactNode;
}

export function Timeline({ entries, registry, projectName, attachmentUrl, showAuthor, onFilter, emptyState }: TimelineProps) {
  const [shown, setShown] = useState(PAGE_SIZE);
  const sentinel = useRef<HTMLDivElement>(null);

  // A new search starts at the top again.
  const key = useMemo(() => entries.map((e) => e.id).join("|").slice(0, 2048) + entries.length, [entries]);
  useEffect(() => setShown(PAGE_SIZE), [key]);

  const visible = entries.slice(0, shown);
  const more = entries.length - visible.length;

  useEffect(() => {
    const node = sentinel.current;
    if (!node || more <= 0) return;
    const observer = new IntersectionObserver(
      (records) => {
        if (records.some((r) => r.isIntersecting)) setShown((n) => n + PAGE_SIZE);
      },
      { rootMargin: "600px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [more]);

  if (!entries.length) return <>{emptyState}</>;

  const days: { label: string; iso: string; entries: LoadedEntry[] }[] = [];
  for (const e of visible) {
    const d = new Date(e.occurred);
    const label = dayLabel(d);
    const last = days[days.length - 1];
    if (last?.label === label) last.entries.push(e);
    else days.push({ label, iso: d.toISOString(), entries: [e] });
  }

  return (
    <div className="flex flex-col gap-7">
      {days.map((day) => (
        <section key={day.iso} aria-labelledby={`day-${day.iso}`}>
          <h2
            id={`day-${day.iso}`}
            className="sticky top-14 z-10 -mx-1 mb-2 bg-background/90 px-1 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground backdrop-blur"
          >
            {day.label}
          </h2>
          <ul className="flex flex-col">
            {day.entries.map((e) => (
              <li key={e.id}>
                <EntryCard
                  entry={e}
                  registry={registry}
                  projectName={projectName}
                  attachmentUrl={attachmentUrl}
                  showAuthor={showAuthor}
                  onFilter={onFilter}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}

      {more > 0 && (
        <div ref={sentinel} className="flex flex-col items-center gap-2 py-4">
          <Button variant="secondary" onClick={() => setShown((n) => n + PAGE_SIZE)}>
            {COPY.loadMore}
          </Button>
          <p className="text-xs text-muted-foreground" role="status" aria-live="polite">
            {COPY.showingCount(visible.length, entries.length)}
          </p>
        </div>
      )}
    </div>
  );
}

interface EntryCardProps {
  entry: LoadedEntry;
  registry: Map<string, EventType>;
  projectName(slug: string): string;
  attachmentUrl(a: Attachment): string;
  showAuthor: boolean;
  onFilter(key: string, value: string): void;
}

export function EntryCard({ entry: e, registry, projectName, attachmentUrl, showAuthor, onFilter }: EntryCardProps) {
  const def = typeFor(registry, e.type);
  // A photo embedded in the text is already on screen; don't show it twice.
  const embedded = embeddedHashes(e.body);
  const images = e.attachments.filter((a) => isImage(a) && !embedded.has(a.hash));
  const rows = fieldRows(e, def).slice(0, 2);
  // A tag written in the text is already shown, and linked, where it was written.
  const inBody = new Set(tagsIn(e.body));
  const tags = e.tags.filter((t) => !inBody.has(t));

  // The whole row is clickable, but the accessible target is a real link: it can
  // be opened in a new tab, copied, and read out as "link" rather than "group".
  return (
    <article className="group relative flex gap-3 rounded-lg px-2 py-3 transition-colors hover:bg-hover focus-within:bg-hover">
      {/*
        The link wraps the time, so it has visible content of its own: a keyboard
        user gets a focus ring they can actually see, and its accessible name
        still describes the event. The ::after overlay makes the rest of the row
        clickable for a mouse without nesting anything inside the link.
      */}
      <a
        href={`#/entry/${encodeURIComponent(e.id)}`}
        className="w-14 shrink-0 rounded pt-0.5 text-xs tabular-nums text-muted-foreground after:absolute after:inset-0 after:content-[''] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <time dateTime={e.occurred}>{fmtTime(e.occurred)}</time>
        <span className="sr-only">. {summaryLine(e, def)}</span>
      </a>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5 empty:hidden">
          {e.type !== DEFAULT_TYPE && (
            <Badge variant="outline" className="relative z-10">
              <span aria-hidden="true">{def.icon}</span>
              {def.label}
            </Badge>
          )}
          {e.projects.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => onFilter("topic", p)}
              className="relative z-10 rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {projectName(p)}
              <span className="sr-only"> — show only this topic</span>
            </button>
          ))}
          {e.amount && (
            <Badge variant="amount" className="relative z-10">
              {fmtAmount(e.amount)}
            </Badge>
          )}
        </div>

        {e.body.trim() && (
          <div
            className="prose-roll mt-1 [&_a]:relative [&_a]:z-10 [&_img]:relative [&_img]:z-10"
            // Sanitized in renderMarkdown; a Roll's text is never trusted.
            dangerouslySetInnerHTML={{ __html: renderMarkdown(clamp(e.body), contextFor(e.attachments, attachmentUrl)) }}
          />
        )}

        {rows.length > 0 && (
          <dl className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {rows.map(([k, v]) => (
              <div key={k} className="flex gap-1">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="text-foreground">{v}</dd>
              </div>
            ))}
          </dl>
        )}

        {images.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {images.slice(0, 4).map((a) => (
              <img
                key={a.hash}
                src={attachmentUrl(a)}
                alt={a.name}
                loading="lazy"
                className="size-20 rounded-md border border-border object-cover"
              />
            ))}
            {images.length > 4 && (
              <span className="flex size-20 items-center justify-center rounded-md border border-border bg-muted text-xs text-muted-foreground">
                +{images.length - 4}
              </span>
            )}
          </div>
        )}

        {(tags.length > 0 || e.attachments.length > 0 || (showAuthor && e.author)) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {e.attachments.length > 0 && (
              <span className="inline-flex items-center gap-1">
                <Paperclip className="size-3" aria-hidden="true" />
                {plural(e.attachments.length, "file", "files")}
              </span>
            )}
            {tags.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => onFilter("tag", t)}
                className="relative z-10 rounded transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                #{t}
                <span className="sr-only"> — show only this tag</span>
              </button>
            ))}
            {showAuthor && e.author && (
              <button
                type="button"
                onClick={() => onFilter("author", e.author)}
                className="relative z-10 rounded transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {e.author}
                <span className="sr-only"> — show only events they logged</span>
              </button>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

/** What a screen reader reads for the link that opens an event. */
function summaryLine(e: LoadedEntry, def: EventType): string {
  const text = markdownToText(e.body).slice(0, 120);
  const bits = [text || def.label];
  if (e.amount) bits.push(fmtAmount(e.amount));
  return bits.join(", ");
}

/** Long entries are trimmed on the timeline; the full text is on the event page. */
function clamp(body: string, max = 600): string {
  if (body.length <= max) return body;
  const cut = body.slice(0, max);
  const end = Math.max(cut.lastIndexOf("\n\n"), cut.lastIndexOf(". "));
  return `${cut.slice(0, end > max / 2 ? end : max)}…`;
}

export function fieldRows(e: LoadedEntry, def: EventType): [string, string][] {
  const rows: [string, string][] = [];
  for (const f of def.fields) {
    const v = e.data[f.key];
    if (v != null && v !== "" && v !== false) rows.push([f.label, fieldValue(f.kind, v)]);
  }
  for (const [k, v] of Object.entries(e.data)) {
    if (def.fields.some((f) => f.key === k) || v == null || v === "") continue;
    rows.push([k.replace(/_/g, " "), typeof v === "object" ? JSON.stringify(v) : String(v)]);
  }
  return rows;
}

export function fieldValue(kind: string, v: unknown): string {
  if (kind === "boolean") return v === true ? "Yes" : "No";
  if (kind === "date") {
    const d = new Date(`${String(v).slice(0, 10)}T12:00:00`);
    return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString([], { dateStyle: "medium" });
  }
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}
