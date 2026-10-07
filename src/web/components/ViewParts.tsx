import type * as React from "react";
import { isSealedValue } from "../../core/sealed.ts";
import { formatAmount } from "../../core/util.ts";
import type { CurrencyTotal } from "../../core/ledger.ts";
import { COPY } from "../copy.ts";
import { entryHref } from "../hooks/useStore.ts";
import { useAsk } from "./ui/ask.tsx";
import { Skeleton } from "./ui/misc.tsx";

/*
  Pieces shared by the pages beside the timeline: Notes, Records, Upcoming,
  Ledger, Series, Inventory, Contacts, Organizations, Places and Files. Each page
  is a view over files that already exist, worked out by the same functions in
  src/core the command line uses, so the browser and `gitroll records`,
  `upcoming`, `ledger`, `series`, `inventory`, `contacts`, `organizations`,
  `places` and `files` can't disagree.
*/

export function PageHeader({ title, children, description }: { title: string; children?: React.ReactNode; description?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{title}</h1>
        {children}
      </div>
      {description && <p className="max-w-prose text-sm text-muted-foreground">{description}</p>}
    </div>
  );
}

/** An empty page says what would fill it, and the line that does it. */
export function Empty({ title, children, command }: { title: string; children?: React.ReactNode; command?: string }) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-border p-6">
      <p className="text-base font-medium">{title}</p>
      {children && <p className="max-w-prose text-sm text-muted-foreground">{children}</p>}
      {command && <code className="rounded bg-muted px-2 py-1 font-mono text-xs">{command}</code>}
    </div>
  );
}

export function ViewsState({ error }: { error: string }) {
  if (error) {
    return (
      <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive-bg px-3 py-2 text-sm text-destructive">
        {error}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2" aria-busy="true">
      <span className="sr-only">Reading the Roll…</span>
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-16 w-full" />
    </div>
  );
}

/**
 * Asks before throwing away what was typed: a dialog closed by a stray Escape
 * shouldn't take somebody's writing with it. Resolves true when it may go.
 */
export function useDiscardGuard(): (dirty: boolean) => Promise<boolean> {
  const ask = useAsk();
  return (dirty) =>
    !dirty
      ? Promise.resolve(true)
      : ask.confirm({
          title: COPY.confirmDiscardTitle,
          description: COPY.confirmDiscardBody,
          confirmLabel: COPY.confirmDiscardAction,
          cancelLabel: COPY.keepWriting,
          destructive: true,
        });
}

/** A link to an event or a note, opened like any event. */
export function DocLink({ path, children, className }: { path: string; children: React.ReactNode; className?: string }) {
  return (
    <a
      href={entryHref(path)}
      className={
        className ??
        "rounded font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      }
    >
      {children}
    </a>
  );
}

/** A front matter value as somebody reads it. A sealed value says so and nothing more. */
export function fieldText(v: unknown): string {
  if (v == null || v === "") return "";
  if (isSealedValue(v)) return "[sealed]";
  if (Array.isArray(v)) return v.map(fieldText).filter(Boolean).join(", ");
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.value === "number" && typeof o.currency === "string") return formatAmount({ value: o.value, currency: o.currency });
    return JSON.stringify(v);
  }
  const s = String(v);
  // A Markdown link reads as its text: "[Garage](../places/garage.md)" is "Garage".
  const link = /^\[([^\]]*)\]\([^)]*\)$/.exec(s.trim());
  return link ? link[1] : s;
}

/** Totals per currency, each on its own: nothing is converted. */
export function Totals({ totals }: { totals: CurrencyTotal[] }) {
  if (!totals.length) return <span className="text-muted-foreground">nothing</span>;
  return (
    <span className="tabular-nums">
      {totals.map((t, i) => (
        <span key={t.currency}>
          {i > 0 && <span className="text-muted-foreground"> · </span>}
          {formatAmount({ value: t.total, currency: t.currency })}
        </span>
      ))}
    </span>
  );
}

/** A day as a reader says it: Thu, 15 Oct 2026; with a time when there is one. */
export function dayText(date: string): string {
  const d = new Date(date.length === 10 ? `${date}T12:00:00` : date);
  if (Number.isNaN(d.getTime())) return date;
  const opts: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short", year: "numeric" };
  return date.length > 10 ? d.toLocaleString([], { ...opts, hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString([], opts);
}

/** A Roll path without the .gitroll/ folder and .md, as the command line prints it. */
export const shortPath = (p: string) => p.replace(/^\.gitroll\/(?:events\/|notes\/)?/, "").replace(/\.md$/, "");

export const tableClass = "w-full border-collapse text-sm";
export const thClass = "border-b border-border px-2 py-1.5 text-left font-medium text-muted-foreground";
export const tdClass = "border-b border-border px-2 py-1.5 align-top";
