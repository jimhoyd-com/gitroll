import { useEffect, useState } from "react";
import type { ConflictPair, Store } from "../store.ts";
import { filedUnder, message } from "../lib/format.ts";
import { cn } from "../lib/utils.ts";
import { Button } from "./ui/button.tsx";

/*
  When the same event was edited in two places, GitRoll keeps both texts rather
  than choosing. This is where a person chooses.

  Both versions are shown side by side, in full, because the only way to decide
  is to read them. Whatever is picked — this one, that one, or something written
  out of the two — is saved as a new commit, so the version not chosen is still
  in the event's history and can be brought back with Restore.
*/

export interface ConflictsProps {
  store: Store;
  onResolved(): void;
}

export function Conflicts({ store, onResolved }: ConflictsProps) {
  const [pairs, setPairs] = useState<ConflictPair[] | null>(null);
  const [error, setError] = useState("");

  const load = () =>
    store
      .conflicts()
      .then(setPairs)
      .catch((e) => setError(message(e)));

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load closes over the store only
  }, [store]);

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!pairs) return null;
  if (!pairs.length) {
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-dashed border-border p-6">
        <p className="text-sm">Nothing to settle.</p>
        <p className="text-sm text-muted-foreground">
          When an event is changed in two places at once, both versions are kept and they show up here.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Changed in two places</h1>
        <p className="text-sm text-muted-foreground">
          Both versions are here. Pick one, or write the version you want. Whichever you choose is saved as a new commit, and the
          other stays in the event's history.
        </p>
      </div>
      {pairs.map((pair) => (
        <ConflictCard
          key={pair.entry.id}
          pair={pair}
          store={store}
          onResolved={() => {
            void load();
            onResolved();
          }}
        />
      ))}
    </div>
  );
}

function ConflictCard({ pair, store, onResolved }: { pair: ConflictPair; store: Store; onResolved(): void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const settle = async (choice: { keep: "mine" | "theirs" } | { text: string }) => {
    setBusy(true);
    setError("");
    try {
      // By the entry, not by its file: a month's file holds many entries, so a
      // path names the month and would settle whichever one came first in it.
      await store.resolveConflict(pair.entry.id, choice);
      onResolved();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border p-3" aria-label={pair.entry.title}>
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium">{pair.entry.title}</h2>
        {/* Where to find it: the month it is filed under, or the file it has to itself. */}
        <span className="font-mono text-xs text-muted-foreground">{filedUnder(pair.entry.path) ?? pair.entry.path}</span>
      </header>

      {draft === null ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Version label="This computer" text={pair.mine} onKeep={() => void settle({ keep: "mine" })} busy={busy} />
          <Version label={`From elsewhere (${pair.noted})`} text={pair.theirs} onKeep={() => void settle({ keep: "theirs" })} busy={busy} />
        </div>
      ) : (
        <textarea
          aria-label="The version to keep"
          rows={12}
          value={draft}
          onChange={(ev) => setDraft(ev.target.value)}
          className="w-full rounded-md border border-input bg-card px-3 py-2 font-mono text-xs shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        />
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex flex-wrap justify-end gap-2">
        {draft === null ? (
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => setDraft(`${pair.mine}\n\n${pair.theirs}`)}>
            Write one out of both
          </Button>
        ) : (
          <>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setDraft(null)}>
              Back to the two versions
            </Button>
            <Button size="sm" disabled={busy || !draft.trim()} onClick={() => void settle({ text: draft })}>
              Save this version
            </Button>
          </>
        )}
      </div>
    </section>
  );
}

function Version({ label, text, onKeep, busy }: { label: string; text: string; onKeep(): void; busy: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">{label}</h3>
      <pre className={cn("max-h-64 overflow-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap")}>{text}</pre>
      <Button variant="secondary" size="sm" disabled={busy} onClick={onKeep}>
        Keep this one
      </Button>
    </div>
  );
}
