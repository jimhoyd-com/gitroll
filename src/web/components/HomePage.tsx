import { ArrowRight, Building2, CalendarDays, CircleAlert, ListTodo, MapPin, NotebookText, Package, Paperclip, Pin, Rows3, Table2, Users, Wallet } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type * as React from "react";
import { linksAsText } from "../../core/entry.ts";
import { collections } from "../../core/fields.ts";
import { issues, withoutResolved } from "../../core/issues.ts";
import type { LoadedEntry } from "../../core/layout.ts";
import { isPinned } from "../../core/pins.ts";
import { upcomingWithReminders } from "../../core/reminders.ts";
import { taskDates } from "../../core/calendar.ts";
import { formatAmount, isoDate } from "../../core/util.ts";
import type { FileItem, ViewsData } from "../store.ts";
import { recordsHref } from "../hooks/useStore.ts";
import { message, plural } from "../lib/format.ts";
import { DocLink, LinkedText, dayText, shortPath } from "./ViewParts.tsx";
import { TodoBox } from "./UpcomingPage.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card.tsx";
import { useToast } from "./ui/toast.tsx";

/*
  Home: the whole Roll at a glance.

  A Roll is more than its timeline, so the page it opens on shows a little of
  everything in it: what's pinned, what's coming up, what's left to do, open
  issues, the latest events, this month's money, and every collection of
  records with the people, places, things and files among them. Each card
  links to the page that has the rest. Everything is worked out by the same
  functions in src/core the command line uses.
*/

const isEvent = (e: LoadedEntry) => e.path.toLowerCase().startsWith(".gitroll/events/");
/** Collections with a page of their own rather than a plain table. */
export const OWN_PAGES: Record<string, { href: string; label: string; icon: LucideIcon }> = {
  people: { href: "#/contacts", label: "Contacts", icon: Users },
  organizations: { href: "#/organizations", label: "Organizations", icon: Building2 },
  places: { href: "#/places", label: "Places", icon: MapPin },
  inventory: { href: "#/inventory", label: "Inventory", icon: Package },
};

