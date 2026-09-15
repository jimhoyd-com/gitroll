import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { SearchIndex } from "../../core/search.ts";
import type { LoadedEntry } from "../../core/layout.ts";
import { ServerUnavailableError, SignedOutError } from "../store.ts";
import type { Store } from "../store.ts";

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
  | { name: "entry"; id: string };

function parseHash(hash: string): Route {
  const h = hash || "#/";
  let m: RegExpMatchArray | null;
  if ((m = h.match(/^#\/?(?:\?q=(.*))?$/))) return { name: "timeline", query: safeDecode(m[1] ?? "") };
  if (h === "#/topics" || h === "#/projects") return { name: "topics" };
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
