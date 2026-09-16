import { Undo2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { RemovedEntry, Store } from "../store.ts";
import { message, relativeTime } from "../lib/format.ts";
import { Button } from "./ui/button.tsx";

/*
  Everything that has left this Roll, and the way back.

  Deleting takes an entry off the timeline; Git still has every word of it, and
  this is where somebody finds it again without knowing a single Git command.
  Putting one back is a new commit, so the deletion and the recovery both stay
  in the record — the same promise `gitroll history` makes in the terminal, kept
  the same way here.

  Each row shows the entry as it was, so a person can tell which one they meant
  before bringing it back rather than after.
*/

/**
 * The entry's text without the heading that is already the row's title.
 *
 * What is stored is the whole Markdown file, heading and all. Showing it raw
 * would print the title twice, the second time with its "#" still attached.
 */
function preview(body: string, title: string): string {
  const lines = body.split("\n");
  const first = lines[0]?.replace(/^#+\s*/, "").trim();
  if (first && first === title.trim()) lines.shift();
  return lines.join("\n").trim();
}

export interface RemovedProps {
  store: Store;
  onRestored(): void;
}

export function Removed({ store, onRestored }: RemovedProps) {
  const [items, setItems] = useState<RemovedEntry[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  const load = () =>
    store
      .removed()
      .then(setItems)
      .catch((e) => setError(message(e)));

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load closes over the store only
  }, [store]);

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!items) return null;

  if (!items.length) {
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-dashed border-border p-6">
        <p className="text-sm">Nothing has been removed from this Roll.</p>
        <p className="text-sm text-muted-foreground">
          Deleting an entry only takes it off the timeline. Anything deleted stays in the history, and would be listed here
          with a way to put it back.
        </p>
      </div>
    );
  }

  const restore = (item: RemovedEntry) => {
    setBusy(item.id);
    void store
      .restoreRemoved(item.id)
      .then(() => {
        onRestored();
        return load();
      })
      .catch((e) => setError(message(e)))
      .finally(() => setBusy(""));
  };

  return (
    <section className="flex flex-col gap-3" aria-labelledby="removed-heading">
      <h2 id="removed-heading" className="text-sm font-semibold">
        Removed from this Roll
      </h2>
      <p className="text-xs text-muted-foreground">
        Nothing here was lost — it is all in Git. Putting one back is a new commit, so the deletion stays in the history too.
      </p>
      <ol className="flex flex-col gap-3">
        {items.map((item) => (
          <li key={item.id} className="flex flex-col gap-2 rounded-lg border border-border p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-sm font-medium">{item.title || "(no text)"}</p>
              <p className="text-xs text-muted-foreground">Deleted {relativeTime(item.deletedAt)}</p>
            </div>
            {preview(item.body, item.title) && (
              <p className="line-clamp-4 whitespace-pre-wrap text-sm text-muted-foreground">{preview(item.body, item.title)}</p>
            )}
            <div>
              <Button variant="secondary" size="sm" disabled={busy === item.id} onClick={() => restore(item)}>
                <Undo2 aria-hidden="true" />
                Put it back
              </Button>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
