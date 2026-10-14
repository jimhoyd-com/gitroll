import { AlarmClock, Bookmark, CircleAlert, CornerDownLeft, File, ListTodo, NotebookText, Pin, Rows3, Search, Table2, Wallet } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type * as React from "react";
import { linksAsText } from "../../core/entry.ts";
import { collectionOf, isCollectionReadme } from "../../core/fields.ts";
import { issues, withoutResolved } from "../../core/issues.ts";
import type { LoadedEntry } from "../../core/layout.ts";
import { isPinned } from "../../core/pins.ts";
import { QUICK_KINDS, QUICK_LABELS, readQuick } from "../../core/quick.ts";
import type { Quick, QuickKind } from "../../core/quick.ts";
import { upcomingWithReminders } from "../../core/reminders.ts";
import { taskDates } from "../../core/calendar.ts";
import { SearchIndex } from "../../core/search.ts";
import { formatAmount, isoDate, slugify } from "../../core/util.ts";
import type { ViewsData } from "../store.ts";
import { entryHref, navigate, recordsHref, timelineHref } from "../hooks/useStore.ts";
import { message, plural } from "../lib/format.ts";
import { cn } from "../lib/utils.ts";
import { OWN_PAGES } from "./LibraryPage.tsx";
import { LinkedText, dayText, shortPath } from "./ViewParts.tsx";
import { TodoBox } from "./UpcomingPage.tsx";
import { useToast } from "./ui/toast.tsx";

/*
  Home: one box, and what needs you now.

  The box both finds and records. Typing searches everything in the Roll
  (events, notes, records, people, places, files and to-dos) as you type;
  Enter saves the line as the kind shown beside it, which is a guess from the
  words (src/core/quick.ts) that Tab changes. Under the box when it is empty:
  what is due or coming up, open to-dos and issues, what's pinned, and the
  latest events. Everything else is in the Library.
*/

/** Writing from the box, each the command line's own path. A kind whose writer is missing isn't offered. */
export interface QuickWriters {
  event(q: Quick): Promise<string | null>;
  todo?(text: string): Promise<void>;
  note?(title: string): Promise<string>;
  bookmark?(q: Quick): Promise<string>;
}

const KIND_ICONS: Record<QuickKind, LucideIcon> = {
  event: Rows3,
  expense: Wallet,
  todo: ListTodo,
  reminder: AlarmClock,
  note: NotebookText,
  bookmark: Bookmark,
};

const isEvent = (e: LoadedEntry) => e.path.toLowerCase().startsWith(".gitroll/events/");

