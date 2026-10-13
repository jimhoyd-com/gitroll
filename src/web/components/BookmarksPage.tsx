import { ExternalLink, Pin } from "lucide-react";
import { useMemo, useState } from "react";
import type * as React from "react";
import type { LoadedEntry } from "../../core/layout.ts";
import { recordsIn } from "../../core/fields.ts";
import { BOOKMARKS_COLLECTION, bookmarks, findBookmark, titleFromUrl, webUrl } from "../../core/bookmarks.ts";
import { normalizeTag } from "../../core/entry.ts";
import { SearchIndex } from "../../core/search.ts";
import { isoDate } from "../../core/util.ts";
import { message, plural } from "../lib/format.ts";
import type { NewRecord } from "./RecordsPage.tsx";
import { DocLink, Empty, PageHeader, dayText } from "./ViewParts.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Field, Input, Label } from "./ui/input.tsx";
import { QueryError, useSavedQuery } from "./SavedSearches.tsx";

const linkClass = "rounded underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/**
 * The bookmarks in .gitroll/notes/bookmarks/: web pages kept with a url,
 * tags, a description and the day each was added, pinned first and then
 * newest. The same view as `gitroll bookmarks`. A page already bookmarked is
 * found rather than added twice, as `gitroll bookmark` does.
 */
