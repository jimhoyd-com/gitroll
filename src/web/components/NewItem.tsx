import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type * as React from "react";
import { relativeLink } from "../../core/entry.ts";
import type { EntryInput, LoadedEntry } from "../../core/layout.ts";
import { FIELD_NAME, fieldYaml, recordsIn } from "../../core/fields.ts";
import { PEOPLE_COLLECTION, ORGANIZATIONS_COLLECTION } from "../../core/contacts.ts";
import { PLACES_COLLECTION } from "../../core/places.ts";
import { INVENTORY_COLLECTION } from "../../core/inventory.ts";
import { isoDate, parseAmount } from "../../core/util.ts";
import { message } from "../lib/format.ts";
import { useDiscardGuard } from "./ViewParts.tsx";
import { Button } from "./ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog.tsx";
import { Field, Input, Textarea } from "./ui/input.tsx";
import { useToast } from "./ui/toast.tsx";

/*
  Writing every construct from the browser. Each one is the file the command
  line writes for it, so nothing here is a new format:

    contact, organization, place, thing   a record in notes/people/, organizations/,
                                          places/ or inventory/ (gitroll add)
    issue                                 an event with issue: open
    expense                               an event with an amount (the ledger)
    reading                               an event with one number field (a series)
    reminder                              a to-do with ⏰ and a time (gitroll remind)
    file                                  a file in files/, its title in a sidecar (gitroll attach)

  Events, notes, to-dos, records and bookmarks have their own forms already.
*/

export type NewKind = "contact" | "organization" | "place" | "thing" | "issue" | "expense" | "reading" | "reminder" | "file";

/** What a store lets the browser write. A kind whose writer is missing isn't offered. */
export interface Writers {
  /** The path is null when the event is kept on this device until it can be sent. */
  addEntry(input: EntryInput): Promise<{ path: string | null }>;
  addRecord?(input: { collection: string; title: string; fields: [string, string][] }): Promise<{ path: string }>;
  addTodo?(text: string): Promise<void>;
  addFile?(file: File, fields: [string, string][]): Promise<{ path: string }>;
}

export const canWrite = (w: Writers, kind: NewKind): boolean => {
  switch (KINDS[kind].writer) {
    case "record":
      return !!w.addRecord;
    case "todo":
      return !!w.addTodo;
    case "file":
      return !!w.addFile;
    default:
      return true;
  }
};

/** Something a new item starts with, such as the field a reading is of. */
export interface Preset {
  field?: string;
  /** What was typed in the box on Home, carried into the full form. */
  title?: string;
  amount?: string;
  day?: string;
  time?: string;
}

interface NewItemApi {
  open(kind: NewKind, preset?: Preset): void;
  can(kind: NewKind): boolean;
}

const NewItemContext = createContext<NewItemApi | null>(null);

/** The pages' way to offer a new item: null where nothing can be written. */
export const useNewItem = () => useContext(NewItemContext);

type InputKind = "text" | "email" | "tel" | "url" | "date" | "number" | "place" | "org";

interface FieldSpec {
  key: string;
  label: string;
  type?: InputKind;
  placeholder?: string;
}

interface KindSpec {
  /** Says what it is, in the New menu and the dialog. */
  label: string;
  title: string;
  description: string;
  writer: "record" | "entry" | "todo" | "file";
  collection?: string;
  titleLabel: string;
  titlePlaceholder: string;
  fields?: FieldSpec[];
}

