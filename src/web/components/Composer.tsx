import { CalendarClock, Check, ChevronDown, Paperclip, Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_TYPE } from "../../core/entry.ts";
import type { Attachment } from "../../core/entry.ts";
import type { EntryChanges, EntryInput, LoadedEntry, Project } from "../../core/layout.ts";
import { normalizeData, typeFor } from "../../core/types.ts";
import type { EventType, FieldDef } from "../../core/types.ts";
import { isoLocal, parseAmount } from "../../core/util.ts";
import { COPY } from "../copy.ts";
import { fmtAmount, fmtSize, isImage, toLocalInput } from "../lib/format.ts";
import { embedFor, embeddedHashes } from "../lib/markdown.ts";
import { cn } from "../lib/utils.ts";
import { MarkdownEditor } from "./MarkdownEditor.tsx";
import type { EditorHandle } from "./MarkdownEditor.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Field, Input } from "./ui/input.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";
import { useAsk } from "./ui/ask.tsx";
import { useToast } from "./ui/toast.tsx";

/*
  Logging something should cost one thought, not six decisions.

  Everything that used to sit behind "More options" — the type, the topic, when
  it happened, the amount — is now a row of small controls under the text, each
  showing its current value. The defaults are the common case (a plain Log, no
  topic, right now), so the fast path is still: type, save.

  Tags and amounts are read out of the text as it is written, because people
  already write "#plumbing" and "$240" without being asked to.
*/

export interface ComposerValue {
  text: string;
  type: string;
  data: Record<string, unknown>;
  projects: string[];
  amount: string;
  when: string;
  files: File[];
  removed: Set<string>;
  /**
   * Tags the event carries that aren't written in the text — set from the CLI,
   * or typed here and later edited out of the body. Without this they would be
   * silently dropped the first time the event was edited in the browser.
   */
  extraTags: string[];
}

const emptyValue = (): ComposerValue => ({
  text: "",
  type: DEFAULT_TYPE,
  data: {},
  projects: [],
  amount: "",
  when: "",
  files: [],
  removed: new Set(),
  extraTags: [],
});

export function valueFor(entry: LoadedEntry): ComposerValue {
  return {
    text: entry.body,
    type: entry.type,
    data: { ...entry.data },
    projects: [...entry.projects],
    amount: entry.amount ? `${entry.amount.value}${entry.amount.currency !== "USD" ? ` ${entry.amount.currency}` : ""}` : "",
    when: toLocalInput(entry.occurred),
    files: [],
    removed: new Set(),
    extraTags: entry.tags.filter((t) => !tagsIn(entry.body).includes(t)),
  };
}

export interface ComposerProps {
  value: ComposerValue;
  onChange(next: ComposerValue): void;
  types: EventType[];
  registry: Map<string, EventType>;
  projects: Project[];
  editing: LoadedEntry | null;
  maxAttachmentBytes: number;
  attachmentUrl(a: Attachment): string;
  onCreateProject(name: string): Promise<Project>;
  onSubmit(): void;
  saving: boolean;
  /** Compact until it has focus or content. Only the inline composer uses this. */
  collapsible?: boolean;
  /** Controls the compact form from outside, so a shortcut can open it. */
  expanded?: boolean;
  onExpandedChange?(expanded: boolean): void;
  onCancel?(): void;
  autoFocus?: boolean;
}

