import { CalendarClock, ChevronDown, Paperclip, Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Attachment } from "../../core/entry.ts";
import type { EntryChanges, EntryInput, LoadedEntry } from "../../core/layout.ts";
import { parseAmount } from "../../core/util.ts";
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
  amount: string;
  /** The event's date, as YYYY-MM-DD. Blank means today for a new event. */
  when: string;
  /**
   * The time of day, as HH:MM, for an event that happened at one. Only offered
   * once a date has been chosen: an event logged as it happens is timed by the
   * commit that saves it, to the second.
   */
  time: string;
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
  amount: "",
  when: "",
  time: "",
  files: [],
  extraTags: [],
});

export function valueFor(entry: LoadedEntry): ComposerValue {
  return {
    text: entry.body,
    amount: entry.amount ? `${entry.amount.value}${entry.amount.currency !== "USD" ? ` ${entry.amount.currency}` : ""}` : "",
    when: toDateInput(entry.date),
    time: entry.date && entry.date.length > 10 ? entry.date.slice(11, 16) : "",
    files: [],
    extraTags: entry.tags.filter((t) => !tagsIn(entry.body).includes(t)),
  };
}

export interface ComposerProps {
  value: ComposerValue;
  onChange(next: ComposerValue): void;
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

  const set = (patch: Partial<ComposerValue>) => onChange({ ...value, ...patch });

  // What the backend will do with this text, shown before it does it.
  const impliedTags = useMemo(() => tagsIn(value.text), [value.text]);
  const impliedAmount = useMemo(() => (value.amount.trim() ? null : amountIn(value.text)), [value.text, value.amount]);
  const [amountAsked, setAmountAsked] = useState(false);
  const showAmount = amountAsked || !!value.amount.trim() || !!impliedAmount;

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
        rows={collapsible ? 9 : 18}
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

      {/* What's worth deciding about this entry, each showing what it is set to
          now. When it happened comes first: it is the one thing every entry has. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <WhenField value={value.when} time={value.time} onChange={(when, time) => set({ when, time })} />
        {/* Money is a thing some entries have, not a thing every entry has. The
            control appears when the entry already carries an amount, when the
            text looks like it mentions money, or when the template asks for one. */}
        {showAmount && <AmountPicker value={value.amount} onChange={(amount) => set({ amount })} />}
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
              if (template.fields?.includes("amount")) setAmountAsked(true);
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


/**
 * The date the event happened. Blank means today, which is what almost every
 * event is; logging something from last week is two clicks.
 */
/**
 * When it happened, in plain sight rather than behind a menu.
 *
 * It shows today, because today is what it nearly always is, and a date nobody
 * changed is never written into the file: the commit that saves the entry
 * already records it, to the second. Changing it is what makes GitRoll write a
 * date down — which is exactly when a date is worth writing down.
 */
export function WhenField({ value, time, onChange }: { value: string; time: string; onChange(when: string, time: string): void }) {
  const today = todayInput();
  const backdated = !!value && value !== today;
  return (
    <span
      className={cn(
        "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
        backdated ? "border-foreground/40 bg-accent font-medium text-foreground" : "border-border text-muted-foreground",
      )}
    >
      <CalendarClock className="size-3" aria-hidden="true" />
      <label>
        <span className="sr-only">When did this happen?</span>
        <span aria-hidden="true">When</span>{" "}
        <input
          type="date"
          aria-label="When did this happen?"
          value={value || today}
          max={todayInput(365)}
          onChange={(e) => {
            const when = e.target.value === today ? "" : e.target.value;
            // Going back to today drops the time with it: a moment nobody
            // chose is the commit's to record, not a half-filled form's.
            onChange(when, when ? time : "");
          }}
          className="bg-transparent text-xs outline-none focus-visible:underline"
        />
      </label>
      {/* A time only makes sense once the day isn't today; until then the commit has it to the second. */}
      {backdated && (
        <label>
          <span className="sr-only">At what time? Optional.</span>
          <span aria-hidden="true" className="text-muted-foreground">
            at
          </span>{" "}
          <input
            type="time"
            aria-label="At what time? Optional."
            value={time}
            onChange={(e) => onChange(value, e.target.value)}
            className="bg-transparent text-xs outline-none focus-visible:underline"
          />
        </label>
      )}
      {backdated && (
        <button
          type="button"
          onClick={() => onChange("", "")}
          className="rounded-full px-1 text-muted-foreground transition-colors hover:text-foreground"
          aria-label="Back to today"
        >
          ×
        </button>
      )}
    </span>
  );
}

/** Today as an <input type="date"> takes it, in the reader's own calendar. */
function todayInput(plusDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + plusDays);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
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
      // Tags written in the text are picked up when the file is read; these are
      // the ones that live only in the front matter.
      tags: value.extraTags,
      amount: parsed ?? undefined,
      // A day, or a day and a time — never a time on its own, and never a
      // midnight invented for a day somebody chose.
      date: value.when ? (value.time ? `${value.when}T${value.time}` : value.when) : undefined,
    },
  };
}

export function toChanges(value: ComposerValue, base: LoadedEntry): { changes: EntryChanges; error?: string } {
  const { input, error } = toInput(value);
  if (error) return { changes: {}, error };
  const changes: EntryChanges = {
    text: input.text,
    tags: value.extraTags,
    amount: input.amount ?? null,
  };
  // Only write a date when it differs from what the entry already says.
  const asked = value.when ? (value.time ? `${value.when}T${value.time}` : value.when) : "";
  const had = base.date ? (base.date.length > 10 ? `${toDateInput(base.date)}T${base.date.slice(11, 16)}` : toDateInput(base.date)) : "";
  if (asked !== had) changes.date = asked;
  return { changes };
}

export { emptyValue };
