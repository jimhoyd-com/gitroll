import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type * as React from "react";
import type { LoadedEntry } from "../../core/layout.ts";
import { collections, columnsOf, fieldYaml, recordsIn, sortByFields } from "../../core/fields.ts";
import { isSealedValue } from "../../core/sealed.ts";
import { SearchIndex } from "../../core/search.ts";
import { COPY } from "../copy.ts";
import { message, plural } from "../lib/format.ts";
import { ChangedOnDiskError } from "../store.ts";
import type { FieldsSaved } from "../store.ts";
import { DocLink, Empty, LinkedText, PageHeader, fieldText, shortPath, tableClass, tdClass, thClass, useDiscardGuard } from "./ViewParts.tsx";
import { Button } from "./ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog.tsx";
import { Field, Input, Label } from "./ui/input.tsx";
import { useToast } from "./ui/toast.tsx";
import { QueryError, useSavedQuery } from "./SavedSearches.tsx";

export interface NewRecord {
  collection: string;
  title: string;
  /** Field name and its value as YAML, as `--field k=v` takes it. */
  fields: [string, string][];
}

/**
 * One collection as a table: a row per record, a column for every field in
 * use. The same table `gitroll records <collection>` prints, with the same
 * filters and the same sort, so nothing has to be declared before it shows.
 *
 * Where the store can write, a record can be added (`gitroll add`) and a cell
 * edited in place (`gitroll set --expect`): a file changed since the page read
 * it is refused, never overwritten.
 */