export const KINDS: Record<NewKind, KindSpec> = {
  contact: {
    label: "Contact",
    title: "New contact",
    description: "A record in notes/people/, with vCard's names for its fields. Events that link to it are when you last saw them.",
    writer: "record",
    collection: PEOPLE_COLLECTION,
    titleLabel: "Name",
    titlePlaceholder: "Ada Lovelace",
    fields: [
      { key: "email", label: "Email", type: "email" },
      { key: "tel", label: "Phone", type: "tel" },
      { key: "org", label: "Organization", type: "org" },
      { key: "jobTitle", label: "Job title" },
      { key: "bday", label: "Birthday", type: "date" },
    ],
  },
  organization: {
    label: "Organization",
    title: "New organization",
    description: "A record in notes/organizations/: a company, a club, a shop. Its people are the contacts whose organization names it.",
    writer: "record",
    collection: ORGANIZATIONS_COLLECTION,
    titleLabel: "Name",
    titlePlaceholder: "Cool Air Co",
    fields: [
      { key: "url", label: "Website", type: "url", placeholder: "https://…" },
      { key: "telephone", label: "Phone", type: "tel" },
      { key: "email", label: "Email", type: "email" },
      { key: "address", label: "Address" },
      { key: "location", label: "Place", type: "place" },
    ],
  },
  place: {
    label: "Place",
    title: "New place",
    description: "A record in notes/places/. A place can be within another one: a shelf in the garage, the garage at home.",
    writer: "record",
    collection: PLACES_COLLECTION,
    titleLabel: "Name",
    titlePlaceholder: "Garage",
    fields: [
      { key: "address", label: "Address" },
      { key: "within", label: "Within", type: "place" },
      { key: "telephone", label: "Phone", type: "tel" },
      { key: "url", label: "Website", type: "url", placeholder: "https://…" },
    ],
  },
  thing: {
    label: "Thing",
    title: "New thing",
    description: "A record in notes/inventory/: something you own, with what it cost, its warranty and where it is.",
    writer: "record",
    collection: INVENTORY_COLLECTION,
    titleLabel: "Name",
    titlePlaceholder: "Furnace",
    fields: [
      { key: "brand", label: "Brand" },
      { key: "model", label: "Model" },
      { key: "price", label: "Price", placeholder: "$1,299.00" },
      { key: "purchaseDate", label: "Bought", type: "date" },
      { key: "warranty", label: "Warranty until", type: "date" },
      { key: "location", label: "Where it is", type: "place" },
      { key: "quantity", label: "Quantity", type: "number" },
    ],
  },
  issue: {
    label: "Issue",
    title: "New issue",
    description: "An event marked issue: open, for something that went wrong. It stays open until a later event resolves it.",
    writer: "entry",
    titleLabel: "What's wrong",
    titlePlaceholder: "Clunk from the front wheel",
  },
  expense: {
    label: "Expense",
    title: "New expense",
    description: "An event with an amount, on the day it was paid. The ledger adds amounts up per currency.",
    writer: "entry",
    titleLabel: "What it was",
    titlePlaceholder: "Furnace service",
  },
  reading: {
    label: "Reading",
    title: "New reading",
    description: "An event with one number field, on its day: an odometer, a weight, a meter. Series follows the field over time.",
    writer: "entry",
    titleLabel: "Note (optional)",
    titlePlaceholder: "Oil change",
  },
  reminder: {
    label: "Reminder",
    title: "New reminder",
    description: "A to-do in notes/todo.md with ⏰ and a time. GitRoll lists it when it is due, and your calendar app can alert you.",
    writer: "todo",
    titleLabel: "Remind me to",
    titlePlaceholder: "Call the dentist",
  },
  file: {
    label: "File",
    title: "Add a file",
    description: "A file kept on its own in files/: a passport scan, a manual, a receipt. Its title goes in a note beside it.",
    writer: "file",
    titleLabel: "Title (optional)",
    titlePlaceholder: "Passport",
  },
};

/** Text as a YAML value that reads back as that same text. */
const text = (s: string): string => fieldYaml(s.trim()) ?? JSON.stringify(s.trim());

/** A Markdown link from a new record in `collection` to another record, as a field holds one. */
function linkTo(collection: string, to: LoadedEntry): string {
  return `[${to.title.replace(/[[\]]/g, "")}](${relativeLink(`.gitroll/notes/${collection}/new.md`, to.path)})`;
}

export type NewRequest = { kind: NewKind; preset: Preset } | null;

/**
 * Adds the New dialog to everything inside it, for the writers a store has.
 * The app holds which one is open, so its New menu can open them too.
 */
export function NewItemProvider({
  writers,
  notes,
  request,
  onRequest,
  onWritten,
  children,
}: {
  writers: Writers;
  notes: LoadedEntry[];
  request: NewRequest;
  onRequest(next: NewRequest): void;
  onWritten(path: string | null): void;
  children: React.ReactNode;
}) {
  const api = useMemo<NewItemApi>(
    () => ({ open: (kind, preset = {}) => onRequest({ kind, preset }), can: (kind) => canWrite(writers, kind) }),
    [writers, onRequest],
  );
  return (
    <NewItemContext.Provider value={api}>
      {children}
      {request && canWrite(writers, request.kind) && (
        <NewItemDialog
          key={request.kind}
          kind={request.kind}
          preset={request.preset}
          writers={writers}
          notes={notes}
          onClose={() => onRequest(null)}
          onWritten={onWritten}
        />
      )}
    </NewItemContext.Provider>
  );
}

