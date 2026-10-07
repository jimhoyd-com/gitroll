import { CalendarDays, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type * as React from "react";
import type { LoadedEntry } from "../../core/layout.ts";
import { taskDates } from "../../core/calendar.ts";
import { upcomingWithReminders } from "../../core/reminders.ts";
import type { CalendarItem } from "../../core/calendar.ts";
import { restockTodos } from "../../core/inventory.ts";
import type { Todo } from "../../core/todos.ts";
import { isoDate } from "../../core/util.ts";
import { COPY } from "../copy.ts";
import { message, plural } from "../lib/format.ts";
import { DocLink, Empty, PageHeader, dayText, shortPath } from "./ViewParts.tsx";
import { ReminderNotifier } from "./ReminderNotifier.tsx";
import { Button } from "./ui/button.tsx";
import { Field, Input } from "./ui/input.tsx";
import { useToast } from "./ui/toast.tsx";

type TodoLine = Todo & { title: string };

const RANGES = [
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 365, label: "A year" },
];

const KIND: Record<CalendarItem["kind"], string> = { event: "", occurrence: "Repeats", todo: "To-do", field: "", reminder: "⏰ Reminder" };

const itemKey = (i: CalendarItem) => `${i.kind}:${i.path}:${i.line ?? ""}:${i.date}:${i.field ?? ""}:${i.remind ?? ""}`;

/**
 * What's coming up and what's left to do: appointments (`start`, `rrule`),
 * events dated ahead, to-dos with a 📅 date, and warranty, expiry, due and
 * renewal dates; then every open to-do. The same list as `gitroll upcoming`
 * and `gitroll todos`, and ticking one off is the same one-character edit.
 */