export function HomePage({
  name,
  entries,
  docs,
  views,
  writers,
  onMark,
  onMore,
  newMenu,
  boxRef,
}: {
  name: string;
  /** Events only. */
  entries: LoadedEntry[];
  /** Events, notes and files' sidecars. */
  docs: LoadedEntry[];
  views: ViewsData;
  writers: QuickWriters;
  onMark(path: string, line: number, done: boolean): Promise<void>;
  /** The full form for what is typed, for more than one line holds. */
  onMore(q: Quick): void;
  /** Every other kind, each with its own form. */
  newMenu?: React.ReactNode;
  boxRef?: React.RefObject<HTMLInputElement | null>;
}) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<QuickKind | null>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const ownRef = useRef<HTMLInputElement>(null);
  const inputRef = boxRef ?? ownRef;
  const resultsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  // Open the app, type: the cursor is already in the box.
  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, [inputRef]);
  const today = isoDate(new Date(now));

  const can = (k: QuickKind) =>
    k === "event" || k === "expense" ? true : k === "todo" || k === "reminder" ? !!writers.todo : k === "note" ? !!writers.note : !!writers.bookmark;
  const kinds = QUICK_KINDS.filter(can);
  const quick = useMemo(() => {
    const q = readQuick(text, { kind: picked ?? undefined, now: new Date(now) });
    // A guess the store can't write falls back to an event, which every store can.
    return q && !can(q.kind) ? readQuick(text, { kind: "event", now: new Date(now) }) : q;
  }, [text, picked, now, writers]);

  const save = async () => {
    if (!quick || saving) return;
    setSaving(true);
    try {
      let opened: string | null = null;
      if (quick.kind === "event" || quick.kind === "expense") opened = await writers.event(quick);
      else if (quick.kind === "todo" || quick.kind === "reminder") await writers.todo!(quick.kind === "reminder" && quick.remind ? `${quick.title} ⏰ ${quick.remind}` : quick.title);
      else if (quick.kind === "note") opened = await writers.note!(quick.title);
      else opened = await writers.bookmark!(quick);
      setText("");
      setPicked(null);
      const said = `${QUICK_LABELS[quick.kind]} saved.`;
      toast.toast(said, opened ? { action: { label: "Open", onClick: () => navigate(entryHref(opened!)) } } : undefined);
    } catch (err) {
      toast.error(message(err));
    } finally {
      setSaving(false);
      inputRef.current?.focus();
    }
  };

  const onKeyDown = (ev: React.KeyboardEvent<HTMLInputElement>) => {
    if (ev.key === "Enter" && !ev.nativeEvent.isComposing) {
      ev.preventDefault();
      if (!quick) return;
      if (ev.shiftKey) onMore(quick);
      else void save();
    } else if (ev.key === "Tab" && !ev.shiftKey && text.trim() && kinds.length > 1) {
      ev.preventDefault();
      const at = kinds.indexOf(quick?.kind ?? "event");
      setPicked(kinds[(at + 1) % kinds.length]);
    } else if (ev.key === "Escape" && text) {
      ev.preventDefault();
      setText("");
      setPicked(null);
    } else if (ev.key === "ArrowDown") {
      const first = resultsRef.current?.querySelector<HTMLElement>("a, input");
      if (first) {
        ev.preventDefault();
        first.focus();
      }
    }
  };

  const searching = text.trim().length > 0;

  return (
    <div className="flex flex-col gap-6">
      <h1 className="sr-only">{name}</h1>
      <div className="flex flex-col rounded-2xl bg-card shadow-surface ring-1 ring-border focus-within:ring-2 focus-within:ring-ring">
        <div className="flex items-center gap-2 px-4">
          <Search className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            ref={inputRef}
            id="quick-box"
            type="text"
            role="combobox"
            aria-expanded={searching}
            aria-controls="quick-results"
            aria-describedby="quick-hint"
            aria-label="Find or record"
            autoComplete="off"
            spellCheck
            value={text}
            aria-busy={saving}
            placeholder="Find or record anything…"
            onChange={(e) => {
              setText(e.target.value);
              if (!e.target.value.trim()) setPicked(null);
            }}
            onKeyDown={onKeyDown}
            className="h-14 min-w-0 flex-1 bg-transparent text-lg outline-none placeholder:text-muted-foreground max-sm:text-base"
          />
          {newMenu}
        </div>
        <div id="quick-hint" className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-4 py-2 text-xs text-muted-foreground">
          {quick ? (
            <>
              <KindPicker
                kinds={kinds}
                value={quick.kind}
                onChange={(k) => {
                  setPicked(k);
                  inputRef.current?.focus();
                }}
              />
              <span className="min-w-0 flex-1 truncate font-mono">{describeQuick(quick, today)}</span>
              <span className="hidden shrink-0 items-center gap-1 sm:inline-flex">
                <Kbd>Tab</Kbd> kind <Kbd>↵</Kbd> save <Kbd>⇧↵</Kbd> more <Kbd>↓</Kbd> results
              </span>
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving}
                className="inline-flex items-center gap-1 rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:hidden"
              >
                <CornerDownLeft className="size-3" aria-hidden="true" />
                Save
              </button>
            </>
          ) : (
            <span>
              Type to find anything, or write something new and press Enter.<span className="max-sm:hidden"> Press / from anywhere to come back here.</span>
            </span>
          )}
        </div>
      </div>

      <div ref={resultsRef} id="quick-results" className="flex flex-col gap-6">
        {searching ? (
          <Results query={text} docs={docs} todos={views.todos} busy={busy} onMark={(t) => void mark(t)} />
        ) : (
          <Now entries={entries} docs={docs} views={views} today={today} now={now} busy={busy} onMark={(t) => void mark(t)} />
        )}
      </div>
    </div>
  );

  async function mark(t: { path: string; line: number; done: boolean }) {
    const key = `${t.path}:${t.line}`;
    setBusy(key);
    try {
      await onMark(t.path, t.line, !t.done);
      toast.toast(t.done ? "Open again." : "Done. It's a one-character change, committed.");
    } catch (err) {
      toast.error(message(err));
    } finally {
      setBusy("");
    }
  }
}

