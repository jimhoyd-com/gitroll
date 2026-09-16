import { Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LoadedEntry } from "../../core/layout.ts";
import { COPY, WEB_SAFETY } from "../copy.ts";
import { navigate, replaceQuery, storeChanged, timelineHref, useRoll, useRoute, useStoreVersion } from "../hooks/useStore.ts";
import type { Connection } from "../hooks/useStore.ts";
import { message } from "../lib/format.ts";
import { clearDraft, loadDraft, saveDraft } from "../lib/draft.ts";
import { toggleFilter } from "../lib/query.ts";
import type { SuggestContext } from "../lib/query.ts";
import type { Store, SyncResult } from "../store.ts";
import { Conflicts } from "./Conflicts.tsx";
import { Removed } from "./Removed.tsx";
import { FirstRun } from "./FirstRun.tsx";
import { RollName } from "./RollName.tsx";
import { Storage } from "./Storage.tsx";
import { RollBranch } from "./RollBranch.tsx";
import { Composer, toChanges, toInput, valueFor } from "./Composer.tsx";
import type { ComposerValue } from "./Composer.tsx";
import { emptyValue } from "./Composer.tsx";
import { EntryDetail } from "./EntryDetail.tsx";
import { QueryBar } from "./QueryBar.tsx";
import { ShortcutsDialog } from "./ShortcutsDialog.tsx";
import { SyncIndicator, useSync } from "./SyncStatus.tsx";
import { Timeline } from "./Timeline.tsx";
import { Button } from "./ui/button.tsx";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog.tsx";
import { useAsk } from "./ui/ask.tsx";
import { useToast } from "./ui/toast.tsx";
import { savedLine } from "../../core/safety.ts";

