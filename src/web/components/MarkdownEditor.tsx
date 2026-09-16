import { Bold, Image as ImageIcon, Italic, Link2, List, ListChecks, Quote } from "lucide-react";
import { useCallback, useImperativeHandle, useLayoutEffect, useRef } from "react";
import type * as React from "react";
import { contextFor, renderMarkdown } from "../lib/markdown.ts";
import type { Attachment } from "../../core/entry.ts";
import { cn } from "../lib/utils.ts";
import { Button } from "./ui/button.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger, Tooltip } from "./ui/misc.tsx";

/*
  A Markdown editor, not a rich text editor.

  What lands on disk has to stay Markdown a person can read in a text editor or
  on GitHub — that is the promise the format makes. A WYSIWYG surface would put
  HTML and stray whitespace into the file, so instead this gives the things
  people actually want from one: a toolbar, the usual keyboard shortcuts, a
  preview, and photos and files that drop straight into the text.
*/

export interface EditorHandle {
  /** Inserts text at the caret, used when a file is attached. */
  insert(text: string): void;
  focus(): void;
}

export interface MarkdownEditorProps {
  value: string;
  onChange(value: string): void;
  onFiles(files: File[]): void;
  attachments: Attachment[];
  /** The event's path, so its relative links resolve the way they will on disk. */
  path?: string;
  attachmentUrl(a: Attachment): string;
  placeholder?: string;
  /** How tall the box starts: the smallest thing worth writing. */
  rows?: number;
  /** How tall it is allowed to grow before it scrolls instead. */
  maxRows?: number;
  label: string;
  describedBy?: string;
  handle?: React.RefObject<EditorHandle | null>;
  autoFocus?: boolean;
  onSubmit?(): void;
}

