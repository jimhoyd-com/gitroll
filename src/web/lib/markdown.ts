/*
  Event bodies are Markdown. They always were, per SPEC.md, but the app used to
  render only paragraphs and links, so anything written in the CLI or on GitHub
  showed as literal asterisks here.

  Two rules govern this file:

  1. What goes on disk stays clean, human-readable Markdown. The editor never
     writes HTML into a body; embedded files are ordinary Markdown image and
     link syntax pointing at attachments/<hash>.
  2. Nothing rendered here is trusted. A Roll can be synced from another person
     or edited by hand, so the HTML is sanitized before it reaches the DOM, and
     raw HTML in the source is dropped rather than passed through.
*/

import DOMPurify from "dompurify";
import { Marked } from "marked";
import type { Tokens } from "marked";
import type { Attachment } from "../../core/entry.ts";

/** Written into a body to embed a stored file. Resolved to a real URL at render. */
export const ATTACHMENT_PREFIX = "attachments/";

export interface RenderContext {
  /** Resolves `attachments/<hash>` to a URL this browser can load. */
  attachmentUrl(hash: string): string | null;
  /** Used to give an embedded file a readable name when the body has none. */
  nameFor(hash: string): string | null;
}

const hashOf = (href: string): string | null => {
  if (!href.startsWith(ATTACHMENT_PREFIX)) return null;
  const rest = decodeURIComponent(href.slice(ATTACHMENT_PREFIX.length)).trim();
  return /^sha256:[0-9a-f]{64}$/i.test(rest) ? rest : null;
};

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
      const hash = ctx ? hashOf(href) : null;
      const url = hash && ctx ? ctx.attachmentUrl(hash) : null;
      if (hash) {
        if (!url) return `<p class="text-sm text-muted-foreground">Missing file: ${escape(text || hash)}</p>`;
        const alt = text || ctx?.nameFor(hash) || "";
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
      const hash = ctx ? hashOf(href) : null;
      if (hash && ctx) {
        const url = ctx.attachmentUrl(hash);
        if (!url) return `<span class="text-muted-foreground">${escape(text)}</span>`;
        const name = ctx.nameFor(hash) ?? text;
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

/** The Markdown that embeds an attachment in a body. */
export function embedFor(a: { hash: string; name: string; type: string }): string {
  const name = a.name.replace(/[[\]]/g, "");
  const ref = `${ATTACHMENT_PREFIX}${a.hash}`;
  return a.type.startsWith("image/") ? `![${name}](${ref})` : `[${name}](${ref})`;
}

/** The hashes a body embeds, so removing a file can warn about a broken link. */
export function embeddedHashes(body: string): Set<string> {
  const out = new Set<string>();
  for (const m of body.matchAll(/!?\[[^\]]*\]\((attachments\/sha256:[0-9a-f]{64})\)/gi)) {
    out.add(decodeURIComponent(m[1].slice(ATTACHMENT_PREFIX.length)));
  }
  return out;
}

export function contextFor(attachments: Attachment[], url: (a: Attachment) => string): RenderContext {
  const byHash = new Map(attachments.map((a) => [a.hash, a]));
  return {
    attachmentUrl: (hash) => {
      const a = byHash.get(hash);
      return a ? url(a) : null;
    },
    nameFor: (hash) => byHash.get(hash)?.name ?? null,
  };
}