export function App({ store }: { store: Store }) {
  const [connection, setConnection] = useState<Connection>("ok");
  const onConnectionChange = useCallback((c: Connection) => setConnection(c), []);
  const version = useStoreVersion(store, onConnectionChange);
  const { entries, index } = useRoll(store, version);
  const route = useRoute();
  const toast = useToast();
  const ask = useAsk();

  const info = store.info();
  const attachmentUrl = useCallback((a: Parameters<Store["attachmentUrl"]>[0]) => store.attachmentUrl(a), [store]);

  const conflictCount = useMemo(() => entries.filter((e) => e.tags.includes("conflict")).length, [entries]);

  const query = route.name === "timeline" ? route.query : "";
  const results = useMemo(() => index.search(query), [index, query]);
  const totals = useMemo(() => {
    const map = new Map<string, number>();
    for (const e of results) if (e.amount) map.set(e.amount.currency, (map.get(e.amount.currency) ?? 0) + e.amount.value);
    return map;
  }, [results]);

  const [editing, setEditing] = useState<LoadedEntry | null>(null);
  // What was typed and not saved comes back with the window.
  const [value, setValue] = useState<ComposerValue>(() => {
    const draft = loadDraft(store.info().location);
    return draft ? { ...emptyValue(), ...draft } : emptyValue();
  });
  const [saving, setSaving] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [namingOpen, setNamingOpen] = useState(false);
  const [backupOpen, setBackupOpen] = useState(false);
  const [composerOpen, setComposerOpen] = useState(() => !!loadDraft(store.info().location));
  const searchRef = useRef<HTMLInputElement>(null);
  const composerAnchor = useRef<HTMLDivElement>(null);

  // Only a new entry is worth keeping: an edit belongs to an entry that already
  // exists, and restoring one into a different window would be a surprise.
  useEffect(() => {
    if (editing) return;
    const { text, amount, when, time, extraTags } = value;
    saveDraft(info.location, { text, amount, when, time, extraTags });
  }, [value, editing, info.location]);

  const onSyncFinished = useCallback(
    (result: SyncResult) => {
      // Only speak up when something needs saying. A quiet, successful, automatic
      // backup is exactly what someone wants not to be told about.
      if (!result.ok && result.code !== "no-remote") toast.error(result.message);
      else if (result.merged?.length) toast.toast(result.message);
    },
    [toast],
  );

  const sync = useSync({
    store,
    enabled: connection === "ok" && !!info.sync.remote,
    onFinished: onSyncFinished,
    onBackedUp: storeChanged,
  });

  const setQuery = useCallback(
    (next: string) => {
      if (route.name === "timeline") replaceQuery(next);
      else navigate(timelineHref(next));
    },
    [route.name],
  );

  const onFilter = useCallback(
    (key: string, val: string) => {
      const base = route.name === "timeline" ? route.query : "";
      const next = toggleFilter(base, key, val);
      if (route.name === "timeline") replaceQuery(next);
      else navigate(timelineHref(next));
    },
    [route],
  );

  const startNew = useCallback(() => {
    setEditing(null);
    setValue(emptyValue());
    setComposerOpen(true);
    if (route.name !== "timeline") navigate("#/");
    // Two frames: one for the composer to expand, one for its textarea to exist.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        composerAnchor.current?.querySelector("textarea")?.focus();
        composerAnchor.current?.scrollIntoView({ block: "nearest" });
      }),
    );
  }, [route.name]);

  const save = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    try {
      if (editing) {
        const { changes, error } = toChanges(value, editing);
        if (error) {
          toast.error(error);
          return;
        }
        // An entry is named by its id, not by its file: a monthly file holds
        // many, and the store on the other side may be either kind.
        const { notices } = await store.updateEntry(editing.id, changes, value.files, editing);
        toast.toast([COPY.edited, ...notices].join(" "));
        setEditing(null);
        setValue(emptyValue());
        navigate(`#/entry/${encodeURIComponent(editing.id)}`);
      } else {
        const { input, error } = toInput(value);
        if (error) {
          toast.error(error);
          return;
        }
        const { notices } = await store.addEntry(input, value.files);
        // The same answer the badge gives, said once at the moment it matters.
        toast.toast([value.files.length ? COPY.savedWithFiles(value.files.length) : COPY.saved, savedLine(info.sync, WEB_SAFETY), ...notices].join(" "));
        clearDraft(info.location);
        setValue(emptyValue());
        setComposerOpen(false);
      }
    } catch (err) {
      toast.error(message(err));
    } finally {
      // The Roll changed on disk; redraw now rather than at the next poll.
      storeChanged();
      setSaving(false);
    }
  }, [saving, editing, value, store, toast, info.sync]);


  const deleteEntry = useCallback(
    async (entry: LoadedEntry) => {
      const yes = await ask.confirm({
        title: COPY.confirmDeleteTitle,
        description: COPY.confirmDeleteBody,
        confirmLabel: COPY.confirmDeleteAction,
        destructive: true,
      });
      if (!yes) return;
      try {
        await store.deleteEntry(entry.id, entry);
        storeChanged();
        // The way back, offered where the mistake was made. It stays available
        // afterwards under Removed — this is the shortcut, not the only door.
        // A store that can't put things back says only what it did.
        const put = store.restoreRemoved?.bind(store);
        toast.toast(COPY.deleted, {
          action: put
            ? {
                label: COPY.undoDelete,
                onClick: () => {
                  void put(entry.id)
                    .then((back) => {
                      storeChanged();
                      toast.toast(COPY.restored);
                      navigate(`#/entry/${encodeURIComponent(back.id)}`);
                    })
                    .catch((err) => toast.error(message(err)));
                },
              }
            : undefined,
        });
        navigate("#/");
      } catch (err) {
        toast.error(message(err));
      }
    },
    [ask, store, toast],
  );

  /*
    #/new is the browser's answer to `gitroll log`: a bookmark, a desktop
    shortcut or a launcher lands on the timeline with the composer open and the
    cursor in it, rather than on a page where writing is one more click away.
  */
  useEffect(() => {
    if (route.name !== "new") return;
    navigate("#/");
    startNew();
  }, [route.name, startNew]);

  // Keyboard shortcuts, ignored while typing.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const t = ev.target as HTMLElement;
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable) return;
      if (ev.key === "n") {
        ev.preventDefault();
        startNew();
      } else if (ev.key === "/") {
        ev.preventDefault();
        if (route.name !== "timeline") navigate("#/");
        requestAnimationFrame(() => searchRef.current?.focus());
      } else if (ev.key === "?") {
        ev.preventDefault();
        setShortcutsOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [startNew, route.name]);

  const suggestCtx: SuggestContext = useMemo(
    () => ({
      tags: [...new Set(entries.flatMap((e) => e.tags))].sort(),
    }),
    [entries],
  );

  // The Roll's name belongs in the tab title: people keep several open.
  useEffect(() => {
    document.title = `${info.name} · GitRoll`;
  }, [info.name]);

  // A URL may name an entry by its id (what the app writes now) or by its path
  // (what a link written before this did). Both still open the same entry.
  const entry = route.name === "entry" ? (entries.find((e) => e.id === route.id || e.path === route.id) ?? null) : null;

  return (
    <div className="min-h-dvh">
      <a
        href="#main"
        className="sr-only-focusable absolute left-3 top-3 z-[60] rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground"
      >
        Skip to the main content
      </a>

      <header className="sticky top-0 z-30 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-3xl items-center gap-2 px-4">
          {/* The name is where somebody looks to change the name. */}
          <button
            type="button"
            onClick={() => store.rename && setNamingOpen(true)}
            title={store.rename ? "Name this Roll" : undefined}
            className="mr-auto min-w-0 truncate rounded text-sm font-semibold transition-colors hover:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {info.name}
          </button>

          <RollBranch status={info.sync} className="mr-1 max-sm:hidden" />

          <nav aria-label="Sections" className="flex items-center gap-1">
            <NavLink href="#/" current={route.name === "timeline"}>
              Timeline
            </NavLink>
            {conflictCount > 0 && (
              <NavLink href="#/conflicts" current={route.name === "conflicts"}>
                Conflicts
                <span className="ml-1 rounded-full bg-del-bg px-1.5 text-xs text-del">{conflictCount}</span>
              </NavLink>
            )}
            {route.name === "removed" && (
              <NavLink href="#/removed" current>
                Removed
              </NavLink>
            )}
            {route.name === "storage" && (
              <NavLink href="#/storage" current>
                Storage
              </NavLink>
            )}
          </nav>

          <SyncIndicator state={sync} status={info.sync} open={backupOpen} onOpenChange={setBackupOpen} />

          <Button size="sm" onClick={startNew} className="max-sm:size-9 max-sm:rounded-full max-sm:p-0">
            <Plus aria-hidden="true" />
            <span className="max-sm:sr-only">{COPY.composerOpen}</span>
          </Button>
        </div>
      </header>

      <main id="main" tabIndex={-1} className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-4 outline-none">
        <Banners connection={connection} warnings={info.warnings} problems={info.problems} />

        {route.name === "timeline" && (
          <>
            <FirstRun
              name={info.name}
              status={info.sync}
              entries={entries.length}
              onName={store.rename ? () => setNamingOpen(true) : undefined}
              onBackUp={store.backup ? () => setBackupOpen(true) : undefined}
            />

            <div ref={composerAnchor}>
              <Composer
                value={value}
                onChange={setValue}
                editing={null}
                maxAttachmentBytes={info.maxAttachmentBytes}
                attachmentUrl={attachmentUrl}
                onSubmit={() => void save()}
                saving={saving}
                collapsible
                expanded={composerOpen}
                onExpandedChange={setComposerOpen}
              />
            </div>

            <QueryBar
              query={query}
              onQueryChange={setQuery}
              suggestCtx={suggestCtx}
              resultCount={results.length}
              totals={totals}
              inputRef={searchRef}
            />

            <Timeline
              entries={results}
              attachmentUrl={attachmentUrl}
              onFilter={onFilter}
              emptyState={
                query.trim() ? (
                  <div className="flex flex-col items-start gap-2 py-10">
                    <p className="text-sm">{COPY.noMatches}</p>
                    <p className="text-sm text-muted-foreground">{COPY.noMatchesHint}</p>
                    <Button variant="secondary" size="sm" onClick={() => setQuery("")}>
                      {COPY.clearFilters}
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-col items-start gap-2 py-10">
                    <p className="text-base font-medium">{COPY.emptyTitle}</p>
                    <p className="max-w-prose text-sm text-muted-foreground">{COPY.emptyBody}</p>
                  </div>
                )
              }
            />

            {/* Quiet, and always there: somebody looking for something they
                deleted is not in the mood to go hunting for the way back. */}
            <p className="pb-2 text-center text-xs text-muted-foreground">
              {store.removed && (
                <a
                  href="#/removed"
                  className="rounded underline underline-offset-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  {COPY.removedLink}
                </a>
              )}
              {store.removed && store.periods && (
                <span className="mx-2" aria-hidden="true">
                  ·
                </span>
              )}
              {store.periods && (
                <a
                  href="#/storage"
                  className="rounded underline underline-offset-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  {COPY.storageLink}
                </a>
              )}
            </p>
          </>
        )}


        {route.name === "conflicts" && <Conflicts store={store} onResolved={storeChanged} />}

        {route.name === "removed" && <Removed store={store} onRestored={storeChanged} />}

        {route.name === "storage" && <Storage store={store} onChanged={storeChanged} />}

        <RollName store={store} name={info.name} open={namingOpen} onOpenChange={setNamingOpen} onRenamed={storeChanged} />

        {route.name === "entry" && (
          <EntryDetail
            entry={entry}
            entries={entries}
            attachmentUrl={attachmentUrl}
            onFilter={onFilter}
            onEdit={() => {
              if (!entry) return;
              setEditing(entry);
              setValue(valueFor(entry));
            }}
            onDelete={() => entry && void deleteEntry(entry)}
            loadHistory={(id) => store.history(id)}
            onRestore={async (commit) => {
              if (!entry) return;
              try {
                await store.restoreVersion(entry.id, commit);
                storeChanged();
                toast.toast("That version is back, saved as a new commit. The others are still in History.");
              } catch (err) {
                toast.error(message(err));
              }
            }}
          />
        )}
      </main>

      {/* Editing happens in a dialog: it is a detour from reading, and it should
          be obvious that leaving it without saving loses the change. */}
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (open) return;
          void (async () => {
            const dirty = editing && (value.text !== editing.body || value.files.length > 0);
            if (
              dirty &&
              !(await ask.confirm({
                title: COPY.confirmDiscardTitle,
                description: COPY.confirmDiscardBody,
                confirmLabel: COPY.confirmDiscardAction,
                cancelLabel: COPY.keepWriting,
                destructive: true,
              }))
            ) {
              return;
            }
            setEditing(null);
            setValue(emptyValue());
          })();
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit this event</DialogTitle>
          </DialogHeader>
          {editing && (
            <div className="overflow-y-auto">
              <Composer
                value={value}
                onChange={setValue}
                editing={editing}
                maxAttachmentBytes={info.maxAttachmentBytes}
                attachmentUrl={attachmentUrl}
                onSubmit={() => void save()}
                saving={saving}
                autoFocus
                onCancel={() => {
                  setEditing(null);
                  setValue(emptyValue());
                }}
              />
            </div>
          )}
        </DialogContent>
      </Dialog>

      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </div>
  );
}

