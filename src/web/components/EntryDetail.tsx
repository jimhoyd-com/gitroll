import { ArrowLeft, Download, History as HistoryIcon, Paperclip, Pencil, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { Attachment } from "../../core/entry.ts";
import type { HistoryItem, LoadedEntry } from "../../core/layout.ts";
import { codeRefs, refLabel, sourceRef } from "../../core/code.ts";
import { related } from "../../core/relations.ts";
import { fileKind, fmtAmount, isImage, message, plural } from "../lib/format.ts";
import { contextFor, linkedPaths, renderMarkdown } from "../lib/markdown.ts";
import { cn } from "../lib/utils.ts";
import { frontMatterTags } from "../lib/tags.ts";
import { fieldRows } from "./Timeline.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Skeleton } from "./ui/misc.tsx";

export interface EntryDetailProps {
  entry: LoadedEntry | null;
  /** Every event, so this one can show what links to it. */
  entries: LoadedEntry[];
  attachmentUrl(a: Attachment): string;
  onFilter(key: string, value: string): void;
  onEdit(): void;
  onDelete(): void;
  loadHistory(id: string): Promise<HistoryItem[]>;
  /** Puts an earlier version back, as a new commit. */
  onRestore(commit: string): Promise<void>;
}

export function EntryDetail({
  entry: e,
  entries,
  attachmentUrl,
  onFilter,
  onEdit,
  onDelete,
  loadHistory,
  onRestore,
}: EntryDetailProps) {
  const [history, setHistory] = useState<HistoryItem[] | null>(null);
  const [historyError, setHistoryError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setHistory(null);
    setHistoryError("");
  }, [e?.id]);

  if (!e) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <p className="text-sm text-muted-foreground">
          This event isn't in your timeline any more. If you deleted it, it's still in your Git history.
        </p>
      </div>
    );
  }

  const rows = fieldRows(e);
  // Everything the text already shows inline is on screen; list the rest.
  const shown = linkedPaths(e.body, e.path);
  const files = e.attachments.filter((a) => !a.image || !shown.has(a.path));
  // A tag written in the text is already on screen where its author put it.
  const tags = frontMatterTags(e);

  const showHistory = async () => {
    setLoading(true);
    setHistoryError("");
    try {
      setHistory(await loadHistory(e.id));
    } catch (err) {
      setHistoryError(message(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <BackLink />

      <article className="flex flex-col gap-4">
        <header className="flex flex-col gap-2">
          <time dateTime={e.date ?? undefined} className="text-sm text-muted-foreground">
            {e.date
              ? new Date(e.date.length === 10 ? `${e.date}T12:00:00` : e.date).toLocaleDateString([], { dateStyle: "full" })
              : "Undated — name the file 2026-09-15-… or add a date"}
          </time>
          <div className="flex flex-wrap items-center gap-1.5">
            
            {e.amount && <Badge variant="amount">{fmtAmount(e.amount)}</Badge>}
          </div>
        </header>

        {e.body.trim() && (
          <div
            className="prose-roll prose-roll-document"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(e.body, contextFor(e, (path) => attachmentUrl({ path, name: path, type: "", image: false }))) }}
          />
        )}

        {rows.length > 0 && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-lg border border-border p-3 text-sm">
            {rows.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted-foreground">{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        )}

        {files.length > 0 && (
          <ul className="flex flex-wrap gap-2">
            {files.map((a) => (
              <li key={a.path}>
                <AttachmentTile attachment={a} url={attachmentUrl(a)} />
              </li>
            ))}
          </ul>
        )}

        <CodeLinks entry={e} />

        <Related entry={e} entries={entries} />

        {tags.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {tags.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => onFilter("tag", t)}
                className="rounded transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                #{t}
              </button>
            ))}
          </div>
        )}

        <div className="flex flex-wrap gap-2 border-t border-border pt-4">
          <Button variant="secondary" onClick={onEdit}>
            <Pencil aria-hidden="true" />
            Edit
          </Button>
          <Button variant="secondary" onClick={() => void showHistory()} aria-expanded={history !== null}>
            <HistoryIcon aria-hidden="true" />
            History
          </Button>
          <Button variant="outlineDestructive" onClick={onDelete}>
            <Trash2 aria-hidden="true" />
            Delete
          </Button>
        </div>

        <details className="rounded-lg border border-border">
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium">Details</summary>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 px-3 pb-3 text-sm">
            <dt className="text-muted-foreground">Date from</dt>
            <dd>
              {e.dateFrom === "metadata"
                ? "the front matter"
                : e.dateFrom === "filename"
                  ? "the file name"
                  : e.dateFrom === "marker"
                    ? "the date written with this entry"
                    : e.dateFrom === "commit"
                      ? "the commit that saved it"
                      : "nothing — this event is undated"}
            </dd>
            {e.source && (
              <>
                <dt className="text-muted-foreground">Imported from</dt>
                <dd>{e.source.adapter}</dd>
              </>
            )}
            <dt className="text-muted-foreground">File</dt>
            <dd>
              <code className="font-mono text-xs">{e.path}</code>
            </dd>
          </dl>
        </details>

        {loading && (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-16 w-full" />
          </div>
        )}
        {historyError && <p className="text-sm text-destructive">{historyError}</p>}
        {history && <History items={history} onRestore={onRestore} />}
      </article>
    </div>
  );
}