export function RecordsPage({
  notes,
  collection,
  revisions,
  onNewRecord,
  onSetField,
}: {
  notes: LoadedEntry[];
  collection: string;
  /** Each note's revision, by path. A record without one isn't editable in place. */
  revisions?: Record<string, string>;
  /** Writes a record and opens it. */
  onNewRecord?: (input: NewRecord) => Promise<void>;
  onSetField?: (path: string, key: string, value: string, revision: string) => Promise<FieldsSaved>;
}) {
  const [query, setQuery] = useState("");
  const saved = useSavedQuery(query);
  const [sort, setSort] = useState<{ key: string; descending: boolean } | null>(null);
  const [adding, setAdding] = useState(false);
  const toast = useToast();
  const info = useMemo(() => collections(notes).find((c) => c.name.toLowerCase() === collection.toLowerCase()) ?? null, [notes, collection]);
  const records = useMemo(() => recordsIn(notes, collection), [notes, collection]);
  const columns = useMemo(() => columnsOf(records), [records]);
  const rows = useMemo(() => {
    const found = saved.query.trim() ? new SearchIndex(records).search(saved.query) : records;
    return sort ? sortByFields(found, [sort]) : [...found].sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
  }, [records, saved.query, sort]);

  const title = info?.name ?? collection;
  const addButton = onNewRecord && title && (
    <Button size="sm" onClick={() => setAdding(true)}>
      <Plus aria-hidden="true" />
      {COPY.newRecord}
    </Button>
  );
  const addDialog = onNewRecord && title && (
    <NewRecordDialog open={adding} collection={title} columns={columns} onClose={() => setAdding(false)} onSave={onNewRecord} />
  );

  if (!info) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title={title}>{addButton}</PageHeader>
        {addDialog}
        <Empty title={`There's no collection called "${collection}"`} command={`gitroll add ${collection || "books"} "Dune" --field rating=5`}>
          A collection is any folder under .gitroll/notes/, and it appears here once it has a note in it. Adding the first record makes one:
        </Empty>
      </div>
    );
  }

  const toggle = (key: string) =>
    setSort((cur) => (cur?.key !== key ? { key, descending: false } : cur.descending ? null : { key, descending: true }));

  /** Saves one cell. Resolves true when the editor should close. */
  const saveField = async (r: LoadedEntry, key: string, value: string): Promise<boolean> => {
    const revision = revisions?.[r.path];
    if (!onSetField || !revision) return true;
    try {
      const saved = await onSetField(r.path, key, value, revision);
      toast.toast(saved.changed ? COPY.fieldSaved : COPY.fieldUnchanged);
      return true;
    } catch (err) {
      toast.error(message(err));
      // Changed on disk: close, so what the file says now is what's shown.
      return err instanceof ChangedOnDiskError;
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={title} description={info.description ?? `Records in .gitroll/notes/${info.name}/. Any front matter key is a column.`}>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">{plural(info.records, "record", "records")}</span>
          {addButton}
        </div>
      </PageHeader>
      {addDialog}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="records-q">Filter</Label>
        <Input
          id="records-q"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Words, or fields: status:reading rating>=4 has:isbn"
        />
        <QueryError error={saved.error} />
      </div>

      {records.length === 0 ? (
        <Empty title="No records yet" command={`gitroll add ${info.name} "Title" --field key=value`} />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground" aria-live="polite">
          No record matches.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className={tableClass}>
            <caption className="sr-only">
              {title}: {plural(rows.length, "record", "records")}. Column headings sort the table.
              {onSetField ? ` Choose a value to change it. ${COPY.editCellHint}` : ""}
            </caption>
            <thead>
              <tr>
                {["title", ...columns].map((c) => {
                  const active = sort?.key === c;
                  return (
                    <th key={c} scope="col" className={thClass} aria-sort={active ? (sort.descending ? "descending" : "ascending") : undefined}>
                      <button
                        type="button"
                        onClick={() => toggle(c)}
                        className="inline-flex items-center gap-1 rounded hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                      >
                        {c}
                        {active && (sort.descending ? <ArrowDown aria-hidden="true" className="size-3" /> : <ArrowUp aria-hidden="true" className="size-3" />)}
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.path}>
                  <th scope="row" className={`${tdClass} text-left font-normal`}>
                    <DocLink path={r.path}>{r.title || r.path}</DocLink>
                  </th>
                  {columns.map((c) => (
                    <FieldCell
                      key={c}
                      value={r.meta[c]}
                      from={r.path}
                      label={`${c} of ${r.title || shortPath(r.path)}`}
                      editable={!!onSetField && !!revisions?.[r.path]}
                      onSave={(value) => saveField(r, c, value)}
                    />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * A cell that turns into a text box when chosen. What's in the box is the
 * field's YAML, as `gitroll set` takes it. Enter (or leaving the box) saves,
 * Escape puts it back, and an empty box removes the field. A sealed value, or
 * a mapping such as an amount, isn't one line of text and stays read-only.
 */
function FieldCell({ value, from, label, editable, onSave }: { value: unknown; from: string; label: string; editable: boolean; onSave(text: string): Promise<boolean> }) {
  const initial = fieldYaml(value);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const settled = useRef(false);
  const refocus = useRef(false);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (draft === null && refocus.current) {
      refocus.current = false;
      button.current?.focus();
    }
  }, [draft]);

  // Read-only, a link in the value is a link; in a cell that edits on click it is its text.
  if (!editable || initial === null || isSealedValue(value)) return <td className={tdClass}>{typeof value === "string" && !isSealedValue(value) ? <LinkedText text={value} from={from} /> : fieldText(value)}</td>;

  const close = (focusCell: boolean) => {
    settled.current = true;
    refocus.current = focusCell;
    setDraft(null);
  };
  const commit = async (focusCell: boolean) => {
    if (settled.current || draft === null) return;
    const text = draft.trim();
    if (text === initial.trim()) return close(focusCell);
    settled.current = true;
    setSaving(true);
    const done = await onSave(text);
    setSaving(false);
    if (done) close(focusCell);
    else settled.current = false;
  };

  if (draft === null) {
    return (
      <td className={tdClass}>
        <button
          ref={button}
          type="button"
          onClick={() => {
            settled.current = false;
            setDraft(initial);
          }}
          className="block min-h-6 w-full min-w-12 rounded px-1 -mx-1 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <span className="sr-only">Edit {label}: </span>
          {fieldText(value)}
        </button>
      </td>
    );
  }
  return (
    <td className={tdClass}>
      <Input
        autoFocus
        aria-label={label}
        title={COPY.editCellHint}
        value={draft}
        readOnly={saving}
        aria-busy={saving || undefined}
        onChange={(ev) => setDraft(ev.target.value)}
        onKeyDown={(ev) => {
          if (ev.key === "Enter") {
            ev.preventDefault();
            void commit(true);
          } else if (ev.key === "Escape") {
            ev.preventDefault();
            ev.stopPropagation();
            close(true);
          }
        }}
        onBlur={() => void commit(false)}
        className="h-7 min-w-28 px-2"
      />
    </td>
  );
}

let nextRow = 1;

/** Adding a record: a title and fields as name and YAML value, written as `gitroll add` writes one. */
function NewRecordDialog({
  open,
  collection,
  columns,
  onClose,
  onSave,
}: {
  open: boolean;
  collection: string;
  /** The collection's fields so far, offered as rows to fill in. */
  columns: string[];
  onClose(): void;
  onSave(input: NewRecord): Promise<void>;
}) {
  const blank = () => ({ id: nextRow++, key: "", value: "" });
  const [title, setTitle] = useState("");
  const [rows, setRows] = useState<{ id: number; key: string; value: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  const mayDiscard = useDiscardGuard();

  // Each time it opens, it starts from the collection's own fields.
  useEffect(() => {
    if (!open) return;
    setTitle("");
    setRows(columns.length ? columns.map((key) => ({ id: nextRow++, key, value: "" })) : [blank()]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on opening
  }, [open]);

  const dirty = !!title.trim() || rows.some((r) => r.value.trim());
  const update = (id: number, change: Partial<{ key: string; value: string }>) => setRows((list) => list.map((r) => (r.id === id ? { ...r, ...change } : r)));
  const cancel = async () => {
    if (await mayDiscard(dirty)) onClose();
  };
  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!title.trim() || saving) return;
    if (rows.some((r) => r.value.trim() && !r.key.trim())) return toast.error("Give each value a field name, like rating.");
    setSaving(true);
    try {
      const fields = rows.filter((r) => r.value.trim()).map((r): [string, string] => [r.key.trim(), r.value.trim()]);
      await onSave({ collection, title: title.trim(), fields });
      toast.toast(COPY.recordSaved(collection));
      onClose();
    } catch (err) {
      toast.error(message(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) void cancel();
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <form onSubmit={(ev) => void submit(ev)} className="flex flex-col gap-4 overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {COPY.newRecord} in {collection}
            </DialogTitle>
            <DialogDescription>{COPY.newRecordBody(collection)}</DialogDescription>
          </DialogHeader>
          <Field label="Title" htmlFor="new-record-title">
            <Input id="new-record-title" autoFocus value={title} onChange={(ev) => setTitle(ev.target.value)} />
          </Field>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1.5 text-sm font-medium">Fields</legend>
            <p id="new-record-fields-hint" className="text-xs text-muted-foreground">
              {COPY.fieldsHint}
            </p>
            <ul className="flex flex-col gap-2">
              {rows.map((r, i) => (
                <li key={r.id} className="flex items-center gap-2">
                  <Input
                    aria-label={`Name of field ${i + 1}`}
                    value={r.key}
                    placeholder="rating"
                    className="w-2/5"
                    onChange={(ev) => update(r.id, { key: ev.target.value })}
                  />
                  <Input
                    aria-label={r.key.trim() ? `Value of ${r.key.trim()}` : `Value of field ${i + 1}`}
                    aria-describedby="new-record-fields-hint"
                    value={r.value}
                    placeholder="5"
                    className="flex-1"
                    onChange={(ev) => update(r.id, { value: ev.target.value })}
                  />
                  <Button
                    variant="ghost"
                    size="iconSm"
                    onClick={() => setRows((list) => list.filter((x) => x.id !== r.id))}
                    disabled={rows.length === 1 && !r.key && !r.value}
                  >
                    <X aria-hidden="true" />
                    <span className="sr-only">Remove field {r.key.trim() || i + 1}</span>
                  </Button>
                </li>
              ))}
            </ul>
            <div>
              <Button variant="secondary" size="sm" onClick={() => setRows((list) => [...list, blank()])}>
                <Plus aria-hidden="true" />
                {COPY.addField}
              </Button>
            </div>
          </fieldset>
          <DialogFooter>
            <Button variant="secondary" onClick={() => void cancel()}>
              Cancel
            </Button>
            <Button type="submit" disabled={!title.trim() || saving}>
              {saving ? COPY.saving : COPY.saveRecord}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