export function BookmarksPage({ notes, docs, onNewRecord }: { notes: LoadedEntry[]; docs: LoadedEntry[]; onNewRecord?: (input: NewRecord) => Promise<void> }) {
  const [query, setQuery] = useState("");
  const saved = useSavedQuery(query);
  const records = useMemo(() => recordsIn(notes, BOOKMARKS_COLLECTION), [notes]);
  const all = useMemo(() => bookmarks(records, docs), [records, docs]);
  const view = useMemo(() => (saved.query.trim() ? bookmarks(new SearchIndex(records).search(saved.query), docs) : all), [all, records, docs, saved.query]);
  const toggleTag = (tag: string) => setQuery((q) => (q.trim() === `tag:${tag}` ? "" : `tag:${tag}`));

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Bookmarks"
        description="Records in .gitroll/notes/bookmarks/, each a web page with its url, tags, a description and the day it was added. Events and notes that link to one are where it came up."
      />

      {onNewRecord && <AddBookmark records={records} onNewRecord={onNewRecord} />}

      {!records.length ? (
        <Empty title="No bookmarks here yet" command={'gitroll bookmark https://example.com "Example" --tag reading'}>
          A bookmark is a record with a url, tags and a description. gitroll import bookmarks reads a browser's bookmarks export, and gitroll bookmarks --html writes one.
        </Empty>
      ) : (
        <>
          <div className="flex min-w-48 flex-col gap-1.5">
            <Label htmlFor="bookmarks-q">Filter</Label>
            <Input id="bookmarks-q" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Words, or fields: tag:reading added>2026-01-01" />
            <QueryError error={saved.error} />
          </div>

          {all.tags.length > 0 && (
            <ul aria-label="By tag" className="flex flex-wrap gap-1.5">
              {all.tags.map((t) => (
                <li key={t.tag}>
                  <button type="button" onClick={() => toggleTag(t.tag)} aria-pressed={query.trim() === `tag:${t.tag}`} className="rounded-full">
                    <Badge interactive variant={query.trim() === `tag:${t.tag}` ? "solid" : "default"}>
                      #{t.tag} <span className="tabular-nums opacity-70">{t.count}</span>
                    </Badge>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <p className="text-sm text-muted-foreground" aria-live="polite">
            {plural(view.bookmarks.length, "bookmark", "bookmarks")}
            {view.duplicates.length > 0 && `, ${plural(view.duplicates.length, "page", "pages")} kept twice`}
          </p>

          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
            {view.bookmarks.map((b) => (
              <li key={b.path} className="flex flex-col gap-1 px-3 py-2.5">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  {b.pinned && <Pin aria-label="Pinned" className="size-3.5 self-center text-muted-foreground" />}
                  {b.url && webUrl(b.url) ? (
                    <a href={b.url} rel="noreferrer noopener" target="_blank" className={`${linkClass} inline-flex items-baseline gap-1 font-medium`}>
                      {b.title}
                      <ExternalLink aria-hidden="true" className="size-3 self-center text-muted-foreground" />
                      <span className="sr-only">(opens in a new tab)</span>
                    </a>
                  ) : (
                    <span className="font-medium">{b.title}</span>
                  )}
                  {b.site && <span className="text-xs text-muted-foreground">{b.site}</span>}
                </div>
                {b.description && <p className="max-w-prose text-sm text-muted-foreground">{b.description}</p>}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  {b.tags.map((t) => (
                    <button key={t} type="button" onClick={() => toggleTag(t)} className={linkClass}>
                      #{t}
                    </button>
                  ))}
                  {b.added && <span>Added {dayText(b.added)}</span>}
                  {b.linkedFrom.length > 0 && (
                    <span>
                      Linked from{" "}
                      {b.linkedFrom.slice(0, 3).map((l, i) => (
                        <span key={l.path}>
                          {i > 0 && ", "}
                          <DocLink path={l.path} className={linkClass}>
                            {l.title}
                          </DocLink>
                        </span>
                      ))}
                      {b.linkedFrom.length > 3 && ` and ${b.linkedFrom.length - 3} more`}
                    </span>
                  )}
                  <DocLink path={b.path} className={linkClass}>
                    Open the note
                  </DocLink>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/**
 * Text as a YAML value, the way `--field` takes it: plain when YAML reads it
 * back as the same text (a web address has no spaces, so no " #" or ": "),
 * quoted when it would be a number, true or null.
 */
const yamlText = (s: string): string => (/^[\p{L}][^\s,[\]{}]*(?<!:)$/u.test(s) && !/^(?:true|false|null|yes|no|on|off)$/i.test(s) ? s : JSON.stringify(s));

/** A web address, and optionally a title and tags: a bookmark, unless that page is bookmarked already. */
function AddBookmark({ records, onNewRecord }: { records: LoadedEntry[]; onNewRecord: (input: NewRecord) => Promise<void> }) {
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [tags, setTags] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const existing = useMemo(() => (webUrl(url) ? findBookmark(records, url) : null), [records, url]);
  const valid = !!webUrl(url);

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!valid || existing || saving) return;
    setSaving(true);
    setError("");
    const tagList = [...new Set(tags.split(/[,\s]+/).map(normalizeTag).filter(Boolean))];
    const fields: [string, string][] = [["url", yamlText(url.trim())], ...(tagList.length ? [["tags", `[${tagList.map(yamlText).join(", ")}]`] as [string, string]] : []), ["added", isoDate()]];
    try {
      await onNewRecord({ collection: BOOKMARKS_COLLECTION, title: title.trim() || titleFromUrl(url), fields });
      setUrl("");
      setTitle("");
      setTags("");
    } catch (err) {
      setError(message(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={(ev) => void submit(ev)} aria-label="Add a bookmark" className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[2fr_2fr_1fr_auto] sm:items-end">
        <Field label="Address" htmlFor="bookmark-url">
          <Input id="bookmark-url" type="url" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
        </Field>
        <Field label="Title (optional)" htmlFor="bookmark-title">
          <Input id="bookmark-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={valid ? titleFromUrl(url) : ""} />
        </Field>
        <Field label="Tags" htmlFor="bookmark-tags">
          <Input id="bookmark-tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="reading, recipes" />
        </Field>
        <Button type="submit" disabled={!valid || !!existing || saving}>
          {saving ? "Saving…" : "Add bookmark"}
        </Button>
      </div>
      {existing && (
        <p className="text-sm text-muted-foreground" role="status">
          Already bookmarked:{" "}
          <DocLink path={existing.path} className={linkClass}>
            {existing.title}
          </DocLink>
        </p>
      )}
      {url.trim() && !valid && <p className="text-sm text-muted-foreground">A bookmark's address starts with http:// or https://.</p>}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}