export function HomePage({
  name,
  entries,
  docs,
  views,
  onMark,
}: {
  name: string;
  /** Events only. */
  entries: LoadedEntry[];
  /** Events, notes and files' sidecars. */
  docs: LoadedEntry[];
  views: ViewsData;
  onMark(path: string, line: number, done: boolean): Promise<void>;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState("");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const today = isoDate(new Date(now));

  const sources = useMemo(() => withoutResolved(docs, views.todos), [docs, views.todos]);
  const coming = useMemo(() => upcomingWithReminders(sources.docs, sources.todos, today, 14, new Date(now)), [sources, today, now]);
  const todos = useMemo(() => sources.todos.filter((t) => !t.done), [sources]);
  const openIssues = useMemo(() => issues(docs, docs, today).issues, [docs, today]);
  const pinned = useMemo(() => docs.filter(isPinned), [docs]);
  const recent = useMemo(
    () =>
      entries
        .filter(isEvent)
        .slice()
        .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))
        .slice(0, 5),
    [entries],
  );
  const month = today.slice(0, 7);
  const spent = useMemo(() => {
    const totals = new Map<string, number>();
    for (const e of entries) if (e.amount && (e.date ?? "").startsWith(month)) totals.set(e.amount.currency, (totals.get(e.amount.currency) ?? 0) + e.amount.value);
    return [...totals].map(([currency, value]) => formatAmount({ currency, value }));
  }, [entries, month]);
  const groups = useMemo(() => collections(views.notes), [views.notes]);
  const loose = useMemo(() => views.notes.filter((n) => !n.path.slice(".gitroll/notes/".length).includes("/")).length, [views.notes]);

  const mark = async (path: string, line: number) => {
    setBusy(`${path}:${line}`);
    try {
      await onMark(path, line, true);
      toast.toast("Done. It's a one-character change, committed.");
    } catch (err) {
      toast.error(message(err));
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">{name}</h1>
        <p className="text-sm text-muted-foreground">
          {[plural(entries.length, "event", "events"), plural(views.notes.length, "note", "notes"), plural(todos.length, "open to-do", "open to-dos"), plural(views.files.length, "file", "files")].join(" · ")}
        </p>
      </div>

      {pinned.length > 0 && (
        <Card aria-labelledby="home-pinned">
          <CardHeader>
            <CardTitle id="home-pinned">
              <Pin className="size-4" aria-hidden="true" />
              Pinned
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-wrap gap-2">
              {pinned.map((p) => (
                <li key={p.path}>
                  <DocLink path={p.path} className="inline-flex rounded-md border border-border px-2.5 py-1 text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                    {p.title}
                  </DocLink>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 [&>*]:min-w-0">
        <Card aria-labelledby="home-coming">
          <CardHeader>
            <CardTitle id="home-coming">
              <CalendarDays className="size-4" aria-hidden="true" />
              Next two weeks
            </CardTitle>
            <More href="#/upcoming" label="Upcoming" />
          </CardHeader>
          <CardContent>
            {coming.length === 0 ? (
              <Quiet>Nothing dated in the next 14 days.</Quiet>
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {coming.slice(0, 6).map((i) => (
                  <li key={`${i.kind}:${i.path}:${i.line ?? ""}:${i.date}:${i.field ?? ""}`} className="flex items-baseline justify-between gap-3 py-1.5 text-sm">
                    <span className="min-w-0 truncate">
                      {i.kind === "todo" || i.kind === "reminder" ? linksAsText(i.title) : <DocLink path={i.path}>{i.title}</DocLink>}
                      {i.field && <span className="text-muted-foreground">: {i.field}</span>}
                    </span>
                    <span className={i.overdue || i.due ? "shrink-0 text-xs text-destructive" : "shrink-0 text-xs text-muted-foreground"}>
                      {i.kind === "reminder" ? "⏰ " : ""}
                      {i.overdue ? "overdue" : i.due ? "due now" : dayText(i.date)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card aria-labelledby="home-todos">
          <CardHeader>
            <CardTitle id="home-todos">
              <ListTodo className="size-4" aria-hidden="true" />
              To-dos
              <span className="font-normal text-muted-foreground">{todos.length}</span>
            </CardTitle>
            <More href="#/upcoming" label="All to-dos" />
          </CardHeader>
          <CardContent>
            {todos.length === 0 ? (
              <Quiet>Nothing to do. A to-do is a line like - [ ] Call the plumber, in any event or note.</Quiet>
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {todos.slice(0, 6).map((t) => {
                  const key = `${t.path}:${t.line}`;
                  const { text } = taskDates(t.text);
                  return (
                    <li key={key} className="flex items-start gap-2 py-1.5">
                      <TodoBox label={linksAsText(text || t.text)} checked={busy === key} disabled={busy === key} onChange={() => void mark(t.path, t.line)} />
                      <span className="min-w-0 flex-1 text-sm">
                        <LinkedText text={t.text} from={t.path} />
                        <span className="block text-xs text-muted-foreground">in {t.title || shortPath(t.path)}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card aria-labelledby="home-recent">
          <CardHeader>
            <CardTitle id="home-recent">
              <Rows3 className="size-4" aria-hidden="true" />
              Latest events
            </CardTitle>
            <More href="#/timeline" label="Timeline" />
          </CardHeader>
          <CardContent>
            {recent.length === 0 ? (
              <Quiet>Nothing logged yet. New, then Event, logs the first one.</Quiet>
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {recent.map((e) => (
                  <li key={e.path} className="flex items-baseline justify-between gap-3 py-1.5 text-sm">
                    <DocLink path={e.path} className="min-w-0 truncate rounded underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                      {e.title}
                    </DocLink>
                    <span className="shrink-0 text-xs text-muted-foreground">{e.date ? dayText(e.date.slice(0, 10)) : ""}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card aria-labelledby="home-issues">
          <CardHeader>
            <CardTitle id="home-issues">
              <CircleAlert className="size-4" aria-hidden="true" />
              Open issues
              <span className="font-normal text-muted-foreground">{openIssues.length}</span>
            </CardTitle>
            <More href="#/issues" label="Issues" />
          </CardHeader>
          <CardContent>
            {openIssues.length === 0 ? (
              <Quiet>No open issues. An event or note with issue: open is one until it's resolved.</Quiet>
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {openIssues.slice(0, 5).map((i) => (
                  <li key={i.path} className="flex items-baseline justify-between gap-3 py-1.5 text-sm">
                    <DocLink path={i.path} className="min-w-0 truncate rounded underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                      {i.title}
                    </DocLink>
                    <span className="shrink-0 text-xs text-muted-foreground">{i.age !== null ? `open ${plural(i.age, "day", "days")}` : "open"}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <Card aria-labelledby="home-kept">
        <CardHeader>
          <div className="flex flex-col gap-1.5">
            <CardTitle id="home-kept">
              <Table2 className="size-4" aria-hidden="true" />
              Kept in this Roll
            </CardTitle>
            <CardDescription>Notes, collections of records, money and files.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 [&>*]:min-w-0">
            <Tile href="#/notes" icon={NotebookText} label="Notes" detail={plural(loose, "page", "pages")} />
            {groups.map((g) => {
              const own = OWN_PAGES[g.name.toLowerCase()];
              return (
                <Tile
                  key={g.name}
                  href={own?.href ?? recordsHref(g.name)}
                  icon={own?.icon ?? Table2}
                  label={own?.label ?? g.name}
                  detail={plural(g.records, "record", "records")}
                />
              );
            })}
            <Tile href="#/ledger" icon={Wallet} label="Ledger" detail={spent.length ? `${spent.join(", ")} this month` : "Nothing spent this month"} />
            <Tile href="#/files" icon={Paperclip} label="Files" detail={filesDetail(views.files)} />
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

function filesDetail(files: FileItem[]): string {
  const unfiled = files.filter((f) => f.unfiled).length;
  return unfiled ? `${plural(files.length, "file", "files")}, ${unfiled} unfiled` : plural(files.length, "file", "files");
}

function Tile({ href, icon: Icon, label, detail }: { href: string; icon: LucideIcon; label: string; detail: string }) {
  return (
    <li>
      <a
        href={href}
        className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5 transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
          <Icon className="size-4" aria-hidden="true" />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium">{label}</span>
          <span className="truncate text-xs text-muted-foreground">{detail}</span>
        </span>
      </a>
    </li>
  );
}

function More({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      className="inline-flex shrink-0 items-center gap-1 rounded text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      {label}
      <ArrowRight className="size-3" aria-hidden="true" />
    </a>
  );
}

function Quiet({ children }: { children: React.ReactNode }) {
  return <p className="py-1 text-sm text-muted-foreground">{children}</p>;
}
