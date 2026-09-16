import { useCallback, useEffect, useState } from "react";
import { message } from "../lib/format.ts";
import type { DeletedItem, Store } from "../store.ts";
import { Button } from "./ui/button.tsx";
import { useToast } from "./ui/toast.tsx";

/*
  Where a deleted event goes.

  Nothing is ever really lost — Git keeps every version — but "it's in the
  history" is only true for people who know Git. This is the same list the
  terminal app shows under /deleted, read out of that history, with the way back
  beside each one.
*/
export function DeletedPage({ store, onRestored }: { store: Store; onRestored(): void }) {
  const [items, setItems] = useState<DeletedItem[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      setItems(await store.deleted());
      setError("");
    } catch (err) {
      setError(message(err));
    }
  }, [store]);

  useEffect(() => {
    void load();
  }, [load]);

  const restore = async (path: string) => {
    setBusy(path);
    try {
      await store.restoreDeleted(path);
      toast.toast("Back in your timeline, exactly as it was.");
      onRestored();
      await load();
    } catch (err) {
      toast.error(message(err));
    } finally {
      setBusy("");
    }
  };

  if (error) {
    return (
      <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive-bg px-3 py-2 text-sm text-destructive">
        {error}
      </p>
    );
  }
  if (!items) return <p className="py-10 text-sm text-muted-foreground">Reading the history…</p>;
  if (!items.length) {
    return (
      <div className="flex flex-col items-start gap-2 py-10">
        <p className="text-base font-medium">Nothing has been deleted</p>
        <p className="max-w-prose text-sm text-muted-foreground">
          Anything you delete stays in this Roll's history and is listed here, so you can put it back.
        </p>
      </div>
    );
  }

  return (
    <section className="flex flex-col gap-3">
      <h1 className="text-base font-medium">Deleted events</h1>
      <p className="max-w-prose text-sm text-muted-foreground">
        Deleting an event takes it off your timeline; Git still has every word of it. Putting one back is a new change, so the
        history shows both.
      </p>
      <ul className="flex flex-col gap-2">
        {items.map((d) => (
          <li key={`${d.path}:${d.deletedAt}`} className="flex items-start gap-3 rounded-lg border border-border bg-card p-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{d.title || "(no text)"}</p>
              <p className="truncate text-xs text-muted-foreground">
                {d.path} · deleted {d.deletedAt.slice(0, 10)}
              </p>
            </div>
            <Button size="sm" variant="secondary" disabled={busy === d.path} onClick={() => void restore(d.path)}>
              {busy === d.path ? "Putting it back…" : "Put it back"}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