/** Where the line will go and what was read out of it, in the Roll's own terms. */
function describeQuick(q: Quick, today: string): string {
  const slug = slugify(q.title).slice(0, 48) || "untitled";
  const said: string[] = [];
  let file: string;
  if (q.kind === "event" || q.kind === "expense") {
    if (q.amount) said.push(formatAmount(q.amount));
    if (q.tags.length) said.push(q.tags.map((t) => `#${t}`).join(" "));
    file = `events/${q.date ?? today}-${slug}.md`;
  } else if (q.kind === "todo" || q.kind === "reminder") {
    if (q.kind === "reminder" && q.remind) said.push(`⏰ ${q.remind}`);
    file = "notes/todo.md";
  } else if (q.kind === "note") file = `notes/${slug}.md`;
  else file = q.url ? `notes/bookmarks/${slug}.md` : "needs a link: https://…";
  return [`“${q.title}”`, ...said].join(" · ") + ` → ${file}`;
}

function KindPicker({ kinds, value, onChange }: { kinds: QuickKind[]; value: QuickKind; onChange(k: QuickKind): void }) {
  return (
    <div role="radiogroup" aria-label="Save as" className="flex flex-wrap gap-1 sm:basis-full">
      {kinds.map((k) => {
        const Icon = KIND_ICONS[k];
        const on = k === value;
        return (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={-1}
            // The chosen one steps to the next: a phone has no Tab key.
            onClick={() => onChange(on ? kinds[(kinds.indexOf(k) + 1) % kinds.length] : k)}
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
              on ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
              !on && "max-sm:hidden",
            )}
          >
            <Icon className="size-3" aria-hidden="true" />
            {QUICK_LABELS[k]}
          </button>
        );
      })}
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded border border-border bg-background px-1 font-mono text-[0.6875rem] text-muted-foreground">{children}</kbd>;
}

// ── Results ────────────────────────────────────────────────────────────────

type Todo = ViewsData["todos"][number];

interface Group {
  key: string;
  label: string;
  icon: LucideIcon;
  /** Where the rest of them are. */
  more?: string;
  docs: LoadedEntry[];
}

const SHOWN = 6;

function groupOf(doc: LoadedEntry, query: string): Omit<Group, "docs"> {
  const p = doc.path.toLowerCase();
  if (p.startsWith(".gitroll/events/")) return { key: "events", label: "Events", icon: Rows3, more: timelineHref(query) };
  if (p.startsWith(".gitroll/files/")) return { key: "files", label: "Files", icon: File, more: "#/files" };
  const collection = collectionOf(doc.path);
  if (collection === null) return { key: "notes", label: "Notes", icon: NotebookText, more: "#/notes" };
  const own = OWN_PAGES[collection.toLowerCase()];
  return { key: `c:${collection}`, label: own?.label ?? collection, icon: own?.icon ?? Table2, more: own?.href ?? recordsHref(collection) };
}

