import { CalendarDays } from "lucide-react";
import { useMemo, useState } from "react";
import type { LoadedEntry } from "../../core/layout.ts";
import { taskDates, upcoming } from "../../core/calendar.ts";
import type { CalendarItem } from "../../core/calendar.ts";
import { restockTodos } from "../../core/inventory.ts";
import type { Todo } from "../../core/todos.ts";
import { isoDate } from "../../core/util.ts";
import { message, plural } from "../lib/format.ts";
import { DocLink, Empty, PageHeader, dayText, shortPath } from "./ViewParts.tsx";
import { Button } from "./ui/button.tsx";
import { useToast } from "./ui/toast.tsx";

type TodoLine = Todo & { title: string };

const RANGES = [
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 365, label: "A year" },
];

const KIND: Record<CalendarItem["kind"], string> = { event: "", occurrence: "Repeats", todo: "To-do", field: "" };

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
}: {
  /** Events and notes. */
  docs: LoadedEntry[];
  todos: TodoLine[];
  notes: LoadedEntry[];
  calendarUrl: string;
  onMark(path: string, line: number, done: boolean): Promise<void>;
}) {
  const [days, setDays] = useState(30);
  const [busy, setBusy] = useState("");
  const toast = useToast();
  const today = isoDate();
  const items = useMemo(() => upcoming(docs, todos, today, days), [docs, todos, today, days]);
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
      const key = i.overdue ? "overdue" : i.date.slice(0, 10);
      groups.set(key, [...(groups.get(key) ?? []), i]);
    }
    return [...groups];
  }, [items]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Upcoming" description="Appointments, dated to-dos, and warranties, expiries and renewals, from any event or note.">
        <Button variant="secondary" size="sm" asChild>
          <a href={calendarUrl} download="gitroll.ics">
            <CalendarDays aria-hidden="true" />
            Calendar file (.ics)
          </a>
        </Button>
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
            An event or note with a start date, a to-do ending in 📅 2026-11-01, or a warranty, expires, due or renewal date shows up here.
          </Empty>
        ) : (
          <ol className="flex flex-col gap-3">
            {byDay.map(([day, list]) => (
              <li key={day} className="flex flex-col gap-1">
                <h3 className={day === "overdue" ? "text-sm font-medium text-destructive" : "text-sm font-medium text-muted-foreground"}>
                  {day === "overdue" ? "Overdue" : day === today ? `Today, ${dayText(day)}` : dayText(day)}
                </h3>
                <ul className="flex flex-col gap-1">
                  {list.map((i) => (
                    <li key={`${i.path}:${i.line ?? ""}:${i.date}:${i.field ?? ""}`} className="flex items-start gap-2 rounded-lg border border-border px-3 py-2">
                      {i.kind === "todo" && i.line !== undefined && (
                        <TodoBox label={i.title} checked={busy === `${i.path}:${i.line}`} disabled={busy === `${i.path}:${i.line}`} onChange={(d) => void mark({ path: i.path, line: i.line! }, d)} />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="text-sm">
                          {i.kind === "field" ? (
                            <>
                              <DocLink path={i.path}>{i.title}</DocLink>
                              <span className="text-muted-foreground">: {i.field}</span>
                            </>
                          ) : i.kind === "todo" ? (
                            i.title
                          ) : (
                            <DocLink path={i.path}>{i.title}</DocLink>
                          )}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {[
                            i.overdue ? `was due ${dayText(i.date)}` : i.date.length > 10 ? dayText(i.date) : "",
                            KIND[i.kind],
                            i.location ? `at ${i.location}` : "",
                            i.recurrence ? `🔁 ${i.recurrence}` : "",
                            i.problem ? `repeat not read: ${i.problem}` : "",
                            i.kind === "todo" ? `in ${shortPath(i.path)}` : "",
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
