import { ExternalLink } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { LoadedEntry } from "../../core/layout.ts";
import { entryHref, timelineHref } from "../hooks/useStore.ts";
import { message, plural } from "../lib/format.ts";
import type { AllRollsStore, RollHits } from "../store.ts";
import { Button } from "./ui/button.tsx";
import { Skeleton } from "./ui/misc.tsx";
import { useToast } from "./ui/toast.tsx";
import { dayText, shortPath } from "./ViewParts.tsx";

/*
  One search over every Roll on this computer, as `gitroll find "…" --all`
  runs it: the Rolls `gitroll rolls` lists, each searched by the same code, and
  the results kept apart by Roll. Nothing is written anywhere. A result in
  another Roll opens that Roll's own app, the way `gitroll open <name>` would.
*/

export interface AllRollsResult {
  rolls: RollHits[] | null;
  loading: boolean;
  error: string;
}

/** Searches every Roll a moment after typing stops, rather than on every key. */
export function useAllRolls(store: AllRollsStore | null, query: string, enabled: boolean, version: string): AllRollsResult {
  const [state, setState] = useState<AllRollsResult>({ rolls: null, loading: false, error: "" });
  const q = query.trim();
  useEffect(() => {
    if (!store || !enabled || !q) {
      setState({ rolls: null, loading: false, error: "" });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    const timer = setTimeout(() => {
      store
        .searchAllRolls(q)
        .then((rolls) => !cancelled && setState({ rolls, loading: false, error: "" }))
        .catch((err: unknown) => !cancelled && setState({ rolls: null, loading: false, error: message(err) }));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [store, q, enabled, version]);
  return state;
}

/** What the search box's status line says about an All Rolls search. */
export function allRollsStatus({ rolls, loading }: AllRollsResult): string {
  if (loading && !rolls) return "Searching your Rolls…";
  if (!rolls) return "";
  const found = rolls.filter((r) => r.total > 0);
  const total = found.reduce((n, r) => n + r.total, 0);
  return `${plural(total, "result", "results")} in ${plural(found.length, "Roll", "Rolls")}`;
}

export function AllRollsResults({ store, query, result }: { store: AllRollsStore; query: string; result: AllRollsResult }) {
  const toast = useToast();
  const [opening, setOpening] = useState<string | null>(null);

  /** Opens another Roll's app in this tab, at `hash`. Back returns here. */
  const open = async (key: string, hash: string) => {
    if (opening) return;
    setOpening(key);
    try {
      const url = await store.openRoll(key);
      window.location.assign(`${url}${hash}`);
    } catch (err) {
      toast.error(message(err));
      setOpening(null);
    }
  };

  if (!query.trim()) {
    return <p className="py-10 text-sm text-muted-foreground">Type a search to look through every Roll on this computer.</p>;
  }
  if (result.error) {
    return (
      <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive-bg px-3 py-2 text-sm text-destructive">
        {result.error}
      </p>
    );
  }
  if (!result.rolls) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }
  const found = result.rolls.filter((r) => r.total > 0);
  const missed = result.rolls.filter((r) => r.problem);
  return (
    <div className="flex flex-col gap-6">
      {found.length === 0 && (
        <div className="flex flex-col items-start gap-2 py-10">
          <p className="text-sm">Nothing found in any of your Rolls.</p>
          <p className="text-sm text-muted-foreground">Try fewer filters, or a different word.</p>
        </div>
      )}
      {found.map((roll) => (
        <RollGroup
          key={roll.key ?? "this"}
          roll={roll}
          query={query}
          opening={opening === roll.key}
          onOpen={(hash) => roll.key && void open(roll.key, hash)}
        />
      ))}
      {missed.length > 0 && (
        <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
          {missed.map((r) => (
            <li key={r.key ?? "this"}>
              Couldn't search {r.name}: {r.problem}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RollGroup({ roll, query, opening, onOpen }: { roll: RollHits; query: string; opening: boolean; onOpen(hash: string): void }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={headingId} className="text-base font-semibold">
          {roll.name}
          <span className="ml-2 text-sm font-normal text-muted-foreground">
            {plural(roll.total, "result", "results")}
            {roll.current && " · this Roll"}
          </span>
        </h2>
        {!roll.current && roll.key && (
          <Button variant="secondary" size="sm" disabled={opening} onClick={() => onOpen(timelineHref(query))}>
            <ExternalLink aria-hidden="true" />
            Open {roll.name}
          </Button>
        )}
      </div>
      <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-card">
        {roll.entries.map((e) => (
          <li key={e.path} className="flex flex-col gap-0.5 px-3 py-2">
            {roll.current ? (
              <a href={hrefFor(e)} className={titleClass}>
                {e.title || shortPath(e.path)}
              </a>
            ) : (
              <button type="button" disabled={opening} onClick={() => onOpen(hrefFor(e))} className={`text-left ${titleClass}`}>
                {e.title || shortPath(e.path)}
                <span className="sr-only"> (opens {roll.name})</span>
              </button>
            )}
            <span className="text-xs text-muted-foreground">
              {[e.date ? dayText(e.date) : null, kindOf(e), shortPath(e.path)].filter(Boolean).join(" · ")}
            </span>
          </li>
        ))}
      </ul>
      {roll.total > roll.entries.length && (
        <p className="text-xs text-muted-foreground">
          Showing the first {roll.entries.length} of {roll.total}.
        </p>
      )}
    </section>
  );
}

const titleClass =
  "self-start rounded text-sm font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50";

/** A file's fields open with the files; anything else opens like an event. */
const hrefFor = (e: LoadedEntry) => (e.path.startsWith(".gitroll/files/") ? "#/files" : entryHref(e.path));

const kindOf = (e: LoadedEntry) => (e.path.startsWith(".gitroll/files/") ? "File" : e.path.startsWith(".gitroll/notes/") ? "Note" : "Event");