function NavLink({ href, current, children }: { href: string; current: boolean; children: React.ReactNode }) {
  return (
    <a
      href={href}
      aria-current={current ? "page" : undefined}
      className={
        current
          ? "rounded-md bg-muted px-2.5 py-1.5 text-sm font-medium text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          : "rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      }
    >
      {children}
    </a>
  );
}

function Banners({
  connection,
  warnings,
  problems,
}: {
  connection: Connection;
  warnings: string[];
  problems: { path: string; error: string }[];
}) {
  if (connection === "ok" && !warnings.length && !problems.length) return null;
  return (
    <div className="flex flex-col gap-2">
      {connection !== "ok" && (
        <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive-bg px-3 py-2 text-sm text-destructive">
          {connection === "signed-out" ? COPY.signedOutBody : COPY.stoppedBody}
        </p>
      )}
      {warnings.map((w) => (
        <p key={w} className="rounded-lg border border-border bg-muted px-3 py-2 text-sm">
          {w}
        </p>
      ))}
      {problems.length > 0 && (
        <details className="rounded-lg border border-border bg-muted px-3 py-2 text-sm">
          <summary className="cursor-pointer">
            {problems.length === 1 ? "A file in this Roll couldn't be read" : `${problems.length} files in this Roll couldn't be read`}
          </summary>
          <ul className="mt-2 flex flex-col gap-1 text-xs">
            {problems.map((p) => (
              <li key={p.path}>
                <code className="font-mono">{p.path}</code>: {p.error}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
