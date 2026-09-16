/*
  Event bodies are Markdown. They always were, per SPEC.md, but the app used to
  render only paragraphs and links, so anything written in the CLI or on GitHub
  showed as literal asterisks here.

  Two rules govern this file:

  1. What goes on disk stays clean, human-readable Markdown. The editor never
     writes HTML into a body; files are ordinary Markdown image and link
     syntax pointing at a path such as ../files/ac-receipt.pdf.
  2. Nothing rendered here is trusted. A Roll can be synced from another person
     or edited by hand, so the HTML is sanitized before it reaches the DOM, and
     raw HTML in the source is dropped rather than passed through.
*/

import DOMPurify from "dompurify";
import { Marked } from "marked";
import type { Tokens } from "marked";
import { linkedFiles, relativeLink, resolveLink } from "../../core/entry.ts";
import type { Attachment } from "../../core/entry.ts";

export interface RenderContext {
  /** Turns a link in the event's Markdown into a repository path, or null when it isn't one. */
  resolve(target: string): string | null;
  /** A URL this browser can load for a repository path. */
  attachmentUrl(path: string): string | null;
  /** A readable name for a repository path, when the link text has none. */
  nameFor(path: string): string | null;
}

// One parser for the whole app. The renderer needs the event's attachments, and
// parsing is synchronous, so the context is set immediately before each parse.
let active: RenderContext | null = null;

const marked = new Marked({
  gfm: true,
  breaks: true, // People write logbook entries with single newlines and mean them.
});

marked.use({
  renderer: {
    image({ href, title, text }: Tokens.Image): string | false {
      const ctx = active;
      const target = ctx ? ctx.resolve(href) : null;
      const url = target && ctx ? ctx.attachmentUrl(target) : null;
      if (target) {
        if (!url) return `<p class="text-sm text-muted-foreground">Missing file: ${escape(text || target)}</p>`;
        const alt = text || ctx?.nameFor(target) || "";
        return `<img src="${escape(url)}" alt="${escape(alt)}" loading="lazy"${title ? ` title="${escape(title)}"` : ""}>`;
      }
      // Only same-origin images load at all under the app's security policy, so
      // a remote image would silently break. Show it as a link instead.
      if (/^https?:/i.test(href)) {
        return `<a href="${escape(href)}" target="_blank" rel="noopener noreferrer">${escape(text || href)}</a>`;
      }
      return false;
    },
    link({ href, title, text }: Tokens.Link): string | false {
      const ctx = active;
      const target = ctx ? ctx.resolve(href) : null;
      if (target && ctx) {
        const url = ctx.attachmentUrl(target);
        if (!url) return `<span class="text-muted-foreground">${escape(text)}</span>`;
        const name = ctx.nameFor(target) ?? text;
        return `<a href="${escape(url)}" download="${escape(name)}">${escape(text || name)}</a>`;
      }
      if (!/^https?:|^#/i.test(href)) return escape(text);
      const external = /^https?:/i.test(href);
      return `<a href="${escape(href)}"${external ? ` target="_blank" rel="noopener noreferrer"` : ""}${
        title ? ` title="${escape(title)}"` : ""
      }>${escape(text)}</a>`;
    },
  },
});

function escape(s: string): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Turns `#tag` into a search link, but only in ordinary text: never inside a
 * code span, a heading anchor, or a URL that happens to contain a fragment.
 */
function linkTags(html: string): string {
  return html.replace(/(^|[\s(>])#(\p{L}[\p{L}\p{N}_-]*)/gu, (_match, pre: string, tag: string) => {
    // Sitting directly after ">" means start-of-text; anything else inside a tag
    // or an attribute has already been escaped by the renderer.
    return `${pre}<a class="tag" href="#/?q=${encodeURIComponent(`tag:${tag.toLowerCase()}`)}" data-tag="${escape(tag.toLowerCase())}">#${escape(tag)}</a>`;
  });
}

const ALLOWED_TAGS = [
  "p", "br", "hr", "strong", "em", "del", "s", "code", "pre", "blockquote",
  "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "a", "img",
  "table", "thead", "tbody", "tr", "th", "td", "input", "span", "sup", "sub",
];

/** Markdown to sanitized HTML. Safe to place in dangerouslySetInnerHTML. */
export function renderMarkdown(source: string, ctx: RenderContext): string {
  if (!source.trim()) return "";
  active = ctx;
  let raw: string;
  try {
    raw = marked.parse(source.trim(), { async: false }) as string;
  } finally {
    active = null;
  }
  return DOMPurify.sanitize(linkTags(raw), {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ["href", "src", "alt", "title", "class", "loading", "download", "target", "rel", "type", "checked", "disabled", "data-tag", "colspan", "rowspan"],
    // A Roll is data, not a document that gets to define its own behaviour.
    FORBID_TAGS: ["style", "script", "iframe", "form", "object", "embed"],
    FORBID_ATTR: ["style", "srcset", "formaction", "onerror", "onload"],
    ALLOW_DATA_ATTR: false,
  });
}

/** Plain text for search snippets and the AI answer panel. */
export function markdownToText(source: string): string {
  return source
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_`>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The Markdown that links a file from an event at `from`. */
export function embedFor(a: Attachment, from: string): string {
  const name = a.name.replace(/[[\]]/g, "");
  const ref = relativeLink(from, a.path);
  return a.image || a.type.startsWith("image/") ? `![${name}](${ref})` : `[${name}](${ref})`;
}

/** Everything the body already links to, so the app never offers to link it twice. */
export function linkedPaths(body: string, from: string): Set<string> {
  return new Set(linkedFiles(from, body).map((a) => a.path));
}

/** Rendering context for one event: its own path decides what its relative links mean. */
export function contextFor(entry: { path: string; attachments: Attachment[] }, url: (path: string) => string): RenderContext {
  const byPath = new Map(entry.attachments.map((a) => [a.path, a]));
  return {
    resolve: (target) => resolveLink(entry.path, target),
    attachmentUrl: (path) => url(path),
    nameFor: (path) => byPath.get(path)?.name ?? path.split("/").pop() ?? null,
  };
}
