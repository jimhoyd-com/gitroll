import {
  Bookmark,
  Building2,
  CalendarDays,
  CircleAlert,
  GitMerge,
  Hash,
  Keyboard,
  Link2,
  MapPin,
  NotebookText,
  Package,
  Paperclip,
  Rows3,
  Table2,
  Trash2,
  TrendingUp,
  Users,
  Wallet,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useMemo } from "react";
import type * as React from "react";
import { collections } from "../../core/fields.ts";
import type { LoadedEntry } from "../../core/layout.ts";
import { formatAmount, isoDate } from "../../core/util.ts";
import { COPY } from "../copy.ts";
import { recordsHref, timelineHref } from "../hooks/useStore.ts";
import { plural } from "../lib/format.ts";
import type { FileItem, ViewsData } from "../store.ts";

/*
  The Library: everything a Roll keeps, to browse rather than to search.

  Home is for doing (one box that finds and records, and what needs you now);
  this is for looking around. Every collection is here, the views worked out
  from them (timeline, calendar, money, charts, issues, topics), the files,
  saved searches, and the Roll's own housekeeping. Each tile says how much is
  in it, so an empty one reads as empty rather than broken.
*/

/** Collections with a page of their own rather than a plain table. */
export const OWN_PAGES: Record<string, { href: string; label: string; icon: LucideIcon }> = {
  people: { href: "#/contacts", label: "Contacts", icon: Users },
  organizations: { href: "#/organizations", label: "Organizations", icon: Building2 },
  places: { href: "#/places", label: "Places", icon: MapPin },
  inventory: { href: "#/inventory", label: "Inventory", icon: Package },
  bookmarks: { href: "#/bookmarks", label: "Bookmarks", icon: Link2 },
};

export function LibraryPage({
  entries,
  views,
  counts,
  savedSearches,
  onShortcuts,
}: {
  /** Events only. */
  entries: LoadedEntry[];
  /** Null where the store reads only events. */
  views: ViewsData | null;
  counts: { todos: number | null; issues: number | null; conflicts: number };
  savedSearches: [string, string][];
  onShortcuts(): void;
}) {
  const month = isoDate().slice(0, 7);
  const spent = useMemo(() => {
    const totals = new Map<string, number>();
    for (const e of entries) if (e.amount && (e.date ?? "").startsWith(month)) totals.set(e.amount.currency, (totals.get(e.amount.currency) ?? 0) + e.amount.value);
    return [...totals].map(([currency, value]) => formatAmount({ currency, value }));
  }, [entries, month]);
  const groups = useMemo(() => (views ? collections(views.notes) : []), [views]);
  const loose = useMemo(() => (views ? views.notes.filter((n) => !n.path.slice(".gitroll/notes/".length).includes("/")).length : 0), [views]);
  const own = groups.filter((g) => OWN_PAGES[g.name.toLowerCase()]);
  const tables = groups.filter((g) => !OWN_PAGES[g.name.toLowerCase()]);

  return (
    <div className="flex flex-col gap-8">
      <h1 className="large-title">Library</h1>

      <Shelf title="Views">
        <Tile href="#/timeline" icon={Rows3} label="Timeline" detail={plural(entries.length, "event", "events")} />
        {views && <Tile href="#/upcoming" icon={CalendarDays} label="Calendar & to-dos" detail={counts.todos ? plural(counts.todos, "open to-do", "open to-dos") : "Nothing open"} />}
        {views && <Tile href="#/ledger" icon={Wallet} label="Money" detail={spent.length ? `${spent.join(", ")} this month` : "Nothing spent this month"} />}
        {views && <Tile href="#/series" icon={TrendingUp} label="Charts" detail="Numbers over time" />}
        {views && <Tile href="#/issues" icon={CircleAlert} label="Issues" detail={counts.issues ? `${counts.issues} open` : "None open"} />}
        <Tile href="#/topics" icon={Hash} label={COPY.topics} detail="Projects and tags" />
      </Shelf>

      {views && (
        <Shelf title="Collections">
          <Tile href="#/notes" icon={NotebookText} label="Notes" detail={plural(loose, "page", "pages")} />
          {own.map((g) => {
            const page = OWN_PAGES[g.name.toLowerCase()];
            return <Tile key={g.name} href={page.href} icon={page.icon} label={page.label} detail={plural(g.records, "record", "records")} />;
          })}
          {tables.map((g) => (
            <Tile key={g.name} href={recordsHref(g.name)} icon={Table2} label={g.name} detail={plural(g.records, "record", "records")} />
          ))}
          <Tile href="#/records" icon={Table2} label="All collections" detail="Start a new one" />
          <Tile href="#/files" icon={Paperclip} label="Files" detail={filesDetail(views.files)} />
        </Shelf>
      )}

      {savedSearches.length > 0 && (
        <Shelf title="Saved searches">
          {savedSearches.map(([key, q]) => (
            <Tile key={key} href={timelineHref(`@${key}`)} icon={Bookmark} label={key} detail={q} />
          ))}
        </Shelf>
      )}

      <Shelf title="This Roll">
        {counts.conflicts > 0 && <Tile href="#/conflicts" icon={GitMerge} label="Conflicts" detail={plural(counts.conflicts, "to settle", "to settle")} />}
        <Tile href="#/deleted" icon={Trash2} label="Deleted" detail="Put something back" />
        <li>
          <button type="button" onClick={onShortcuts} className={tileClass}>
            <TileBody icon={Keyboard} label={COPY.shortcutsTitle} detail="Press ? anywhere" />
          </button>
        </li>
      </Shelf>
    </div>
  );
}

function filesDetail(files: FileItem[]): string {
  const unfiled = files.filter((f) => f.unfiled).length;
  return unfiled ? `${plural(files.length, "file", "files")}, ${unfiled} unfiled` : plural(files.length, "file", "files");
}

function Shelf({ title, children }: { title: string; children: React.ReactNode }) {
  const id = `library-${title.toLowerCase().replace(/\W+/g, "-")}`;
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <h2 id={id} className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 [&>*]:min-w-0">{children}</ul>
    </section>
  );
}

const tileClass =
  "flex w-full items-center gap-3 rounded-xl bg-card px-3 py-2.5 text-left shadow-surface transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

function Tile({ href, icon, label, detail }: { href: string; icon: LucideIcon; label: string; detail: string }) {
  return (
    <li>
      <a href={href} className={tileClass}>
        <TileBody icon={icon} label={label} detail={detail} />
      </a>
    </li>
  );
}

function TileBody({ icon: Icon, label, detail }: { icon: LucideIcon; label: string; detail: string }) {
  return (
    <>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium">{label}</span>
        <span className="truncate text-xs text-muted-foreground">{detail}</span>
      </span>
    </>
  );
}
