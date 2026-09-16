import { Plus, Sparkles } from "lucide-react";
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
import { discardDraft, readDraft, rememberRoll, writeDraft } from "../drafts.ts";
import { AiSettingsDialog } from "./AiSettings.tsx";
import { AskPanel } from "./AskPanel.tsx";
import { Conflicts } from "./Conflicts.tsx";
import { DeletedPage } from "./DeletedPage.tsx";
import { RollBranch } from "./RollBranch.tsx";
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

  const conflictCount = useMemo(() => entries.filter((e) => e.tags.includes("conflict")).length, [entries]);

  const query = route.name === "timeline" ? route.query : "";
  const results = useMemo(() => index.search(query), [index, query]);
  const totals = useMemo(() => {
    const map = new Map<string, number>();
    for (const e of results) if (e.amount) map.set(e.amount.currency, (map.get(e.amount.currency) ?? 0) + e.amount.value);
    return map;
  }, [results]);

  // A Roll is identified by its folder, so two Rolls open in two tabs keep
  // their drafts apart.
  const rollKey = info.location;
  const [editing, setEditing] = useState<LoadedEntry | null>(null);
  const [value, setValue] = useState<ComposerValue>(() => fromDraft(readDraft(info.location, null)) ?? emptyValue());
  const [saving, setSaving] = useState(false);
  const [askState, setAskState] = useState<AskState | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  // A draft kept from last time opens with it, so writing that survived a
  // reload is visible rather than hidden behind a collapsed box.
  const [composerOpen, setComposerOpen] = useState(() => !!readDraft(info.location, null));
  const searchRef = useRef<HTMLInputElement>(null);
  const composerAnchor = useRef<HTMLDivElement>(null);

  // Everything typed is written to this browser's own storage as it is typed:
  // a reload, a closed tab or a server that stopped is not a reason to lose
  // somebody's writing. Only saving or a deliberate discard removes a draft.
  const baseline = useMemo(() => (editing ? JSON.stringify(stripFiles(valueFor(editing))) : null), [editing]);
  useEffect(() => {
    if (saving) return;
    const target = editing?.path ?? null;
    const plain = stripFiles(value);
    const empty = !plain.text.trim() && !plain.projects.length && !plain.amount.trim() && !value.files.length;
    if (baseline === null ? empty : JSON.stringify(plain) === baseline) discardDraft(rollKey, target);
    else writeDraft(rollKey, target, { ...plain, attachments: value.files.map((f) => f.name) });
  }, [value, editing, baseline, rollKey, saving]);

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

  /**
   * Opens the composer for a new event. It never clears what is already there:
   * "Log something" is how a person returns to writing, and a button that wipes
   * a half-written event is a button that loses it.
   */
  const startNew = useCallback(() => {
    setEditing(null);
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
        discardDraft(rollKey, editing.path);
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
        discardDraft(rollKey, null);
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
  }, [saving, editing, value, store, toast, rollKey]);

  const askRoll = useCallback(
    async (question: string) => {
      if (!info.ai.enabled) {
        // Each reason has a different way out, so say which one this is.
        if (!info.ai.configured || !info.ai.on) return setAiOpen(true);
        return toast.error("Ask is turned off for this Roll (ai: false in .gitroll/config.yaml).");
      }
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
        // Undo, here, now — not a hunt through Git history for something that
        // was deleted by mistake three seconds ago.
        toast.toast(COPY.deleted, {
          action: {
            label: "Undo",
            onClick: () => {
              void (async () => {
                try {
                  await store.restoreDeleted(entry.path);
                  storeChanged();
                  toast.toast("Back in your timeline, exactly as it was.");
                  navigate(`#/entry/${encodeURIComponent(entry.path)}`);
                } catch (err) {
                  toast.error(message(err));
                }
              })();
            },
          },
        });
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
    rememberRoll({ name: info.name, location: info.location });
  }, [info.name, info.location]);

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

          <RollBranch status={info.sync} className="mr-1 max-sm:hidden" />

          <nav aria-label="Sections" className="flex items-center gap-1">
            <NavLink href="#/" current={route.name === "timeline"}>
              Timeline
            </NavLink>
            <NavLink href="#/topics" current={route.name === "topics"}>
              {COPY.topics}
            </NavLink>
            <NavLink href="#/deleted" current={route.name === "deleted"}>
              Deleted
            </NavLink>
            {conflictCount > 0 && (
              <NavLink href="#/conflicts" current={route.name === "conflicts"}>
                Conflicts
                <span className="ml-1 rounded-full bg-del-bg px-1.5 text-xs text-del">{conflictCount}</span>
              </NavLink>
            )}
          </nav>

          <Button
            variant="ghost"
            size="iconSm"
            title={info.ai.enabled ? `Ask uses ${info.ai.model}` : "Set up Ask"}
            onClick={() => setAiOpen(true)}
          >
            <Sparkles aria-hidden="true" />
            <span className="sr-only">Ask settings</span>
          </Button>

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
                templates={info.templates}
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
              quickFilters={info.filters}
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
                onDraft={(text) => {
                  // An answer is a draft, never a save: it lands in the composer,
                  // where the person edits it and decides whether to keep it.
                  // Anything already written there is theirs, so it is added to
                  // rather than replaced.
                  setValue((current) => ({ ...current, text: current.text.trim() ? `${current.text.trimEnd()}\n\n${text}` : text }));
                  setComposerOpen(true);
                  setAskState(null);
                  toast.toast("Drafted from the answer. Read it, change what's wrong, then Save.");
                  composerAnchor.current?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
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

        {route.name === "conflicts" && <Conflicts store={store} onResolved={storeChanged} />}

        {route.name === "deleted" && <DeletedPage store={store} onRestored={storeChanged} />}

        {route.name === "entry" && (
          <EntryDetail
            entry={entry}
            entries={entries}
            projectName={projectName}
            attachmentUrl={attachmentUrl}
            onFilter={onFilter}
            onEdit={() => {
              if (!entry) return;
              const kept = readDraft(rollKey, entry.path);
              setEditing(entry);
              setValue(fromDraft(kept) ?? valueFor(entry));
              if (kept) {
                toast.toast(COPY.draftKept);
                if (kept.attachments.length) toast.toast(COPY.draftFiles(kept.attachments));
              }
            }}
            onDelete={() => entry && void deleteEntry(entry)}
            loadHistory={(id) => store.history(id)}
            onRestore={async (commit) => {
              if (!entry) return;
              try {
                await store.restoreVersion(entry.path, commit);
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
            discardDraft(rollKey, editing?.path ?? null);
            setEditing(null);
            setValue(fromDraft(readDraft(rollKey, null)) ?? emptyValue());
            toast.toast(COPY.draftDiscarded);
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
                templates={info.templates}
                editing={editing}
                maxAttachmentBytes={info.maxAttachmentBytes}
                attachmentUrl={attachmentUrl}
                onSubmit={() => void save()}
                saving={saving}
                autoFocus
                onCancel={() => {
                  // The same deliberate discard as closing the dialog: asked
                  // for, then done, so nothing disappears by accident.
                  void (async () => {
                    const dirty = editing && JSON.stringify(stripFiles(value)) !== JSON.stringify(stripFiles(valueFor(editing)));
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
                    discardDraft(rollKey, editing?.path ?? null);
                    setEditing(null);
                    setValue(fromDraft(readDraft(rollKey, null)) ?? emptyValue());
                  })();
                }}
              />
            </div>
          )}
        </DialogContent>
      </Dialog>

      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      <AiSettingsDialog store={store} open={aiOpen} onOpenChange={setAiOpen} onSaved={storeChanged} />
    </div>
  );
}

/** A composer's value without the files, which are what a draft cannot keep. */
function stripFiles(v: ComposerValue) {
  return { text: v.text, projects: v.projects, amount: v.amount, when: v.when, extraTags: v.extraTags };
}

/** A kept draft, back as something the composer can show. Files are never in one. */
function fromDraft(draft: ReturnType<typeof readDraft>): ComposerValue | null {
  if (!draft) return null;
  return { text: draft.text, projects: draft.projects ?? [], amount: draft.amount ?? "", when: draft.when ?? "", extraTags: draft.extraTags ?? [], files: [] };
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
