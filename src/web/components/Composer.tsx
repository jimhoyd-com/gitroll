import { CalendarClock, Check, ChevronDown, Paperclip, Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Attachment } from "../../core/entry.ts";
import type { EntryChanges, EntryInput, LoadedEntry } from "../../core/layout.ts";
import { parseAmount, slugify } from "../../core/util.ts";
import { TEMPLATES, renderTemplate } from "../../core/templates.ts";
import { COPY } from "../copy.ts";
import { fmtAmount, fmtSize, isImage, toDateInput } from "../lib/format.ts";
import { linkedPaths } from "../lib/markdown.ts";
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

  What you type is the event: the text box holds the Markdown that ends up in
  the file, links and all. The controls under it — topic, date, amount — are the
  optional front matter, each showing its current value. The defaults are the
  common case (no topic, today), so the fast path is still: type, save.

  Tags and amounts are read out of the text as it is written, because people
  already write "#plumbing" and "$240" without being asked to.
*/

export interface ComposerValue {
  text: string;
  projects: string[];
  amount: string;
  /** The event's date, as YYYY-MM-DD. Blank means today for a new event. */
  when: string;
  files: File[];
  /**
   * Tags the event carries that aren't written in the text — set from the CLI,
   * or typed here and later edited out of the body. Without this they would be
   * silently dropped the first time the event was edited in the browser.
   */
  extraTags: string[];
}

const emptyValue = (): ComposerValue => ({
  text: "",
  projects: [],
  amount: "",
  when: "",
  files: [],
  extraTags: [],
});

export function valueFor(entry: LoadedEntry): ComposerValue {
  return {
    text: entry.body,
    projects: [...entry.projects],
    amount: entry.amount ? `${entry.amount.value}${entry.amount.currency !== "USD" ? ` ${entry.amount.currency}` : ""}` : "",
    when: toDateInput(entry.date),
    files: [],
    extraTags: entry.tags.filter((t) => !tagsIn(entry.body).includes(t)),
  };
}

export interface ComposerProps {
  value: ComposerValue;
  onChange(next: ComposerValue): void;
  projects: string[];
  editing: LoadedEntry | null;
  maxAttachmentBytes: number;
  attachmentUrl(a: Attachment): string;
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
  projects,
  editing,
  maxAttachmentBytes,
  attachmentUrl,
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
        body={value.text}
        at={editing?.path ?? ""}
        attachmentUrl={attachmentUrl}
        onRemoveNew={(i) => set({ files: value.files.filter((_, n) => n !== i) })}
      />