/** A button that opens the New dialog for one kind, shown only where it can be written. */
export function NewButton({ kind, preset, children }: { kind: NewKind; preset?: Preset; children?: React.ReactNode }) {
  const api = useNewItem();
  if (!api?.can(kind)) return null;
  return (
    <Button size="sm" onClick={() => api.open(kind, preset)}>
      {children ?? KINDS[kind].title}
    </Button>
  );
}

function NewItemDialog({
  kind,
  preset,
  writers,
  notes,
  onClose,
  onWritten,
}: {
  kind: NewKind;
  preset: Preset;
  writers: Writers;
  notes: LoadedEntry[];
  onClose(): void;
  onWritten(path: string | null): void;
}) {
  const spec = KINDS[kind];
  const toast = useToast();
  const mayDiscard = useDiscardGuard();
  const [title, setTitle] = useState(preset.title ?? "");
  const [details, setDetails] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [amount, setAmount] = useState(preset.amount ?? "");
  const [day, setDay] = useState(preset.day ?? isoDate());
  const [time, setTime] = useState(preset.time ?? "09:00");
  const [field, setField] = useState(preset.field ?? "");
  const [reading, setReading] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => setError(""), [title, amount, reading, field, file, values]);

  const places = useMemo(() => recordsIn(notes, PLACES_COLLECTION).sort((a, b) => a.title.localeCompare(b.title)), [notes]);
  const orgs = useMemo(
    () =>
      recordsIn(notes, ORGANIZATIONS_COLLECTION)
        .map((o) => o.title)
        .sort(),
    [notes],
  );
  const touched = !!(title.trim() || details.trim() || amount.trim() || reading.trim() || file || Object.values(values).some((v) => v.trim()));

  const parsedAmount = kind === "expense" && amount.trim() ? parseAmount(amount) : null;
  const ready = (() => {
    switch (kind) {
      case "expense":
        return !!title.trim() && !!parsedAmount && !!day;
      case "reading":
        return FIELD_NAME.test(field.trim()) && reading.trim() !== "" && Number.isFinite(Number(reading)) && !!day;
      case "reminder":
        return !!title.trim() && !!day && !!time;
      case "file":
        return !!file;
      default:
        return !!title.trim();
    }
  })();

  const cancel = async () => {
    if (await mayDiscard(touched)) onClose();
  };

  const write = async (): Promise<{ path: string | null; said: string }> => {
    const name = title.trim();
    switch (spec.writer) {
      case "record": {
        const collection = spec.collection!;
        const fields: [string, string][] = [];
        for (const f of spec.fields ?? []) {
          const v = (values[f.key] ?? "").trim();
          if (!v) continue;
          if (f.type === "place") {
            const to = places.find((p) => p.path === v);
            if (to) fields.push([f.key, linkTo(collection, to)]);
          } else if (f.type === "date") fields.push([f.key, v]);
          else if (f.type === "number" && Number.isFinite(Number(v))) fields.push([f.key, String(Number(v))]);
          else if (f.key === "price" && /^\d[\d,]*(\.\d+)?$/.test(v)) fields.push(["price", v.replace(/,/g, "")]);
          else if (f.key === "price" && parseAmount(v)) {
            const a = parseAmount(v)!;
            fields.push(["price", String(a.value)], ["priceCurrency", a.currency]);
          } else fields.push([f.key, text(v)]);
        }
        const { path } = await writers.addRecord!({ collection, title: name, fields });
        return { path, said: `${spec.label} saved.` };
      }
      case "entry": {
        if (kind === "issue") {
          const { path } = await writers.addEntry({ title: name, text: details, fields: [["issue", "open"]] });
          return { path, said: "Issue saved. It stays open until an event resolves it." };
        }
        if (kind === "expense") {
          const { path } = await writers.addEntry({ title: name, text: details, date: day, amount: parsedAmount! });
          return { path, said: "Expense saved. It's on the ledger." };
        }
        const key = field.trim();
        const { path } = await writers.addEntry({
          title: name || `${key} ${reading.trim()}`,
          text: details,
          date: day,
          fields: [[key, String(Number(reading))]],
        });
        return { path, said: `Reading saved. It's on the ${key} series.` };
      }
      case "todo":
        await writers.addTodo!(`${name} ⏰ ${day} ${time}`);
        return { path: null, said: "Reminder saved. It's in your to-dos." };
      case "file": {
        const { path } = await writers.addFile!(file!, name ? [["title", text(name)]] : []);
        return { path, said: "File added." };
      }
    }
  };

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!ready || saving) return;
    setSaving(true);
    setError("");
    try {
      const { path, said } = await write();
      toast.toast(said);
      onClose();
      onWritten(path);
    } catch (err) {
      setError(message(err));
    } finally {
      setSaving(false);
    }
  };

  const id = (key: string) => `new-${kind}-${key}`;
  const set = (key: string) => (ev: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setValues((v) => ({ ...v, [key]: ev.target.value }));
  const selectClass =
    "h-9 w-full rounded-md border border-input bg-card px-2 text-sm text-foreground shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-sm:text-base";

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) void cancel();
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <form onSubmit={(ev) => void submit(ev)} aria-label={spec.title} className="flex flex-col gap-4 overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{spec.title}</DialogTitle>
            <DialogDescription>{spec.description}</DialogDescription>
          </DialogHeader>

          {kind === "file" && (
            <Field label="File" htmlFor={id("file")}>
              <Input id={id("file")} type="file" onChange={(ev) => setFile(ev.target.files?.[0] ?? null)} className="py-1.5" />
            </Field>
          )}

          {kind === "reading" && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Field" htmlFor={id("field")}>
                <Input id={id("field")} autoFocus={!field} value={field} onChange={(ev) => setField(ev.target.value)} placeholder="odometer" />
              </Field>
              <Field label="Value" htmlFor={id("value")}>
                <Input
                  id={id("value")}
                  autoFocus={!!field}
                  inputMode="decimal"
                  value={reading}
                  onChange={(ev) => setReading(ev.target.value)}
                  placeholder="48210"
                />
              </Field>
            </div>
          )}

          <Field label={spec.titleLabel} htmlFor={id("title")}>
            <Input
              id={id("title")}
              autoFocus={kind !== "reading" && kind !== "file"}
              value={title}
              onChange={(ev) => setTitle(ev.target.value)}
              placeholder={spec.titlePlaceholder}
            />
          </Field>

          {kind === "expense" && (
            <Field label="Amount" htmlFor={id("amount")} hint="A number, with a currency if it isn't dollars: 120, $120.50, 99 EUR.">
              <Input id={id("amount")} inputMode="decimal" value={amount} onChange={(ev) => setAmount(ev.target.value)} placeholder="$120.00" />
            </Field>
          )}

          {(kind === "expense" || kind === "reading" || kind === "reminder") && (
            <div className="grid grid-cols-2 gap-3">
              <Field label={kind === "reminder" ? "Day" : "Date"} htmlFor={id("day")}>
                <Input id={id("day")} type="date" value={day} onChange={(ev) => setDay(ev.target.value)} />
              </Field>
              {kind === "reminder" && (
                <Field label="Time" htmlFor={id("time")}>
                  <Input id={id("time")} type="time" value={time} onChange={(ev) => setTime(ev.target.value)} />
                </Field>
              )}
            </div>
          )}

          {spec.fields && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {spec.fields.map((f) =>
                f.type === "place" ? (
                  <Field key={f.key} label={f.label} htmlFor={id(f.key)}>
                    <select id={id(f.key)} value={values[f.key] ?? ""} onChange={set(f.key)} className={selectClass}>
                      <option value="">{places.length ? "None" : "No places yet"}</option>
                      {places.map((p) => (
                        <option key={p.path} value={p.path}>
                          {p.title}
                        </option>
                      ))}
                    </select>
                  </Field>
                ) : (
                  <Field key={f.key} label={f.label} htmlFor={id(f.key)}>
                    <Input
                      id={id(f.key)}
                      type={f.type === "org" ? "text" : (f.type ?? "text")}
                      list={f.type === "org" && orgs.length ? id("orgs") : undefined}
                      value={values[f.key] ?? ""}
                      onChange={set(f.key)}
                      placeholder={f.placeholder}
                    />
                  </Field>
                ),
              )}
              {orgs.length > 0 && (
                <datalist id={id("orgs")}>
                  {orgs.map((o) => (
                    <option key={o} value={o} />
                  ))}
                </datalist>
              )}
            </div>
          )}

          {(kind === "issue" || kind === "expense" || kind === "reading") && (
            <Field label="Details (optional)" htmlFor={id("details")}>
              <Textarea id={id("details")} rows={3} value={details} onChange={(ev) => setDetails(ev.target.value)} />
            </Field>
          )}

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button variant="secondary" onClick={() => void cancel()}>
              Cancel
            </Button>
            <Button type="submit" disabled={!ready || saving}>
              {saving ? "Saving…" : kind === "file" ? "Add file" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
