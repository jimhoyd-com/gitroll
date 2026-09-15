import { Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LoadedEntry } from "../../core/layout.ts";
import { slugify } from "../../core/util.ts";
import { COPY } from "../copy.ts";
import { navigate, replaceQuery, storeChanged, timelineHref, useRoll, useRoute, useStoreVersion } from "../hooks/useStore.ts";
import type { Connection } from "../hooks/useStore.ts";
import { message } from "../lib/format.ts";
import { toggleFilter } from "../lib/query.ts";
import type { SuggestContext } from "../lib/query.ts";
import type { Store, SyncResult } from "../store.ts";
import { AskPanel } from "./AskPanel.tsx";
import type { AskState } from "./AskPanel.tsx";
import { Composer, toChanges, toInput, valueFor } from "./Composer.tsx";
import type { ComposerValue } from "./Composer.tsx";
import { emptyValue } from "./Composer.tsx";
import { EntryDetail } from "./EntryDetail.tsx";
import { QueryBar } from "./QueryBar.tsx";
import { ShortcutsDialog } from "./ShortcutsDialog.tsx";
import { SyncIndicator, useSync } from "./SyncStatus.tsx";
import { Timeline } from "./Timeline.tsx";
import { TopicsPage } from "./TopicsPage.tsx";
import { Button } from "./ui/button.tsx";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog.tsx";
import { useAsk } from "./ui/ask.tsx";
import { useToast } from "./ui/toast.tsx";

export function App({ store }: { store: Store }) {
  const [connection, setConnection] = useState<Connection>("ok");
  const onConnectionChange = useCallback((c: Connection) => setConnection(c), []);
  const version = useStoreVersion(store, onConnectionChange);
  const { entries, index, projects } = useRoll(store, version);
  const route = useRoute();
  const toast = useToast();
  const ask = useAsk();

  const info = store.info();
  const projectName = useCallback((slug: string) => slug, []);
  const attachmentUrl = useCallback((a: Parameters<Store["attachmentUrl"]>[0]) => store.attachmentUrl(a), [store]);

  const query = route.name === "timeline" ? route.query : "";
  const results = useMemo(() => index.search(query), [index, query]);
  const totals = useMemo(() => {
    const map = new Map<string, number>();
    for (const e of results) if (e.amount) map.set(e.amount.currency, (map.get(e.amount.currency) ?? 0) + e.amount.value);
    return map;
  }, [results]);

  const [editing, setEditing] = useState<LoadedEntry | null>(null);
  const [value, setValue] = useState<ComposerValue>(emptyValue);
  const [saving, setSaving] = useState(false);
  const [askState, setAskState] = useState<AskState | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const composerAnchor = useRef<HTMLDivElement>(null);

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
    status: info.sync,
    enabled: connection === "ok" && !!info.sync.remote,
    onFinished: onSyncFinished,
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
        const { notices } = await store.updateEntry(editing.path, changes, value.files, editing);
        toast.toast([COPY.edited, ...notices].join(" "));
        setEditing(null);
        setValue(emptyValue());
        navigate(`#/entry/${encodeURIComponent(editing.path)}`);
      } else {
        const { input, error } = toInput(value);
        if (error) {
          toast.error(error);
          return;
        }
        const { notices } = await store.addEntry(input, value.files);
        toast.toast([value.files.length ? COPY.savedWithFiles(value.files.length) : COPY.saved, ...notices].join(" "));
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
  }, [saving, editing, value, store, toast]);

  const askRoll = useCallback(
    async (question: string) => {
      const q = question.trim();
      if (!q) {
        searchRef.current?.focus();
        toast.toast(COPY.askPlaceholder);
        return;
      }
      setAskState({ question: q, loading: true, answer: "", sources: [], error: "" });
      try {
        const { answer, sources } = await store.ask(q);
        setAskState({ question: q, loading: false, answer, sources, error: "" });
      } catch (err) {
        setAskState({ question: q, loading: false, answer: "", sources: [], error: message(err) });
      }
    },
    [store, toast],
  );

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
        await store.deleteEntry(entry.path, entry);
        storeChanged();
        toast.toast(COPY.deleted);
        navigate("#/");
      } catch (err) {
        toast.error(message(err));
      }
    },
    [ask, store, toast],
  );

  /**
   * Topics need no setup: naming one on an event is all there is to it. This
   * only starts a search for a topic, so people can see what is already in use.
   */
  const newTopic = useCallback(async () => {
    const name = await ask.prompt({
      title: COPY.newTopicTitle,
      description: COPY.newTopicBody,
      label: COPY.newTopicLabel,
      placeholder: COPY.newTopicPlaceholder,
      confirmLabel: "Show",
    });
    const slug = slugify(name ?? "");
    if (slug) navigate(timelineHref(`topic:${slug}`));
  }, [ask]);

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
      } else if (ev.key === "g") {
        // g then t: topics. A two-key sequence, like every other timeline app.
        const next = (e2: KeyboardEvent) => {
          if (e2.key === "t") navigate("#/topics");
          if (e2.key === "i") navigate("#/");
          window.removeEventListener("keydown", next);
        };
        window.addEventListener("keydown", next);
        setTimeout(() => window.removeEventListener("keydown", next), 1200);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [startNew, route.name]);

  const suggestCtx: SuggestContext = useMemo(
    () => ({
      projects: projects.map((p) => ({ slug: p, name: p })),
      tags: [...new Set(entries.flatMap((e) => e.tags))].sort(),
    }),
    [projects, entries],
  );

  // The Roll's name belongs in the tab title: people keep several open.
  useEffect(() => {
    document.title = `${info.name} · GitRoll`;
  }, [info.name]);

  const entry = route.name === "entry" ? (entries.find((e) => e.path === route.id) ?? null) : null;

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
          <a
            href="#/"
            className="mr-auto min-w-0 truncate rounded text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {info.name}
          </a>

          <nav aria-label="Sections" className="flex items-center gap-1">
            <NavLink href="#/" current={route.name === "timeline"}>
              Timeline
            </NavLink>
            <NavLink href="#/topics" current={route.name === "topics"}>
              {COPY.topics}
            </NavLink>
          </nav>

          <SyncIndicator state={sync} status={info.sync} />

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
            <div ref={composerAnchor}>
              <Composer
                value={value}
                onChange={setValue}
                projects={projects}
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
              projectName={projectName}
              resultCount={results.length}
              totals={totals}
              askEnabled={info.ai.enabled}
              onAsk={(q) => void askRoll(q)}
              inputRef={searchRef}
            />

            {askState && (
              <AskPanel
                state={askState}
                entries={entries}
                  projectName={projectName}
                attachmentUrl={attachmentUrl}
                onFilter={onFilter}
                onClose={() => setAskState(null)}
              />
            )}

            <Timeline
              entries={results}
              projectName={projectName}
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
          </>
        )}

        {route.name === "topics" && <TopicsPage entries={entries} projects={projects} onCreate={() => void newTopic()} />}

        {route.name === "entry" && (
          <EntryDetail
            entry={entry}
            projectName={projectName}
            attachmentUrl={attachmentUrl}
            onFilter={onFilter}
            onEdit={() => {
              if (!entry) return;
              setEditing(entry);
              setValue(valueFor(entry));
            }}
            onDelete={() => entry && void deleteEntry(entry)}
            loadHistory={(id) => store.history(id)}
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
                projects={projects}
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