/**
 * The commits, pull requests and issues an event mentions. `#412` and a bare SHA
 * only become links when the event says which repository it is about, because
 * guessing the repository would produce links that quietly go to the wrong one.
 */
function CodeLinks({ entry }: { entry: LoadedEntry }) {
  const source = sourceRef(entry);
  const refs = codeRefs(entry);
  if (!source && !refs.length) return null;
  return (
    <section aria-label="Code" className="flex flex-col gap-1.5 rounded-lg border border-border p-3 text-sm">
      {source && (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-muted-foreground">Code</span>
          {source.repo && <span className="font-mono text-xs">{source.repo}</span>}
          {source.branch && (
            // The branch the work happened on, which is not the branch this Roll is on.
            <span className="rounded-full border border-border px-2 py-0.5 text-xs" title="The branch this event's work happened on">
              {source.branch}
            </span>
          )}
        </p>
      )}
      {refs.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {refs.map((ref) => (
            <li key={`${ref.kind}-${ref.repo ?? ""}-${ref.id}`}>
              {ref.url ? (
                <a
                  href={ref.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={refLabel(ref.kind)}
                  className="rounded-full border border-border px-2 py-0.5 font-mono text-xs text-link hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  {ref.text}
                </a>
              ) : (
                <span className="rounded-full border border-border px-2 py-0.5 font-mono text-xs text-muted-foreground" title="No repository is recorded on this event, so this isn't a link">
                  {ref.text}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** What this event links to, and what links back to it. Both are just Markdown links. */
function Related({ entry, entries }: { entry: LoadedEntry; entries: LoadedEntry[] }) {
  const { links, backlinks, missing } = related(entry, entries);
  if (!links.length && !backlinks.length && !missing.length) return null;
  const row = (e: LoadedEntry) => (
    <li key={e.path}>
      <a
        href={`#/entry/${encodeURIComponent(e.id)}`}
        className="flex items-baseline gap-2 rounded px-1 py-0.5 text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <span className="truncate">{e.title}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{e.date ?? "undated"}</span>
      </a>
    </li>
  );
  return (
    <section aria-label="Related events" className="flex flex-col gap-2 rounded-lg border border-border p-3">
      {links.length > 0 && (
        <div>
          <h2 className="mb-1 text-xs font-medium text-muted-foreground">This links to</h2>
          <ul>{links.map(row)}</ul>
        </div>
      )}
      {backlinks.length > 0 && (
        <div>
          <h2 className="mb-1 text-xs font-medium text-muted-foreground">Linked from</h2>
          <ul>{backlinks.map(row)}</ul>
        </div>
      )}
      {missing.map((path) => (
        <p key={path} className="text-xs text-muted-foreground">
          Links to <code className="font-mono">{path}</code>, which isn't in this Roll.
        </p>
      ))}
    </section>
  );
}

function BackLink() {
  return (
    <a
      href="#/"
      onClick={(ev) => {
        // Going "back" should return to the search they came from when there is
        // one, and fall back to the timeline when the page was opened directly.
        if (history.length > 1) {
          ev.preventDefault();
          history.back();
        }
      }}
      className="inline-flex items-center gap-1.5 self-start rounded text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <ArrowLeft className="size-4" aria-hidden="true" />
      Back
    </a>
  );
}

function AttachmentTile({ attachment: a, url }: { attachment: Attachment; url: string }) {
  const inline = a.type === "application/pdf" || /^(image|video|audio)\//.test(a.type) || a.type === "text/plain";
  if (isImage(a)) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="block rounded-lg border border-border focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <img src={url} alt={a.name} loading="lazy" className="size-32 rounded-lg object-cover" />
      </a>
    );
  }
  return (
    <a
      href={url}
      {...(inline ? { target: "_blank", rel: "noopener noreferrer" } : { download: a.name })}
      className={cn(
        "flex w-52 items-center gap-2 rounded-lg border border-border p-2 text-sm transition-colors",
        "hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
      )}
    >
      {inline ? <Paperclip className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : <Download className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{a.name}</span>
        <span className="block text-xs text-muted-foreground">{fileKind(a)}</span>
      </span>
    </a>
  );
}

function History({ items, onRestore }: { items: HistoryItem[]; onRestore(commit: string): Promise<void> }) {
  const [busy, setBusy] = useState("");
  return (
    <section className="flex flex-col gap-3" aria-labelledby="history-heading">
      <h2 id="history-heading" className="text-sm font-semibold">
        History
      </h2>
      <p className="text-xs text-muted-foreground">
        {plural(items.length, "version", "versions")}, kept by Git. Nothing here is ever rewritten: putting an earlier version
        back is a new commit, so this list only ever grows.
      </p>
      <ol className="flex flex-col gap-3">
        {items.map((h, i) => {
          const first = i === items.length - 1;
          return (
            <li key={`${h.date}-${i}`} className="rounded-lg border border-border p-3">
              <p className="text-sm">
                <strong className="font-medium">{first ? "Written down" : "Edited"}</strong>{" "}
                <span className="text-muted-foreground">
                  {new Date(h.date).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })} · {h.author}
                </span>
              </p>
              {!first && <Diff patch={h.patch} />}
              {i > 0 && (
                <Button
                  variant="secondary"
                  size="sm"
                  className="mt-2"
                  disabled={busy === h.commit}
                  onClick={() => {
                    setBusy(h.commit);
                    void onRestore(h.commit).finally(() => setBusy(""));
                  }}
                >
                  Put this version back
                </Button>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function Diff({ patch }: { patch: string }) {
  const lines = patch
    .split("\n")
    .filter((l) => !/^(diff --git|index |--- |\+\+\+ |\\ No newline|new file mode|deleted file mode|similarity index|rename (from|to) |@@)/.test(l))
    .filter((l) => /^[+-]/.test(l));
  if (!lines.length) return null;
  return (
    <pre className="mt-2 overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs">
      {lines.map((l, i) => (
        <span
          key={i}
          className={cn("block px-1", l.startsWith("+") ? "bg-add-bg text-add" : "bg-del-bg text-del")}
        >
          <span className="sr-only">{l.startsWith("+") ? "Added: " : "Removed: "}</span>
          {l.slice(1) || " "}
        </span>
      ))}
    </pre>
  );
}