export function MarkdownEditor({
  value,
  onChange,
  onFiles,
  attachments,
  path = "events/new.md",
  attachmentUrl,
  placeholder,
  rows = 3,
  maxRows = 14,
  label,
  describedBy,
  handle,
  autoFocus,
  onSubmit,
}: MarkdownEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  /*
    The box is as tall as what is in it.

    A composer that starts tall pushes the timeline off the screen to make room
    for a paragraph most entries never have; one that stays short makes writing
    a long entry feel like writing into a slot. So it starts at the height of
    the shortest thing worth logging and grows as the text does, up to a point,
    after which it scrolls rather than swallowing the page.
  */
  const fit = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const style = getComputedStyle(el);
    const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5;
    const frame =
      parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    const max = line * maxRows + frame;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [maxRows]);

  // Before paint, so the box never appears at one height and jumps to another.
  useLayoutEffect(fit, [fit, value]);

  useImperativeHandle(handle, () => ({
    insert: (text: string) => surround("", "", text),
    focus: () => ref.current?.focus(),
  }));

  /** Wraps the selection, or inserts a placeholder when nothing is selected. */
  function surround(before: string, after: string, replacement?: string) {
    const el = ref.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const selected = value.slice(start, end);
    const body = replacement ?? selected;
    const next = `${value.slice(0, start)}${before}${body}${after}${value.slice(end)}`;
    onChange(next);
    const caret = start + before.length + body.length + after.length;
    requestAnimationFrame(() => {
      el.focus();
      // With nothing selected, land inside the marks so typing continues there.
      if (!selected && !replacement) el.setSelectionRange(start + before.length, start + before.length);
      else el.setSelectionRange(caret, caret);
    });
  }

  /** Puts a prefix on every line the selection touches, for lists and quotes. */
  function prefixLines(prefix: string) {
    const el = ref.current;
    if (!el) return;
    const start = value.lastIndexOf("\n", el.selectionStart - 1) + 1;
    const endOfLine = value.indexOf("\n", el.selectionEnd);
    const end = endOfLine === -1 ? value.length : endOfLine;
    const block = value.slice(start, end);
    const allPrefixed = block.split("\n").every((l) => l.startsWith(prefix));
    const next = block
      .split("\n")
      .map((l) => (allPrefixed ? l.slice(prefix.length) : `${prefix}${l}`))
      .join("\n");
    onChange(`${value.slice(0, start)}${next}${value.slice(end)}`);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start, start + next.length);
    });
  }

  const tools = [
    { icon: Bold, label: "Bold", keys: "Ctrl+B", run: () => surround("**", "**") },
    { icon: Italic, label: "Italic", keys: "Ctrl+I", run: () => surround("_", "_") },
    { icon: Link2, label: "Link", keys: "Ctrl+K", run: () => surround("[", "](https://)") },
    { icon: List, label: "Bulleted list", run: () => prefixLines("- ") },
    { icon: ListChecks, label: "Checklist", run: () => prefixLines("- [ ] ") },
    { icon: Quote, label: "Quote", run: () => prefixLines("> ") },
  ];

  return (
    <Tabs defaultValue="write" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1">
        {tools.map((t) => (
          <Tooltip key={t.label} label={t.keys ? `${t.label} (${t.keys})` : t.label}>
            <Button variant="ghost" size="iconSm" onClick={t.run} tabIndex={-1}>
              <t.icon aria-hidden="true" />
              <span className="sr-only">{t.label}</span>
            </Button>
          </Tooltip>
        ))}
        <Tooltip label="Add a photo or file">
          <Button variant="ghost" size="iconSm" onClick={() => fileRef.current?.click()} tabIndex={-1}>
            <ImageIcon aria-hidden="true" />
            <span className="sr-only">Add a photo or file</span>
          </Button>
        </Tooltip>

        <TabsList className="ml-auto">
          <TabsTrigger value="write">Write</TabsTrigger>
          <TabsTrigger value="preview">Preview</TabsTrigger>
        </TabsList>
      </div>

      <input
        ref={fileRef}
        type="file"
        multiple
        className="sr-only"
        aria-label="Add photos or files"
        onChange={(ev) => {
          onFiles([...(ev.target.files ?? [])]);
          ev.target.value = "";
        }}
      />

      <TabsContent value="write">
        <textarea
          ref={ref}
          rows={rows}
          value={value}
          autoFocus={autoFocus}
          aria-label={label}
          aria-describedby={describedBy}
          placeholder={placeholder}
          onChange={(ev) => onChange(ev.target.value)}
          onPaste={(ev) => {
            const files = [...(ev.clipboardData?.files ?? [])];
            if (files.length) {
              ev.preventDefault();
              onFiles(files);
            }
          }}
          onDragOver={(ev) => ev.preventDefault()}
          onDrop={(ev) => {
            const files = [...(ev.dataTransfer?.files ?? [])];
            if (files.length) {
              ev.preventDefault();
              onFiles(files);
            }
          }}
          onKeyDown={(ev) => {
            const mod = ev.metaKey || ev.ctrlKey;
            if (!mod) return;
            const key = ev.key.toLowerCase();
            if (key === "b") {
              ev.preventDefault();
              surround("**", "**");
            } else if (key === "i") {
              ev.preventDefault();
              surround("_", "_");
            } else if (key === "k") {
              ev.preventDefault();
              surround("[", "](https://)");
            } else if (ev.key === "Enter" && onSubmit) {
              ev.preventDefault();
              onSubmit();
            }
          }}
          className={cn(
            // It sizes itself to the text, so there is nothing to drag for.
            "w-full resize-none rounded-md border border-input bg-card px-3 py-2 text-sm shadow-sm",
            "placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
            "max-sm:text-base",
          )}
        />
      </TabsContent>

      <TabsContent value="preview">
        <div className="min-h-24 rounded-md border border-border bg-card px-3 py-2">
          {value.trim() ? (
            <div
              className="prose-roll"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(value, contextFor({ path, attachments }, (target) => attachmentUrl({ path: target, name: target, type: "", image: false }))) }}
            />
          ) : (
            <p className="text-sm text-muted-foreground">Nothing to preview yet.</p>
          )}
        </div>
      </TabsContent>
    </Tabs>
  );
}