function Results({ query, docs, todos, busy, onMark }: { query: string; docs: LoadedEntry[]; todos: Todo[]; busy: string; onMark(t: Todo): void }) {
  const [only, setOnly] = useState<string | null>(null);
  const index = useMemo(() => new SearchIndex(docs.filter((d) => !isCollectionReadme(d.path))), [docs]);
  const groups = useMemo(() => {
    const found = new Map<string, Group>();
    for (const d of index.search(query)) {
      const g = groupOf(d, query);
      const into = found.get(g.key) ?? { ...g, docs: [] };
      into.docs.push(d);
      found.set(g.key, into);
    }
    for (const g of found.values()) g.docs.sort((a, b) => Number(isPinned(b)) - Number(isPinned(a)) || (b.date ?? "").localeCompare(a.date ?? ""));
    // Events first, then notes, then collections, then files.
    const order = (k: string) => (k === "events" ? 0 : k === "notes" ? 1 : k === "files" ? 3 : 2);
    return [...found.values()].sort((a, b) => order(a.key) - order(b.key) || a.label.localeCompare(b.label));
  }, [index, query]);
  const todoHits = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return todos.filter((t) => !t.done && words.every((w) => `${t.text} ${t.title}`.toLowerCase().includes(w)));
  }, [todos, query]);
  const total = groups.reduce((n, g) => n + g.docs.length, 0) + todoHits.length;
  const chips = [...groups.map((g) => [g.key, g.label, g.docs.length] as const), ...(todoHits.length ? [["todos", "To-dos", todoHits.length] as const] : [])];
  const shown = (key: string) => only === null || only === key;
  useEffect(() => {
    if (only && !chips.some(([k]) => k === only)) setOnly(null);
  }, [only, chips]);

  if (!total) {
    return (
      <p className="px-1 text-sm text-muted-foreground" role="status">
        Nothing in this Roll matches. Press Enter to save what you typed.
      </p>
    );
  }
  return (
    <>
      <p className="sr-only" role="status">
        {plural(total, "match", "matches")}
      </p>
      {chips.length > 1 && (
        <div role="group" aria-label="Show only" className="flex flex-wrap gap-1.5">
          <Chip on={only === null} onClick={() => setOnly(null)}>
            Everything <span className="tabular-nums opacity-70">{total}</span>
          </Chip>
          {chips.map(([key, label, n]) => (
            <Chip key={key} on={only === key} onClick={() => setOnly(only === key ? null : key)}>
              {label} <span className="tabular-nums opacity-70">{n}</span>
            </Chip>
          ))}
        </div>
      )}
      {groups.filter((g) => shown(g.key)).map((g) => (
        <Section key={g.key} title={g.label} icon={g.icon} more={g.docs.length > SHOWN ? { href: g.more!, label: `All ${g.docs.length}` } : undefined}>
          {(only === null ? g.docs.slice(0, SHOWN) : g.docs).map((d) => (
            <DocRow key={d.path} doc={d} />
          ))}
        </Section>
      ))}
      {todoHits.length > 0 && shown("todos") && (
        <Section title="To-dos" icon={ListTodo} more={{ href: "#/upcoming", label: "All to-dos" }}>
          {todoHits.slice(0, only === null ? SHOWN : undefined).map((t) => (
            <TodoRow key={`${t.path}:${t.line}`} todo={t} busy={busy === `${t.path}:${t.line}`} onMark={onMark} />
          ))}
        </Section>
      )}
    </>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        on ? "bg-foreground text-background" : "bg-muted text-foreground hover:bg-accent",
      )}
    >
      {children}
    </button>
  );
}

// ── Now ────────────────────────────────────────────────────────────────────

function Now({ entries, docs, views, today, now, busy, onMark }: { entries: LoadedEntry[]; docs: LoadedEntry[]; views: ViewsData; today: string; now: number; busy: string; onMark(t: Todo): void }) {
  const sources = useMemo(() => withoutResolved(docs, views.todos), [docs, views.todos]);
  const coming = useMemo(() => upcomingWithReminders(sources.docs, sources.todos, today, 14, new Date(now)), [sources, today, now]);
  // Dated to-dos are in what's coming; the rest are listed as to-dos.
  const dated = useMemo(() => new Set(coming.filter((i) => i.line !== undefined).map((i) => `${i.path}:${i.line}`)), [coming]);
  const todos = useMemo(() => sources.todos.filter((t) => !t.done && !dated.has(`${t.path}:${t.line}`)), [sources, dated]);
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
  const todoAt = useMemo(() => new Map(views.todos.map((t) => [`${t.path}:${t.line}`, t])), [views.todos]);

  return (
    <>
      <Section title="Now" icon={AlarmClock} more={{ href: "#/upcoming", label: "Calendar" }}>
        {coming.length === 0 && openIssues.length === 0 ? (
          <Quiet>Nothing due in the next two weeks.</Quiet>
        ) : (
          <>
            {coming.slice(0, 8).map((i) => {
              const key = `${i.path}:${i.line ?? ""}`;
              const todo = i.line !== undefined ? todoAt.get(key) : undefined;
              const when = (
                <span className={cn("shrink-0 text-xs tabular-nums", i.overdue || i.due ? "font-medium text-destructive" : "text-muted-foreground")}>
                  {i.kind === "reminder" ? "⏰ " : ""}
                  {i.overdue ? "overdue" : i.due ? "due now" : dayText(i.date)}
                </span>
              );
              return todo ? (
                <TodoRow key={`${i.kind}:${key}:${i.date}`} todo={todo} busy={busy === key} onMark={onMark} after={when} />
              ) : (
                <Row key={`${i.kind}:${key}:${i.date}:${i.field ?? ""}`} href={entryHref(i.path)} title={i.field ? `${i.title}: ${i.field}` : linksAsText(i.title)} after={when} />
              );
            })}
            {openIssues.slice(0, 5).map((i) => (
              <Row
                key={i.path}
                href={entryHref(i.path)}
                icon={CircleAlert}
                title={i.title}
                after={<span className="shrink-0 text-xs text-muted-foreground">{i.age !== null ? `open ${plural(i.age, "day", "days")}` : "open issue"}</span>}
              />
            ))}
          </>
        )}
      </Section>

      {todos.length > 0 && (
        <Section title="To-dos" icon={ListTodo} count={todos.length} more={{ href: "#/upcoming", label: "All to-dos" }}>
          {todos.slice(0, 6).map((t) => (
            <TodoRow key={`${t.path}:${t.line}`} todo={t} busy={busy === `${t.path}:${t.line}`} onMark={onMark} />
          ))}
        </Section>
      )}

      {pinned.length > 0 && (
        <Section title="Pinned" icon={Pin}>
          {pinned.map((p) => (
            <DocRow key={p.path} doc={p} />
          ))}
        </Section>
      )}

      <Section title="Recent" icon={Rows3} more={{ href: "#/timeline", label: "Timeline" }}>
        {recent.length === 0 ? <Quiet>Nothing logged yet. Type what happened above and press Enter.</Quiet> : recent.map((e) => <DocRow key={e.path} doc={e} />)}
      </Section>
    </>
  );
}

