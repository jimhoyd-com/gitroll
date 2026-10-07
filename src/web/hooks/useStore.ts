import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { SearchIndex } from "../../core/search.ts";
import type { LoadedEntry } from "../../core/layout.ts";
import { ServerUnavailableError, SignedOutError, hasViews } from "../store.ts";
import type { Store, ViewsData } from "../store.ts";

const POLL_MS = 10_000;

export type Connection = "ok" | "stopped" | "signed-out";

/*
  The Store is a plain object that changes underneath React: the local app polls
  the folder on this computer and swaps its state. useSyncExternalStore is the
  supported way to read something like that, and store.version() is a cheap,
  stable snapshot key, so a poll that finds nothing new re-renders nothing.
*/
export function useStoreVersion(store: Store, onChange: (c: Connection) => void): string {
  const listeners = useRef(new Set<() => void>());
  const connection = useRef<Connection>("ok");

  const subscribe = useCallback((cb: () => void) => {
    listeners.current.add(cb);
    return () => listeners.current.delete(cb);
  }, []);

  const notify = useCallback(() => {
    for (const cb of listeners.current) cb();
  }, []);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      if (cancelled || document.visibilityState !== "visible") return;
      const before = store.version();
      let next: Connection = "ok";
      try {
        await store.refresh();
      } catch (err) {
        next = err instanceof SignedOutError ? "signed-out" : err instanceof ServerUnavailableError ? "stopped" : connection.current;
      }
      if (cancelled) return;
      if (next !== connection.current) {
        connection.current = next;
        onChange(next);
      }
      if (store.version() !== before) notify();
    };

    const timer = setInterval(() => void poll(), POLL_MS);
    const onVisible = () => void poll();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [store, notify, onChange]);

  // Anything that writes calls this so the interface updates without waiting
  // for the next poll.
  useEffect(() => {
    const onLocalChange = () => notify();
    window.addEventListener("gitroll:changed", onLocalChange);
    return () => window.removeEventListener("gitroll:changed", onLocalChange);
  }, [notify]);

  return useSyncExternalStore(subscribe, () => store.version());
}

/** Tells the interface that a write happened, without threading callbacks everywhere. */
export const storeChanged = () => window.dispatchEvent(new Event("gitroll:changed"));

export interface RollData {
  entries: LoadedEntry[];
  index: SearchIndex<LoadedEntry>;
  /** Projects any event mentions. Nothing defines them; they are just words. */
  projects: string[];
}

/** Everything derived from the Roll, rebuilt only when the Roll actually changes. */
export function useRoll(store: Store, version: string): RollData {
  return useMemo(() => {
    const entries = store.entries();
    const index = new SearchIndex(entries);
    return { entries, index, projects: store.projects() };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- version is the snapshot key
  }, [store, version]);
}

/** The hash route, as a parsed object. */
export type Route =
  | { name: "timeline"; query: string }
  | { name: "topics" }
  | { name: "conflicts" }
  | { name: "deleted" }
  | { name: "notes" }
  | { name: "records"; collection: string }
  | { name: "upcoming" }
  | { name: "ledger" }
  | { name: "inventory" }
  | { name: "files" }
  | { name: "entry"; id: string };

/** The pages made from notes, to-dos and files rather than from the timeline. */
export const VIEW_PAGES = new Set<Route["name"]>(["notes", "records", "upcoming", "ledger", "inventory", "files"]);

function parseHash(hash: string): Route {
  const h = hash || "#/";
  let m: RegExpMatchArray | null;
  if ((m = h.match(/^#\/?(?:\?q=(.*))?$/))) return { name: "timeline", query: safeDecode(m[1] ?? "") };
  if (h === "#/topics" || h === "#/projects") return { name: "topics" };
  if (h === "#/conflicts") return { name: "conflicts" };
  if (h === "#/deleted") return { name: "deleted" };
  if (h === "#/notes") return { name: "notes" };
  if ((m = h.match(/^#\/records(?:\/(.+))?$/))) return { name: "records", collection: safeDecode(m[1] ?? "") };
  if (h === "#/upcoming") return { name: "upcoming" };
  if (h === "#/ledger") return { name: "ledger" };
  if (h === "#/inventory") return { name: "inventory" };
  if (h === "#/files") return { name: "files" };
  if ((m = h.match(/^#\/entry\/([^/?]+)$/))) return { name: "entry", id: safeDecode(m[1]) };
  return { name: "timeline", query: "" };
}

const safeDecode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const update = () => setRoute(parseHash(location.hash));
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  return route;
}

/*
  The query is kept in the URL exactly as it was typed, including a trailing
  space. Trimming here looks harmless and isn't: the text field is driven from
  the URL, so a trimmed round trip eats the space the moment it is typed, and a
  search can never get past its first word.
*/
export const timelineHref = (query: string) => (query.trim() ? `#/?q=${encodeURIComponent(query)}` : "#/");

/** Changes the query without adding a history entry for every keystroke. */
export function replaceQuery(query: string): void {
  history.replaceState(null, "", timelineHref(query));
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

export function navigate(href: string): void {
  location.hash = href.startsWith("#") ? href.slice(1) : href;
}

export const recordsHref = (collection: string) => `#/records/${collection.split("/").map(encodeURIComponent).join("/")}`;
export const entryHref = (path: string) => `#/entry/${encodeURIComponent(path)}`;

/**
 * Notes, to-dos and files, read when a page needs them and again whenever the
 * Roll changes or, while that page is open, every poll: a note edited in
 * another window changes nothing the timeline's snapshot covers.
 */
export function useViews(store: Store, version: string, enabled: boolean): { data: ViewsData | null; error: string } {
  const [data, setData] = useState<ViewsData | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!enabled || !hasViews(store)) return;
    let cancelled = false;
    const load = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const next = await store.views();
        if (cancelled) return;
        setData((prev) => (prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
        setError("");
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    window.addEventListener("gitroll:changed", load);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener("gitroll:changed", load);
    };
  }, [store, version, enabled]);
  return { data, error };
}
