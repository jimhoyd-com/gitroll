import { ArrowLeft, CircleCheck, Download, History as HistoryIcon, Paperclip, Pencil, Pin, PinOff, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { Attachment } from "../../core/entry.ts";
import type { HistoryItem, LoadedEntry } from "../../core/layout.ts";
import { codeRefs, refLabel, sourceRef } from "../../core/code.ts";
import { collectionOf } from "../../core/fields.ts";
import { issueOf } from "../../core/issues.ts";
import type { Issue } from "../../core/issues.ts";
import { isPinned } from "../../core/pins.ts";
import { related } from "../../core/relations.ts";
import { isoDate } from "../../core/util.ts";
import { DocLink, dayText } from "./ViewParts.tsx";
import { recordsHref } from "../hooks/useStore.ts";
import { fileKind, fmtAmount, isImage, message, plural } from "../lib/format.ts";
import { contextFor, linkedPaths } from "../lib/markdown.ts";
import { cn } from "../lib/utils.ts";
import { isSealedValue } from "../../core/sealed.ts";
import { SealedField, SealedFileButton, SealedMarkdown, useUnsealer } from "../unseal.tsx";
import { fieldRows } from "./Timeline.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Skeleton } from "./ui/misc.tsx";

export interface EntryDetailProps {
  entry: LoadedEntry | null;
  /** The entry may be a note that is still being read. */
  pending?: boolean;
  /** Every event and note there is, so this one can show what links to it. */
  entries: LoadedEntry[];
  projectName(slug: string): string;
  attachmentUrl(a: Attachment): string;
  onFilter(key: string, value: string): void;
  onEdit(): void;
  onDelete(): void;
  loadHistory(id: string): Promise<HistoryItem[]>;
  /** Puts an earlier version back, as a new commit. */
  onRestore(commit: string): Promise<void>;
  /** Pins or unpins it (`pinned: true`), where the store can. */
  onPin?(pinned: boolean): Promise<void>;
  /** Resolves it, when it is an open issue and the store can. */
  onResolveIssue?(): void;
}

export function EntryDetail({
  entry: e,
  pending = false,
  entries,
  projectName,
  attachmentUrl,
  onFilter,
  onEdit,
  onDelete,
  loadHistory,
  onRestore,
  onPin,
  onResolveIssue,
}: EntryDetailProps) {
  const [history, setHistory] = useState<HistoryItem[] | null>(null);
  const [historyError, setHistoryError] = useState("");
  const [loading, setLoading] = useState(false);
  const [pinning, setPinning] = useState(false);

  useEffect(() => {
    setHistory(null);
    setHistoryError("");
  }, [e?.id]);

  if (!e && pending) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true">
        <BackLink />
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (!e) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <p className="text-sm text-muted-foreground">
          This isn't in your Roll any more. If you deleted it, it's still in your Git history.
        </p>
      </div>
    );
  }

  const isNote = e.path.startsWith(".gitroll/notes/");
  const collection = isNote ? collectionOf(e.path) : null;
  const rows = fieldRows(e);
  // Everything the text already shows inline is on screen; list the rest.
  const shown = linkedPaths(e.body, e.path);
  const files = e.attachments.filter((a) => !a.image || !shown.has(a.path));
  // Sealed fields, by the label fieldRows gives them, so the host can open them.
  const sealedFields = new Map(Object.entries(e.meta).flatMap(([k, v]) => (isSealedValue(v) ? [[k.replace(/_/g, " "), v] as const] : [])));
  const pinned = isPinned(e);
  // An issue is open until resolved: on itself, or by an event that resolves it.
  const issue = issueOf(e, entries, isoDate());

  const togglePin = async () => {
    if (!onPin || pinning) return;
    setPinning(true);
    try {
      await onPin(!pinned);
    } finally {
      setPinning(false);
    }
  };

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
          {isNote ? (
            <p className="text-sm text-muted-foreground">
              {collection ? (
                <>
                  A record in{" "}
                  <a href={recordsHref(collection)} className="rounded underline underline-offset-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                    {collection}
                  </a>
                </>
              ) : (
                "A note, kept up to date rather than logged"
              )}
            </p>
          ) : (
            <time dateTime={e.date ?? undefined} className="text-sm text-muted-foreground">
              {e.date
                ? new Date(e.date.length === 10 ? `${e.date}T12:00:00` : e.date).toLocaleDateString([], { dateStyle: "full" })
                : "Undated — name the file 2026-09-15-… or add a date"}
            </time>
          )}
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
            {pinned && (
              <Badge variant="outline">
                <Pin className="size-3" aria-hidden="true" />
                Pinned
              </Badge>
            )}
          </div>
          {issue && <IssueStatus issue={issue} />}
        </header>

        {e.body.trim() && (
          <SealedMarkdown className="prose-roll" body={e.body} ctx={contextFor(e, (path) => attachmentUrl({ path, name: path, type: "", image: false }))} />
        )}

        {rows.length > 0 && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-lg border border-border p-3 text-sm">
            {rows.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted-foreground">{k}</dt>
                <dd>{sealedFields.has(k) ? <SealedField armored={sealedFields.get(k)!} fallback={v} /> : v}</dd>
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
          {onPin && (
            <Button variant="secondary" onClick={() => void togglePin()} disabled={pinning}>
              {pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
              {pinned ? "Unpin" : "Pin"}
            </Button>
          )}
          {onResolveIssue && issue?.status === "open" && (
            <Button variant="secondary" onClick={onResolveIssue}>
              <CircleCheck aria-hidden="true" />
              Resolve issue
            </Button>
          )}
          <Button variant="outlineDestructive" onClick={onDelete}>
            <Trash2 aria-hidden="true" />
            Delete
          </Button>
        </div>

        <details className="rounded-lg border border-border">
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium">Details</summary>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 px-3 pb-3 text-sm">
            {!isNote && (
              <>
                <dt className="text-muted-foreground">Date from</dt>
                <dd>{e.dateFrom === "metadata" ? "the front matter" : e.dateFrom === "filename" ? "the file name" : "nothing — this event is undated"}</dd>
              </>
            )}
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

/** Whether an issue is still open, and for how long, or when it was resolved and by what. */
function IssueStatus({ issue }: { issue: Issue }) {
  const by = issue.resolvedBy[0];
  if (issue.status === "open") {
    return (
      <p className="text-sm">
        <span className="font-medium">Open issue</span>
        {issue.age !== null && <span className="text-muted-foreground">, open {plural(issue.age, "day", "days")}</span>}
      </p>
    );
  }
  return (
    <p className="text-sm">
      <span className="font-medium">Resolved issue</span>
      <span className="text-muted-foreground">
        {issue.resolved && `, ${dayText(issue.resolved)}`}
        {by && (
          <>
            {" "}by{" "}
            <DocLink path={by.path} className="rounded underline underline-offset-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
              {by.title}
            </DocLink>
          </>
        )}
      </span>
    </p>
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
        href={`#/entry/${encodeURIComponent(e.path)}`}
        className="flex items-baseline gap-2 rounded px-1 py-0.5 text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <span className="truncate">{e.title}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{e.path.startsWith(".gitroll/notes/") ? "note" : (e.date ?? "undated")}</span>
      </a>
    </li>
  );
  return (
    <section aria-label="Related" className="flex flex-col gap-2 rounded-lg border border-border p-3">
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
  // A sealed file (x.pdf.age) opens in a tab: the local server shows it only if it has a key.
  const sealed = a.path.endsWith(".age");
  const unsealer = useUnsealer();
  if (sealed && unsealer) {
    // The host can open it in this browser instead.
    return (
      <div className="flex w-52 flex-col gap-1.5 rounded-lg border border-border p-2 text-sm">
        <span className="block truncate">{a.name}</span>
        <SealedFileButton path={a.path} name={a.name} url={url} />
      </div>
    );
  }
  const inline = sealed || a.type === "application/pdf" || /^(image|video|audio)\//.test(a.type) || a.type === "text/plain";
  if (isImage(a) && !sealed) {
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
        <span className="block text-xs text-muted-foreground">{sealed ? "Sealed: opens only with a key" : fileKind(a)}</span>
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
                  {h.agent && <> · by the agent {h.agent}</>}
                </span>{" "}
                {h.signature && <SignatureBadge signature={h.signature} />}
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

/**
 * What Git says about the change's signature, checked against the Roll's
 * .gitroll/allowed_signers. A Gitroll-Agent trailer is only a claim; a
 * verified signature by agent:<name> is the proof.
 */
function SignatureBadge({ signature }: { signature: NonNullable<HistoryItem["signature"]> }) {
  const { status, signer } = signature;
  if (status === "good") {
    return (
      <Badge variant="amount" title={signer ? `Signed by ${signer}` : undefined}>
        Verified{signer ? ` · ${signer}` : ""}
      </Badge>
    );
  }
  if (status === "bad") return <Badge className="border-transparent bg-del-bg text-del">Bad signature</Badge>;
  if (status === "unknown") return <Badge title="Signed by a key this Roll's allowed_signers doesn't list">Unknown signer</Badge>;
  return <Badge>Unsigned</Badge>;
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
