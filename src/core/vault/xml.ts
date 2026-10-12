// A small, strict XML reader and writer for KeePass's database XML: elements,
// attributes, text, CDATA, comments and the five predefined entities. No
// DOCTYPE, no entity declarations, no external anything: a document that has
// one is refused, so nothing in an imported file can make this read another
// file or expand without bound.

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  /** The element's own text, concatenated (KeePass never mixes text and elements). */
  text: string;
}

export class XmlError extends Error {}

const LIMITS = { depth: 256, elements: 2_000_000, bytes: 512 * 1024 * 1024 };
const NAME = /^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/;
const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  if (/&(?!(?:lt|gt|amp|quot|apos|#[0-9]{1,7}|#x[0-9A-Fa-f]{1,6});)/.test(s)) throw new XmlError("An unknown entity or a bare & in text");
  return s.replace(/&(lt|gt|amp|quot|apos|#[0-9]{1,7}|#x[0-9A-Fa-f]{1,6});/g, (_, e: string) => {
    if (e in ENTITIES) return ENTITIES[e];
    const n = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    if (n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff) || n === 0) throw new XmlError("A character reference out of range");
    return String.fromCodePoint(n);
  });
}

/** Parses a whole document and returns its root element. */
export function parseXml(text: string): XmlElement {
  if (text.length > LIMITS.bytes) throw new XmlError("The document is too large.");
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;
  let count = 0;
  const fail = (what: string): never => {
    throw new XmlError(`${what} (at character ${i})`);
  };
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    const chunk = text.slice(i, lt < 0 ? text.length : lt);
    if (chunk) {
      if (stack.length) stack[stack.length - 1].text += decodeEntities(chunk);
      else if (chunk.trim()) fail("Text outside the root element");
    }
    if (lt < 0) break;
    i = lt;
    if (text.startsWith("<!--", i)) {
      const end = text.indexOf("-->", i + 4);
      if (end < 0) fail("An unterminated comment");
      i = end + 3;
    } else if (text.startsWith("<![CDATA[", i)) {
      const end = text.indexOf("]]>", i + 9);
      if (end < 0 || !stack.length) fail("A misplaced CDATA section");
      stack[stack.length - 1].text += text.slice(i + 9, end);
      i = end + 3;
    } else if (text.startsWith("<?", i)) {
      const end = text.indexOf("?>", i + 2);
      if (end < 0 || !/^<\?xml[\s?]/.test(text.slice(i, i + 6)) || root || stack.length) fail("A processing instruction");
      i = end + 2;
    } else if (text.startsWith("<!", i)) {
      fail("A DOCTYPE or declaration, which imported files may not contain");
    } else if (text.startsWith("</", i)) {
      const end = text.indexOf(">", i);
      if (end < 0) fail("An unterminated end tag");
      const name = text.slice(i + 2, end).trim();
      const open = stack.pop();
      if (!open || open.name !== name) fail(`A mismatched end tag </${name.slice(0, 40)}>`);
      i = end + 1;
    } else {
      // A start tag: find its end outside quoted attribute values.
      let j = i + 1;
      let quote = "";
      for (; j < text.length; j++) {
        const c = text[j];
        if (quote) {
          if (c === quote) quote = "";
        } else if (c === '"' || c === "'") quote = c;
        else if (c === ">") break;
      }
      if (j >= text.length) fail("An unterminated start tag");
      let body = text.slice(i + 1, j);
      const selfClosing = body.endsWith("/");
      if (selfClosing) body = body.slice(0, -1);
      const m = /^([^\s/>]+)([\s\S]*)$/.exec(body);
      if (!m || !NAME.test(m[1])) fail("A malformed start tag");
      const attrs: Record<string, string> = {};
      const re = /\s+([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
      let rest = m![2];
      let k = 0;
      for (;;) {
        re.lastIndex = k;
        const a = re.exec(rest);
        if (!a) break;
        if (!NAME.test(a[1]) || a[1] in attrs) fail("A malformed or repeated attribute");
        attrs[a[1]] = decodeEntities(a[2] ?? a[3]);
        k = re.lastIndex;
      }
      if (rest.slice(k).trim()) fail("A malformed attribute");
      const el: XmlElement = { name: m![1], attrs, children: [], text: "" };
      if (++count > LIMITS.elements) fail("Too many elements");
      if (stack.length) stack[stack.length - 1].children.push(el);
      else if (root) fail("A second root element");
      else root = el;
      if (!selfClosing) {
        stack.push(el);
        if (stack.length > LIMITS.depth) fail("Elements nested too deeply");
      }
      i = j + 1;
    }
  }
  if (!root || stack.length) throw new XmlError("The document is incomplete.");
  return root;
}

/** The first child element with that name, if any. */
export const child = (el: XmlElement | undefined, name: string): XmlElement | undefined => el?.children.find((c) => c.name === name);
/** Every child element with that name. */
export const children = (el: XmlElement | undefined, name: string): XmlElement[] => el?.children.filter((c) => c.name === name) ?? [];

export function escapeXml(s: string): string {
  // Characters XML 1.0 can't carry at all are dropped rather than written.
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