// ── Rows ───────────────────────────────────────────────────────────────────

function Section({ title, icon: Icon, count, more, children }: { title: string; icon: LucideIcon; count?: number; more?: { href: string; label: string }; children: React.ReactNode }) {
  const id = `home-${slugify(title)}`;
  return (
    <section aria-labelledby={id} className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2 px-1">
        <h2 id={id} className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <Icon className="size-3.5" aria-hidden="true" />
          {title}
          {count !== undefined && <span className="font-normal tabular-nums">{count}</span>}
        </h2>
        {more && (
          <a href={more.href} className="rounded text-xs text-link hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            {more.label}
          </a>
        )}
      </div>
      <ul className="inset-group">{children}</ul>
    </section>
  );
}

function Row({ href, title, icon: Icon, after }: { href: string; title: string; icon?: LucideIcon; after?: React.ReactNode }) {
  return (
    <li>
      <a href={href} className="flex items-center gap-3 px-3 py-2.5 text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
        {Icon && <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {after}
      </a>
    </li>
  );
}

function DocRow({ doc }: { doc: LoadedEntry }) {
  const detail = isEvent(doc)
    ? [doc.amount ? formatAmount(doc.amount) : "", doc.date ? dayText(doc.date.slice(0, 10)) : ""].filter(Boolean).join(" · ")
    : shortPath(doc.path).replace(/\/[^/]+$/, "") === shortPath(doc.path)
      ? "note"
      : "";
  return <Row href={entryHref(doc.path)} title={doc.title} after={detail ? <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{detail}</span> : undefined} />;
}

function TodoRow({ todo, busy, onMark, after }: { todo: Todo; busy: boolean; onMark(t: Todo): void; after?: React.ReactNode }) {
  const { text, due } = taskDates(todo.text);
  after ??= due ? <span className="shrink-0 text-xs tabular-nums text-muted-foreground">📅 {dayText(due)}</span> : undefined;
  return (
    <li className="flex items-start gap-3 px-3 py-2.5">
      <TodoBox label={linksAsText(text || todo.text)} checked={todo.done || busy} disabled={busy} onChange={() => onMark(todo)} />
      <span className="min-w-0 flex-1 text-sm">
        <LinkedText text={text || todo.text} from={todo.path} />
        <span className="block text-xs text-muted-foreground">in {todo.title || shortPath(todo.path)}</span>
      </span>
      {after}
    </li>
  );
}

function Quiet({ children }: { children: React.ReactNode }) {
  return <li className="px-3 py-2.5 text-sm text-muted-foreground">{children}</li>;
}
