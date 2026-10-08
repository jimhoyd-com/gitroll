import { Bookmark, BookmarkPlus, Pencil, Trash2 } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { expandSavedSearches } from "../../core/search.ts";
import { slugify } from "../../core/util.ts";
import { message } from "../lib/format.ts";
import { cn } from "../lib/utils.ts";
import type { SavedSearchesStore } from "../store.ts";
import { useAsk } from "./ui/ask.tsx";
import { Button } from "./ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog.tsx";
import { Input } from "./ui/input.tsx";
import { useToast } from "./ui/toast.tsx";

/*
  Saved searches, as `gitroll find "…" --save <name>` keeps them: in your
  settings folder on this computer, not in the Roll, so the same ones are
  offered in every Roll you open here and nothing is committed. A search
  saved in the terminal shows up here, and one saved here works as
  `gitroll find @name`.
*/

export type SavedList = [name: string, query: string][];

/** The saved searches, read again whenever the Roll changes or the window comes back. `loaded` is false until they have been read once. */
export function useSavedSearches(store: SavedSearchesStore | null, version: string) {
  const [list, setList] = useState<SavedList>([]);
  const [loaded, setLoaded] = useState(false);
  const reload = useCallback(async () => {
    if (!store) return;
    try {
      setList(Object.entries(await store.savedSearches()));
      setLoaded(true);
    } catch {
      // Kept as they were; the connection banner says when the app has stopped.
    }
  }, [store]);
  useEffect(() => {
    void reload();
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [reload, version]);
  return { list, loaded, reload };
}

/**
 * The saved searches every page's search box reads `@name` from; null where
 * the store keeps none (or hasn't read them yet), and `@name` is then left as
 * it was typed.
 */
export const SavedSearchesContext = createContext<SavedList | null>(null);

/**
 * A query with each `@name` replaced by its saved search, as `gitroll` reads
 * one in any command that takes a query, and the error to show when a name
 * isn't saved: an unknown name is said so, not shown as nothing found.
 */
export function useSavedQuery(query: string): { query: string; error: string } {
  const list = useContext(SavedSearchesContext);
  return useMemo(() => savedQuery(list, query), [list, query]);
}

/** useSavedQuery, for the component that holds the list rather than reading it from context. */
export function savedQuery(list: SavedList | null, query: string): { query: string; error: string } {
  if (!list || !query.includes("@")) return { query, error: "" };
  const byName = new Map(list);
  try {
    return { query: expandSavedSearches(query, (name) => byName.get(slugify(name))), error: "" };
  } catch (err) {
    return { query, error: message(err) };
  }
}

/** Says why a search box's `@name` found nothing. */
export function QueryError({ error }: { error: string }) {
  if (!error) return null;
  return (
    <p role="alert" className="text-sm text-destructive">
      {error}
    </p>
  );
}

const chipClass = (on: boolean) =>
  cn(
    "tap-target inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
    on ? "border-transparent bg-primary text-primary-foreground" : "border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground",
  );

/** One button per saved search, beside the quick filters; a click runs it, another clears it. */
export function SavedSearchChips({
  store,
  list,
  reload,
  query,
  onQueryChange,
}: {
  store: SavedSearchesStore;
  list: SavedList;
  reload(): Promise<void>;
  query: string;
  onQueryChange(next: string): void;
}) {
  const ask = useAsk();
  const toast = useToast();
  const [managing, setManaging] = useState(false);
  const current = query.trim();
  const already = list.find(([, q]) => q === current);

  const save = async () => {
    const name = await ask.prompt({
      title: "Save this search",
      description: `"${current}" gets a button under the search box. Saved searches are kept on this computer and work in each of your Rolls.`,
      label: "Name",
      placeholder: "open-incidents",
      confirmLabel: "Save",
    });
    if (!name) return;
    try {
      const saved = await store.saveSearch(name, current);
      await reload();
      toast.toast(`Saved as ${saved}. In the terminal: gitroll find @${saved}`);
    } catch (err) {
      toast.error(message(err));
    }
  };

  return (
    <>
      {list.length > 0 && (
        <div role="group" aria-label="Saved searches" className="flex flex-wrap gap-1.5">
          {list.map(([name, q]) => (
            <button key={name} type="button" aria-pressed={q === current} onClick={() => onQueryChange(q === current ? "" : q)} className={chipClass(q === current)}>
              <Bookmark className="size-3" aria-hidden="true" />
              {name}
            </button>
          ))}
        </div>
      )}
      {current && !already && (
        <button type="button" onClick={() => void save()} className={chipClass(false)}>
          <BookmarkPlus className="size-3" aria-hidden="true" />
          Save search
        </button>
      )}
      {list.length > 0 && (
        <button type="button" onClick={() => setManaging(true)} className={chipClass(false)}>
          <Pencil className="size-3" aria-hidden="true" />
          Edit saved
        </button>
      )}
      <ManageSearches open={managing} onOpenChange={setManaging} store={store} list={list} reload={reload} />
    </>
  );
}

/** Rename and delete, one row per saved search. A deleted one can be put back from the notice. */
function ManageSearches({
  open,
  onOpenChange,
  store,
  list,
  reload,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  store: SavedSearchesStore;
  list: SavedList;
  reload(): Promise<void>;
}) {
  const toast = useToast();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const rename = async (from: string) => {
    if (busy || !name.trim()) return;
    setBusy(true);
    try {
      const saved = await store.renameSearch(from, name);
      await reload();
      setRenaming(null);
      toast.toast(`Renamed to ${saved}.`);
    } catch (err) {
      toast.error(message(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (gone: string, query: string) => {
    try {
      await store.deleteSearch(gone);
      await reload();
      toast.toast(`Deleted ${gone}.`, {
        action: {
          label: "Undo",
          onClick: () => {
            void store
              .saveSearch(gone, query)
              .then(reload)
              .catch((err: unknown) => toast.error(message(err)));
          },
        },
      });
    } catch (err) {
      toast.error(message(err));
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setRenaming(null);
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Saved searches</DialogTitle>
          <DialogDescription>Kept on this computer, for each of your Rolls. In the terminal, run one with gitroll find @name.</DialogDescription>
        </DialogHeader>
        {list.length === 0 ? (
          <p className="text-sm text-muted-foreground">No saved searches left.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {list.map(([key, query]) => (
              <li key={key} className="flex flex-wrap items-center gap-2 py-2">
                {renaming === key ? (
                  <form
                    className="flex w-full flex-wrap items-center gap-2"
                    onSubmit={(ev) => {
                      ev.preventDefault();
                      void rename(key);
                    }}
                  >
                    <Input
                      autoFocus
                      aria-label={`New name for ${key}`}
                      value={name}
                      onChange={(ev) => setName(ev.target.value)}
                      onKeyDown={(ev) => {
                        if (ev.key === "Escape") {
                          ev.stopPropagation();
                          setRenaming(null);
                        }
                      }}
                      className="min-w-0 flex-1"
                    />
                    <Button type="submit" size="sm" disabled={busy || !name.trim()}>
                      Rename
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => setRenaming(null)}>
                      Cancel
                    </Button>
                  </form>
                ) : (
                  <>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{key}</p>
                      <p className="truncate font-mono text-xs text-muted-foreground">{query}</p>
                    </div>
                    <Button
                      variant="ghost"
                      size="iconSm"
                      onClick={() => {
                        setName(key);
                        setRenaming(key);
                      }}
                    >
                      <Pencil aria-hidden="true" />
                      <span className="sr-only">Rename {key}</span>
                    </Button>
                    <Button variant="ghost" size="iconSm" onClick={() => void remove(key, query)}>
                      <Trash2 aria-hidden="true" />
                      <span className="sr-only">Delete {key}</span>
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