      {/* The three things worth deciding, each showing what it is set to now. */}
      <div className="flex flex-wrap items-center gap-1.5">
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
              confirmLabel: "Add",
            });
            const slug = slugify(name ?? "");
            if (!slug) return;
            set({ projects: [...value.projects, slug] });
          }}
        />
        <WhenPicker value={value.when} onChange={(when) => set({ when })} />
        <AmountPicker value={value.amount} onChange={(amount) => set({ amount })} />
        {!editing && (
          <TemplatePicker
            onPick={(id) => {
              const template = TEMPLATES.find((t) => t.id === id)!;
              const typed = value.text.trim();
              // Whatever was already typed becomes the title, and is never thrown away.
              const text = renderTemplate(template, typed.split("\n")[0].replace(/^#+\s*/, ""));
              set({
                text: typed.includes("\n") ? `${text}\n${typed.split("\n").slice(1).join("\n").trim()}\n` : text,
                extraTags: [...new Set([...value.extraTags, ...template.tags])],
              });
              requestAnimationFrame(() => editor.current?.focus());
            }}
          />
        )}
      </div>

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

function TopicPicker({
  projects,
  selected,
  onToggle,
  onCreate,
}: {
  projects: string[];
  selected: string[];
  onToggle(slug: string): void;
  onCreate(): void;
}) {
  const [open, setOpen] = useState(false);
  const names = selected;
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
            <li key={p}>
              <button
                type="button"
                aria-pressed={selected.includes(p)}
                onClick={() => onToggle(p)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <span className="flex-1 truncate">{p}</span>
                {selected.includes(p) && <Check className="size-4 shrink-0" aria-hidden="true" />}
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
 * The date the event happened. Blank means today, which is what almost every
 * event is; logging something from last week is two clicks.
 */
function WhenPicker({ value, onChange }: { value: string; onChange(v: string): void }) {
  const [open, setOpen] = useState(false);
  const label = value ? new Date(`${value}T12:00:00`).toLocaleDateString([], { dateStyle: "medium" }) : "Today";

  const at = (daysAgo: number) => {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <PickerButton active={!!value} aria-label={`Date: ${label}`}>
          <CalendarClock className="size-3" aria-hidden="true" />
          {label}
          <ChevronDown className="size-3 opacity-60" aria-hidden="true" />
        </PickerButton>
      </PopoverTrigger>
      <PopoverContent className="w-72">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-1.5">
            <Button variant="secondary" size="sm" onClick={() => { onChange(""); setOpen(false); }}>
              Today
            </Button>
            <Button variant="secondary" size="sm" onClick={() => { onChange(at(1)); setOpen(false); }}>
              Yesterday
            </Button>
            <Button variant="secondary" size="sm" onClick={() => { onChange(at(7)); setOpen(false); }}>
              A week ago
            </Button>
          </div>
          <Field label="Or pick a date" htmlFor="composer-when">
            <Input id="composer-when" type="date" value={value} max={at(0)} onChange={(ev) => onChange(ev.target.value)} />
          </Field>
          <p className="text-xs text-muted-foreground">
            The date goes in the file name, so the folder reads like a timeline.
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * A starting point for the kinds of event people write often. It only fills the
 * box with headings worth answering: what comes out is ordinary Markdown, and
 * deleting a heading you don't need costs nothing.
 */
function TemplatePicker({ onPick }: { onPick(id: string): void }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <PickerButton aria-label="Start from a template">
          Template
          <ChevronDown className="size-3 opacity-60" aria-hidden="true" />
        </PickerButton>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-1">
        <ul>
          {TEMPLATES.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => {
                  onPick(t.id);
                  setOpen(false);
                }}
                className="w-full rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <span className="block font-medium">{t.label}</span>
                <span className="block text-xs text-muted-foreground">{t.description}</span>
              </button>
            </li>
          ))}
        </ul>
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

// ── Attachments ─────────────────────────────────────────────────────────────

function FileList({
  files,
  existing,
  body,
  at,
  attachmentUrl,
  onRemoveNew,
}: {
  files: File[];
  existing: Attachment[];
  body: string;
  at: string;
  attachmentUrl(a: Attachment): string;
  onRemoveNew(index: number): void;
}) {
  const previews = usePreviews(files);
  const linked = useMemo(() => linkedPaths(body, at), [body, at]);
  if (!files.length && !existing.length) return null;

  return (
    <ul className="flex flex-col gap-1.5">
      {existing.map((a) => (
        <li key={a.path} className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-sm">
          {isImage(a) ? (
            <img src={attachmentUrl(a)} alt="" className="size-8 rounded object-cover" />
          ) : (
            <Paperclip className="size-4 text-muted-foreground" aria-hidden="true" />
          )}
          <span className="min-w-0 flex-1 truncate">{a.name}</span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {linked.has(a.path) ? "linked in the text" : "no longer linked"}
          </span>
        </li>
      ))}

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

/** Turns what was typed into what the API takes. */
export function toInput(value: ComposerValue): { input: EntryInput; error?: string } {
  const typed = value.amount.trim();
  const parsed = typed ? parseAmount(typed) : amountIn(value.text);
  if (typed && !parsed) return { input: { text: "" }, error: COPY.badAmount };

  return {
    input: {
      text: value.text,
      projects: value.projects,
      // Tags written in the text are picked up when the file is read; these are
      // the ones that live only in the front matter.
      tags: value.extraTags,
      amount: parsed ?? undefined,
      date: value.when || undefined,
    },
  };
}

export function toChanges(value: ComposerValue, base: LoadedEntry): { changes: EntryChanges; error?: string } {
  const { input, error } = toInput(value);
  if (error) return { changes: {}, error };
  const changes: EntryChanges = {
    text: input.text,
    projects: input.projects,
    tags: value.extraTags,
    amount: input.amount ?? null,
  };
  // Only write a date when it differs from what the file name already says.
  if (value.when !== toDateInput(base.date)) changes.date = value.when || "";
  return { changes };
}

export { emptyValue };