export function UpcomingPage({
  docs,
  todos,
  notes,
  calendarUrl,
  onMark,
  onAddTodo,
}: {
  /** Events and notes. */
  docs: LoadedEntry[];
  todos: TodoLine[];
  notes: LoadedEntry[];
  calendarUrl: string;
  onMark(path: string, line: number, done: boolean): Promise<void>;
  /** Adds a to-do to .gitroll/notes/todo.md. Absent where the store can't. */
  onAddTodo?: (text: string, due?: string) => Promise<void>;
}) {
  const [days, setDays] = useState(30);
  const [busy, setBusy] = useState("");
  const toast = useToast();
  // Reminders come due while the page is open, so the clock it reads moves on.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const today = isoDate(new Date(now));
  const items = useMemo(() => upcomingWithReminders(docs, todos, today, days, new Date(now)), [docs, todos, today, days, now]);
  const due = useMemo(() => items.filter((i) => i.due).map((i) => ({ key: itemKey(i), title: i.title })), [items]);
  const open = useMemo(() => todos.filter((t) => !t.done), [todos]);
  const restock = useMemo(() => restockTodos(notes), [notes]);

  const mark = async (t: { path: string; line: number }, done: boolean) => {
    const key = `${t.path}:${t.line}`;
    setBusy(key);
    try {
      await onMark(t.path, t.line, done);
      toast.toast(done ? "Done. It's a one-character change, committed." : "Back on the list.");
    } catch (err) {
      toast.error(message(err));
    } finally {
      setBusy("");
    }
  };

  const byDay = useMemo(() => {
    const groups = new Map<string, CalendarItem[]>();
    for (const i of items) {
      const key = i.due ? "due" : i.overdue ? "overdue" : i.date.slice(0, 10);
      groups.set(key, [...(groups.get(key) ?? []), i]);
    }
    return [...groups];
  }, [items]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Upcoming" description="Appointments, dated to-dos, reminders, and warranties, expiries and renewals, from any event or note.">
        <div className="flex flex-wrap items-start gap-2">
          <ReminderNotifier due={due} />
          <Button variant="secondary" size="sm" asChild>
            <a href={calendarUrl} download="gitroll.ics">
              <CalendarDays aria-hidden="true" />
              Calendar file (.ics)
            </a>
          </Button>
        </div>
      </PageHeader>

      <section aria-labelledby="coming-up" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="coming-up" className="text-base font-medium">
            Coming up
          </h2>
          <div role="group" aria-label="How far ahead" className="flex gap-1">
            {RANGES.map((r) => (
              <Button key={r.days} size="sm" variant={days === r.days ? "default" : "ghost"} aria-pressed={days === r.days} onClick={() => setDays(r.days)}>
                {r.label}
              </Button>
            ))}
          </div>
        </div>

        {items.length === 0 ? (
          <Empty title={`Nothing in the next ${days} days`}>
            An event or note with a start date, a to-do ending in 📅 2026-11-01 or ⏰ 2026-11-01 09:00, or a warranty, expires, due or renewal date shows up here.
          </Empty>
        ) : (
          <ol className="flex flex-col gap-3">
            {byDay.map(([day, list]) => (
              <li key={day} className="flex flex-col gap-1">
                <h3 className={day === "overdue" || day === "due" ? "text-sm font-medium text-destructive" : "text-sm font-medium text-muted-foreground"}>
                  {day === "due" ? "Due now" : day === "overdue" ? "Overdue" : day === today ? `Today, ${dayText(day)}` : dayText(day)}
                </h3>
                <ul className="flex flex-col gap-1">
                  {list.map((i) => (
                    <li key={itemKey(i)} className="flex items-start gap-2 rounded-lg border border-border px-3 py-2">
                      {(i.kind === "todo" || i.kind === "reminder") && i.line !== undefined && (
                        <TodoBox label={i.title} checked={busy === `${i.path}:${i.line}`} disabled={busy === `${i.path}:${i.line}`} onChange={(d) => void mark({ path: i.path, line: i.line! }, d)} />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="text-sm">
                          {i.kind === "field" ? (
                            <>
                              <DocLink path={i.path}>{i.title}</DocLink>
                              <span className="text-muted-foreground">: {i.field}</span>
                            </>
                          ) : i.kind === "todo" || (i.kind === "reminder" && i.line !== undefined) ? (
                            i.title
                          ) : (
                            <DocLink path={i.path}>{i.title}</DocLink>
                          )}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {[
                            i.overdue ? `was due ${dayText(i.date)}` : i.date.length > 10 ? dayText(i.date) : "",
                            KIND[i.kind],
                            i.remind ? `remind: ${i.remind}` : "",
                            i.location ? `at ${i.location}` : "",
                            i.recurrence ? `🔁 ${i.recurrence}` : "",
                            i.problem ? `repeat not read: ${i.problem}` : "",
                            i.kind === "todo" || (i.kind === "reminder" && i.line !== undefined) ? `in ${shortPath(i.path)}` : "",
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section aria-labelledby="todos" className="flex flex-col gap-3">
        <h2 id="todos" className="text-base font-medium">
          To-dos <span className="text-sm font-normal text-muted-foreground">{plural(open.length + restock.length, "open", "open")}</span>
        </h2>
        {onAddTodo && <AddTodo onAdd={onAddTodo} />}
        {open.length === 0 && restock.length === 0 ? (
          <Empty title="Nothing to do" command={'gitroll todo "Call the plumber"'}>
            A to-do is a line like - [ ] Call the plumber, in any event or note.
          </Empty>
        ) : (
          <ul className="flex flex-col gap-1">
            {open.map((t) => {
              const { text } = taskDates(t.text);
              return (
                <li key={`${t.path}:${t.line}`} className="flex items-start gap-2 rounded-lg border border-border px-3 py-2">
                  <TodoBox label={text || t.text} checked={busy === `${t.path}:${t.line}`} disabled={busy === `${t.path}:${t.line}`} onChange={(d) => void mark(t, d)} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">{t.text}</p>
                    <p className="text-xs text-muted-foreground">
                      in <DocLink path={t.path}>{t.title || shortPath(t.path)}</DocLink>
                    </p>
                  </div>
                </li>
              );
            })}
            {restock.map((t) => (
              <li key={`restock:${t.path}`} className="flex items-start gap-2 rounded-lg border border-dashed border-border px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm">{t.text}</p>
                  <p className="text-xs text-muted-foreground">
                    Worked out from <DocLink path={t.path}>{shortPath(t.path)}</DocLink>: its quantity is at or below reorderAt.
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** A to-do in a line, as `gitroll todo` adds one; a day, when given, becomes its 📅 date. */
function AddTodo({ onAdd }: { onAdd(text: string, due?: string): Promise<void> }) {
  const [text, setText] = useState("");
  const [due, setDue] = useState("");
  const [adding, setAdding] = useState(false);
  const toast = useToast();
  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!text.trim() || adding) return;
    setAdding(true);
    try {
      await onAdd(text.trim(), due || undefined);
      toast.toast(COPY.todoAdded);
      setText("");
      setDue("");
    } catch (err) {
      toast.error(message(err));
    } finally {
      setAdding(false);
    }
  };
  return (
    <form onSubmit={(ev) => void submit(ev)} className="flex flex-wrap items-end gap-2">
      <Field label={COPY.newTodo} htmlFor="new-todo" className="min-w-48 flex-1">
        <Input id="new-todo" value={text} placeholder="Call the plumber" onChange={(ev) => setText(ev.target.value)} />
      </Field>
      <Field label={COPY.todoDue} htmlFor="new-todo-due">
        <Input id="new-todo-due" type="date" value={due} onChange={(ev) => setDue(ev.target.value)} className="w-auto" />
      </Field>
      <Button type="submit" disabled={!text.trim() || adding}>
        <Plus aria-hidden="true" />
        {adding ? COPY.saving : COPY.addTodo}
      </Button>
    </form>
  );
}

function TodoBox({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled: boolean; onChange(done: boolean): void }) {
  return (
    <input
      type="checkbox"
      className="mt-0.5 size-4 shrink-0 accent-primary"
      aria-label={`Done: ${label}`}
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}
