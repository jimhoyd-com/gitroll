import { ArrowLeft, Download, History as HistoryIcon, Paperclip, Pencil, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { Attachment } from "../../core/entry.ts";
import type { HistoryItem, LoadedEntry } from "../../core/layout.ts";
import { fileKind, fmtAmount, isImage, message, plural } from "../lib/format.ts";
import { contextFor, linkedPaths, renderMarkdown } from "../lib/markdown.ts";
import { cn } from "../lib/utils.ts";
import { fieldRows } from "./Timeline.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Skeleton } from "./ui/misc.tsx";

export interface EntryDetailProps {
  entry: LoadedEntry | null;
  projectName(slug: string): string;
  attachmentUrl(a: Attachment): string;
  onFilter(key: string, value: string): void;
  onEdit(): void;
  onDelete(): void;
  loadHistory(id: string): Promise<HistoryItem[]>;
}

export function EntryDetail({
  entry: e,
  projectName,
  attachmentUrl,
  onFilter,
  onEdit,
  onDelete,
  loadHistory,
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

  const showHistory = async () => {
    setLoading(true);
    setHistoryError("");
    try {
      setHistory(await loadHistory(e.path));
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
            {e.projects.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => onFilter("topic", p)}
                className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {projectName(p)}
              </button>
            ))}
            {e.amount && <Badge variant="amount">{fmtAmount(e.amount)}</Badge>}
          </div>
        </header>

        {e.body.trim() && (
          <div
            className="prose-roll"
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

        {e.tags.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {e.tags.map((t) => (
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
            <dd>{e.dateFrom === "metadata" ? "the front matter" : e.dateFrom === "filename" ? "the file name" : "nothing — this event is undated"}</dd>
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
        {history && <History items={history} />}
      </article>
    </div>
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

function History({ items }: { items: HistoryItem[] }) {
  return (
    <section className="flex flex-col gap-3" aria-labelledby="history-heading">
      <h2 id="history-heading" className="text-sm font-semibold">
        History
      </h2>
      <p className="text-xs text-muted-foreground">
        {plural(items.length, "version", "versions")}, kept by Git. Nothing here is ever rewritten.
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