export function Composer({
  value,
  onChange,
  types,
  registry,
  projects,
  editing,
  maxAttachmentBytes,
  attachmentUrl,
  onCreateProject,
  onSubmit,
  saving,
  collapsible = false,
  expanded: expandedProp,
  onExpandedChange,
  onCancel,
  autoFocus,
}: ComposerProps) {
  const [ownExpanded, setOwnExpanded] = useState(!collapsible);
  const expanded = expandedProp ?? ownExpanded;
  const setExpanded = (next: boolean) => {
    setOwnExpanded(next);
    onExpandedChange?.(next);
  };
  const editor = useRef<EditorHandle>(null);
  const toast = useToast();
  const ask = useAsk();

  const def = typeFor(registry, value.type);
  const set = (patch: Partial<ComposerValue>) => onChange({ ...value, ...patch });

  // What the backend will do with this text, shown before it does it.
  const impliedTags = useMemo(() => tagsIn(value.text), [value.text]);
  const impliedAmount = useMemo(() => (value.amount.trim() ? null : amountIn(value.text)), [value.text, value.amount]);

  const existing = editing?.attachments ?? [];
  const hasContent = value.text.trim().length > 0 || value.files.length > 0;

  const addFiles = (files: File[]) => {
    const ok: File[] = [];
    for (const f of files) {
      if (f.size > maxAttachmentBytes) toast.error(COPY.tooLarge(f.name, Math.round(maxAttachmentBytes / 1048576)));
      else ok.push(f);
    }
    if (ok.length) set({ files: [...value.files, ...ok] });
  };

  if (collapsible && !expanded) {
    return (
      <button
        type="button"
        onClick={() => {
          setExpanded(true);
          requestAnimationFrame(() => editor.current?.focus());
        }}
        className={cn(
          "flex w-full items-center gap-3 rounded-lg border border-input bg-card px-3 py-3 text-left text-sm text-muted-foreground shadow-sm",
          "transition-colors hover:border-ring/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        )}
      >
        <Plus className="size-4 shrink-0" aria-hidden="true" />
        {COPY.composerPlaceholder}
      </button>
    );
  }

  return (
    <form
      className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3 shadow-sm"
      onSubmit={(ev) => {
        ev.preventDefault();
        onSubmit();
      }}
    >
      <MarkdownEditor
        handle={editor}
        label={COPY.composerPlaceholder}
        describedBy="composer-hint"
        placeholder={COPY.composerPlaceholder}
        value={value.text}
        onChange={(text) => set({ text })}
        onFiles={addFiles}
        attachments={existing}
        attachmentUrl={attachmentUrl}
        rows={collapsible ? 3 : 6}
        autoFocus={autoFocus}
        onSubmit={onSubmit}
      />

      <p id="composer-hint" className="text-xs text-muted-foreground">
        {COPY.composerHint}
      </p>

      {(impliedTags.length > 0 || impliedAmount || value.extraTags.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {impliedTags.map((t) => (
            <Badge key={t} variant="default">
              #{t}
            </Badge>
          ))}
          {impliedAmount && <Badge variant="amount">{fmtAmount(impliedAmount)}</Badge>}
          {(impliedTags.length > 0 || impliedAmount) && (
            <span className="text-xs text-muted-foreground">picked up from what you wrote</span>
          )}
          {value.extraTags.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => set({ extraTags: value.extraTags.filter((x) => x !== t) })}
              className="tap-target inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              #{t}
              <X className="size-3 opacity-60" aria-hidden="true" />
              <span className="sr-only">Remove this tag</span>
            </button>
          ))}
        </div>
      )}

      <FileList
        files={value.files}
        existing={existing}
        removed={value.removed}
        body={value.text}
        attachmentUrl={attachmentUrl}
        onRemoveNew={(i) => set({ files: value.files.filter((_, n) => n !== i) })}
        onToggleExisting={(hash) => {
          const removed = new Set(value.removed);
          if (removed.has(hash)) removed.delete(hash);
          else removed.add(hash);
          set({ removed });
        }}
        onEmbed={(markdown) => editor.current?.insert(markdown)}
      />

      {/* The four things worth deciding, each showing what it is set to now. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <TypePicker types={types} value={value.type} onChange={(type) => set({ type })} />
        <TopicPicker
          projects={projects}
          selected={value.projects}
          onToggle={(slug) =>
            set({ projects: value.projects.includes(slug) ? value.projects.filter((p) => p !== slug) : [...value.projects, slug] })
          }
          onCreate={async () => {
            const name = await ask.prompt({
              title: COPY.newTopicTitle,
              description: COPY.newTopicBody,
              label: COPY.newTopicLabel,
              placeholder: COPY.newTopicPlaceholder,
              confirmLabel: "Create",
            });
            if (!name) return;
            try {
              const project = await onCreateProject(name);
              set({ projects: [...value.projects, project.slug] });
            } catch (err) {
              toast.error(err instanceof Error ? err.message : String(err));
            }
          }}
        />
        <WhenPicker value={value.when} onChange={(when) => set({ when })} />
        {def.amount !== "none" && <AmountPicker value={value.amount} onChange={(amount) => set({ amount })} />}
      </div>

      {def.fields.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {def.fields.map((f) => (
            <TypeField
              key={f.key}
              field={f}
              value={value.data[f.key]}
              onChange={(v) => set({ data: { ...value.data, [f.key]: v } })}
            />
          ))}
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        {(onCancel || collapsible) && (
          <Button
            variant="ghost"
            onClick={() => {
              if (onCancel) onCancel();
              else setExpanded(false);
            }}
          >
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={saving || (!hasContent && !editing)}>
          {saving ? COPY.saving : editing ? "Save changes" : COPY.saveEntry}
        </Button>
      </div>
    </form>
  );
}

// ── The four pickers ────────────────────────────────────────────────────────

function PickerButton({ active, children, ...props }: React.ComponentProps<"button"> & { active?: boolean }) {
  return (
    <button
      type="button"
      className={cn(
        "tap-target inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        active ? "border-transparent bg-primary text-primary-foreground" : "border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
      {...props}
    >
      {children}
    </button>
  );
}

function TypePicker({ types, value, onChange }: { types: EventType[]; value: string; onChange(id: string): void }) {
  const [open, setOpen] = useState(false);
  const current = types.find((t) => t.id === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <PickerButton active={value !== DEFAULT_TYPE} aria-label={`Type: ${current?.label ?? value}`}>
          <span aria-hidden="true">{current?.icon ?? "•"}</span>
          {current?.label ?? value}
          <ChevronDown className="size-3 opacity-60" aria-hidden="true" />
        </PickerButton>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-1">
        <ul role="listbox" aria-label="Type">
          {types.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                role="option"
                aria-selected={t.id === value}
                onClick={() => {
                  onChange(t.id);
                  setOpen(false);
                }}
                className="flex w-full items-start gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <span aria-hidden="true" className="pt-0.5">
                  {t.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{t.label}</span>
                  {t.description && <span className="block text-xs text-muted-foreground">{t.description}</span>}
                </span>
                {t.id === value && <Check className="size-4 shrink-0" aria-hidden="true" />}
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function TopicPicker({
  projects,
  selected,
  onToggle,
  onCreate,
}: {
  projects: Project[];
  selected: string[];
  onToggle(slug: string): void;
  onCreate(): void;
}) {
  const [open, setOpen] = useState(false);
  const names = selected.map((s) => projects.find((p) => p.slug === s)?.name ?? s);
  const label = names.length === 0 ? COPY.topic : names.length === 1 ? names[0] : `${names.length} topics`;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <PickerButton active={selected.length > 0} aria-label={`Topic: ${names.join(", ") || "none"}`}>
          {label}
          <ChevronDown className="size-3 opacity-60" aria-hidden="true" />
        </PickerButton>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-1">
        <ul className="max-h-64 overflow-y-auto">
          {projects.map((p) => (
            <li key={p.slug}>
              <button
                type="button"
                aria-pressed={selected.includes(p.slug)}
                onClick={() => onToggle(p.slug)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <span className="flex-1 truncate">{p.name}</span>
                {selected.includes(p.slug) && <Check className="size-4 shrink-0" aria-hidden="true" />}
              </button>
            </li>
          ))}
          {projects.length === 0 && <li className="px-2 py-3 text-xs text-muted-foreground">{COPY.topicsEmpty}</li>}
        </ul>
        <Button
          variant="ghost"
          className="mt-1 w-full justify-start"
          size="sm"
          onClick={() => {
            setOpen(false);
            onCreate();
          }}
        >
          <Plus aria-hidden="true" />
          {COPY.newTopic}
        </Button>
      </PopoverContent>
    </Popover>
  );
}

/**
 * When it happened. Blank means now, which is what almost every event is, and
 * logging something from last week is two clicks instead of a hunt through a
 * collapsed panel.
 */
function WhenPicker({ value, onChange }: { value: string; onChange(v: string): void }) {
  const [open, setOpen] = useState(false);
  const label = value ? new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "Now";

  const at = (daysAgo: number) => {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    // Keep the current time of day: "yesterday" means this time yesterday.
    return toLocalInput(d.toISOString());
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <PickerButton active={!!value} aria-label={`When it happened: ${label}`}>
          <CalendarClock className="size-3" aria-hidden="true" />
          {label}
          <ChevronDown className="size-3 opacity-60" aria-hidden="true" />
        </PickerButton>
      </PopoverTrigger>
      <PopoverContent className="w-72">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-1.5">
            <Button variant="secondary" size="sm" onClick={() => { onChange(""); setOpen(false); }}>
              Now
            </Button>
            <Button variant="secondary" size="sm" onClick={() => { onChange(at(1)); setOpen(false); }}>
              Yesterday
            </Button>
            <Button variant="secondary" size="sm" onClick={() => { onChange(at(7)); setOpen(false); }}>
              A week ago
            </Button>
          </div>
          <Field label="Or pick a date and time" htmlFor="composer-when">
            <Input
              id="composer-when"
              type="datetime-local"
              value={value}
              max={toLocalInput(new Date().toISOString())}
              onChange={(ev) => onChange(ev.target.value)}
            />
          </Field>
          <p className="text-xs text-muted-foreground">
            This is when it happened. GitRoll always records separately when you wrote it down.
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function AmountPicker({ value, onChange }: { value: string; onChange(v: string): void }) {
  const [open, setOpen] = useState(false);
  const parsed = value.trim() ? parseAmount(value) : null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <PickerButton active={!!parsed} aria-label={`Amount: ${parsed ? fmtAmount(parsed) : "none"}`}>
          {parsed ? fmtAmount(parsed) : "Amount"}
          <ChevronDown className="size-3 opacity-60" aria-hidden="true" />
        </PickerButton>
      </PopoverTrigger>
      <PopoverContent className="w-60">
        <Field label="Amount" htmlFor="composer-amount" hint="Like 1850, $1,850 or 1850 EUR.">
          <Input
            id="composer-amount"
            inputMode="decimal"
            autoComplete="off"
            value={value}
            placeholder="$0.00"
            onChange={(ev) => onChange(ev.target.value)}
            aria-invalid={value.trim() !== "" && !parsed}
          />
        </Field>
      </PopoverContent>
    </Popover>
  );
}

function TypeField({ field: f, value, onChange }: { field: FieldDef; value: unknown; onChange(v: unknown): void }) {
  const id = `field-${f.key}`;
  const v = value == null ? "" : String(value);
  if (f.kind === "boolean") {
    return (
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          id={id}
          checked={value === true}
          onChange={(ev) => onChange(ev.target.checked ? true : undefined)}
          className="size-4 rounded border-input"
        />
        {f.label}
      </label>
    );
  }
  return (
    <Field label={f.label} htmlFor={id} hint={f.help} className={f.kind === "longtext" ? "sm:col-span-2" : undefined}>
      {f.kind === "longtext" ? (
        <textarea
          id={id}
          rows={2}
          value={v}
          required={f.required}
          onChange={(ev) => onChange(ev.target.value)}
          className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-sm:text-base"
        />
      ) : f.kind === "select" ? (
        <select
          id={id}
          value={v}
          required={f.required}
          onChange={(ev) => onChange(ev.target.value)}
          className="h-9 w-full rounded-md border border-input bg-card px-2 text-sm shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-sm:text-base"
        >
          <option value="" />
          {(f.options ?? []).map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      ) : (
        <Input
          id={id}
          type={f.kind === "number" ? "number" : f.kind === "date" ? "date" : f.kind === "url" ? "url" : "text"}
          step={f.kind === "number" ? "any" : undefined}
          placeholder={f.kind === "url" ? "https://" : undefined}
          required={f.required}
          value={f.kind === "date" ? v.slice(0, 10) : v}
          onChange={(ev) => onChange(ev.target.value)}
        />
      )}
    </Field>
  );
}

// ── Attachments ─────────────────────────────────────────────────────────────

function FileList({
  files,
  existing,
  removed,
  body,
  attachmentUrl,
  onRemoveNew,
  onToggleExisting,
  onEmbed,
}: {
  files: File[];
  existing: Attachment[];
  removed: Set<string>;
  body: string;
  attachmentUrl(a: Attachment): string;
  onRemoveNew(index: number): void;
  onToggleExisting(hash: string): void;
  onEmbed(markdown: string): void;
}) {
  const previews = usePreviews(files);
  const embedded = useMemo(() => embeddedHashes(body), [body]);
  if (!files.length && !existing.length) return null;

  return (
    <ul className="flex flex-col gap-1.5">
      {existing.map((a) => {
        const isRemoved = removed.has(a.hash);
        return (
          <li
            key={a.hash}
            className={cn(
              "flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-sm",
              isRemoved && "opacity-50",
            )}
          >
            {isImage(a) ? (
              <img src={attachmentUrl(a)} alt="" className="size-8 rounded object-cover" />
            ) : (
              <Paperclip className="size-4 text-muted-foreground" aria-hidden="true" />
            )}
            <span className={cn("min-w-0 flex-1 truncate", isRemoved && "line-through")}>{a.name}</span>
            {!isRemoved && !embedded.has(a.hash) && (
              <Button variant="ghost" size="sm" onClick={() => onEmbed(embedFor(a))}>
                Put in the text
              </Button>
            )}
            {embedded.has(a.hash) && <span className="text-xs text-muted-foreground">in the text</span>}
            <Button variant="ghost" size="sm" onClick={() => onToggleExisting(a.hash)}>
              {isRemoved ? "Keep" : "Remove"}
            </Button>
          </li>
        );
      })}

      {files.map((f, i) => (
        <li key={`${f.name}-${i}`} className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-sm">
          {previews[i] ? (
            <img src={previews[i]} alt="" className="size-8 rounded object-cover" />
          ) : (
            <Paperclip className="size-4 text-muted-foreground" aria-hidden="true" />
          )}
          <span className="min-w-0 flex-1 truncate">{f.name || "Pasted file"}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{fmtSize(f.size)}</span>
          <Button variant="ghost" size="iconSm" onClick={() => onRemoveNew(i)}>
            <X aria-hidden="true" />
            <span className="sr-only">Remove {f.name || "this file"}</span>
          </Button>
        </li>
      ))}
    </ul>
  );
}

/** Object URLs for image previews, revoked when the list changes. */
function usePreviews(files: File[]): (string | null)[] {
  const [urls, setUrls] = useState<(string | null)[]>([]);
  useEffect(() => {
    const made = files.map((f) => (isImage(f) ? URL.createObjectURL(f) : null));
    setUrls(made);
    return () => {
      for (const u of made) if (u) URL.revokeObjectURL(u);
    };
  }, [files]);
  return urls;
}

// ── Reading text ────────────────────────────────────────────────────────────

/** The #tags in a body, matching what the Roll will store. */
export function tagsIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(^|[\s(])#(\p{L}[\p{L}\p{N}_-]*)/gu)) out.add(m[2].toLowerCase());
  return [...out];
}

/** The first money-looking number in a body, offered as the amount. */
export function amountIn(text: string): { value: number; currency: string } | null {
  const m = /(^|\s)([$€£¥])\s?(\d[\d,]*(?:\.\d{1,2})?)/.exec(text);
  return m ? parseAmount(`${m[2]}${m[3]}`) : null;
}

/** Turns what was typed into what the API takes. Throws UserError-ish strings. */
export function toInput(value: ComposerValue, registry: Map<string, EventType>): { input: EntryInput; error?: string } {
  const def = typeFor(registry, value.type);
  const typed = value.amount.trim();
  const parsed = typed ? parseAmount(typed) : amountIn(value.text);
  if (typed && !parsed) return { input: { text: "" }, error: COPY.badAmount };

  const knownKeys = new Set([...registry.values()].flatMap((t) => t.fields.map((f) => f.key)));
  const data = normalizeData(
    def,
    Object.fromEntries(Object.entries(value.data).filter(([k]) => def.fields.some((f) => f.key === k) || !knownKeys.has(k))),
  );

  return {
    input: {
      text: value.text,
      type: value.type,
      data,
      projects: value.projects,
      // Tags written in the text are merged in by the Roll itself; these are the
      // ones that live only on the event.
      tags: value.extraTags,
      amount: parsed ?? undefined,
      occurred: value.when ? isoLocal(new Date(value.when)) : undefined,
    },
  };
}

export function toChanges(value: ComposerValue, registry: Map<string, EventType>, base: LoadedEntry): { changes: EntryChanges; error?: string } {
  const { input, error } = toInput(value, registry);
  if (error) return { changes: {}, error };
  const changes: EntryChanges = {
    text: input.text,
    type: input.type,
    data: input.data,
    projects: input.projects,
    tags: value.extraTags,
    amount: input.amount ?? null,
    removeAttachments: [...value.removed],
  };
  if (value.when !== toLocalInput(base.occurred)) changes.occurred = value.when ? isoLocal(new Date(value.when)) : "";
  return { changes };
}

export { emptyValue };
