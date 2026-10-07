// Sealed content: the parts of a Roll that are encrypted with age.
//
//   A sealed block is a fenced code block whose info string is `sealed`,
//   holding an armored age file:
//
//     ```sealed
//     -----BEGIN AGE ENCRYPTED FILE-----
//     …
//     -----END AGE ENCRYPTED FILE-----
//     ```
//
//   A sealed field is a front matter value that is an armored age file, written
//   as a YAML literal block scalar (`pin: |`). Its plaintext is the value as
//   YAML, so unsealing gives back the same type.
//
//   A sealed file is a file under .gitroll/files/ whose name ends in `.age`: a
//   binary age file whose plaintext is the file without that suffix.
//
// This module only finds and rewrites those parts of the text. Encrypting and
// decrypting is done by ./age/, with the platform's crypto.

import { isMap, isScalar, parse, parseDocument, stringify } from "yaml";
import type { Node, Scalar, YAMLMap, YAMLSeq } from "yaml";
import { FormatError, splitFrontMatter } from "./entry.ts";
import { ARMOR_BEGIN, ARMOR_END, isRecipient } from "./age/format.ts";

export const SEALED_INFO = "sealed";
export const SEALED_SUFFIX = ".age";
/** What a reader without a key shows in place of a sealed block or field. */
export const SEALED_PLACEHOLDER = "[sealed]";

export interface SealedBlock {
  /** 1-based line numbers of the opening and closing fence, in the text given. */
  start: number;
  end: number;
  /** The armored age file inside the fence. */
  armor: string;
}

/** A sealed part, as a reader reports it: `{sealed: true}` plus where it is. */
export interface SealedPart {
  sealed: true;
  kind: "block" | "field" | "file";
  /** For a block: its fence lines in the file, e.g. "7-12". */
  lines?: string;
  /** For a field: its front matter key. */
  field?: string;
  /** For a file: its path, ending in .age. */
  file?: string;
  /** Present only when it was unsealed for display. */
  text?: string;
}

const OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*sealed[ \t]*$/;

/** Every sealed block in some Markdown text, in order. A fence that never closes isn't one. */
export function sealedBlocks(text: string, firstLine = 1): SealedBlock[] {
  const lines = text.split("\n");
  const out: SealedBlock[] = [];
  let fence: string | null = null;
  let open = -1;
  let other: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "");
    if (fence !== null) {
      const close = new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \\t]*$`);
      if (close.test(line)) {
        out.push({ start: open + firstLine, end: i + firstLine, armor: lines.slice(open + 1, i).map((l) => l.replace(/\r$/, "").trim()).join("\n") });
        fence = null;
      }
      continue;
    }
    if (other !== null) {
      // Inside some other fenced block: a ```sealed in an example isn't sealed.
      if (new RegExp(`^ {0,3}${other[0] === "`" ? "`" : "~"}{${other.length},}[ \\t]*$`).test(line)) other = null;
      continue;
    }
    const m = OPEN.exec(line);
    if (m) {
      fence = m[1];
      open = i;
      continue;
    }
    const plain = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (plain) other = plain[1];
  }
  return out;
}

/** The fenced block that holds armored text. */
export function sealedFence(armored: string): string {
  return `\`\`\`${SEALED_INFO}\n${armored.trim()}\n\`\`\``;
}

/** Text with each sealed block replaced, e.g. by a placeholder or by its plaintext. */
export function replaceSealedBlocks(text: string, replace: (block: SealedBlock, index: number) => string): string {
  const blocks = sealedBlocks(text);
  if (!blocks.length) return text;
  const lines = text.split("\n");
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    lines.splice(b.start - 1, b.end - b.start + 1, replace(b, i));
  }
  return lines.join("\n");
}

/** Text with every sealed block taken out: what search and the secret scanner read. */
export const withoutSealed = (text: string): string => replaceSealedBlocks(text, () => "");

/** True for a value that is an armored age file: a sealed field. */
export function isSealedValue(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const t = value.trim();
  return t.startsWith(ARMOR_BEGIN) && t.endsWith(ARMOR_END);
}

/** The front matter keys whose values are sealed. */
export const sealedFields = (meta: Record<string, unknown>): string[] => Object.keys(meta).filter((k) => isSealedValue(meta[k]));

/** Where an entry's sealed parts are. Pass the whole file as `source` for line numbers in the file. */
export function sealedParts(entry: { meta: Record<string, unknown>; body: string }, source?: string): SealedPart[] {
  const blocks = source === undefined ? sealedBlocks(entry.body) : sealedBlocks(source);
  return [
    ...sealedFields(entry.meta).map((field): SealedPart => ({ sealed: true, kind: "field", field })),
    ...blocks.map((b): SealedPart => ({ sealed: true, kind: "block", lines: `${b.start}-${b.end}` })),
  ];
}

// ── Lines ──────────────────────────────────────────────────────────────────

/** The 1-based line the body starts on (after any front matter). */
export function bodyStartLine(source: string): number {
  const { frontMatter, body } = splitFrontMatter(source);
  if (frontMatter === null) return 1;
  const head = source.replace(/^﻿/, "").slice(0, source.replace(/^﻿/, "").length - body.length);
  return head.split("\n").length;
}

/** Parses "a-b" (or "a") into a line range. */
export function parseLineRange(text: string): { start: number; end: number } | null {
  const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(text);
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] === undefined ? start : Number(m[2]);
  return start >= 1 && end >= start ? { start, end } : null;
}

/**
 * The plaintext of lines `start`–`end` of a file, checked: inside the body,
 * not blank, and not overlapping a fenced block (sealed or not).
 */
export function linesToSeal(source: string, start: number, end: number): string {
  const lines = source.split("\n");
  const first = bodyStartLine(source);
  if (start < first) throw new FormatError(`line ${start} is in the front matter; seal a field with --field <key> instead`);
  const count = lines.length - (lines[lines.length - 1] === "" ? 1 : 0);
  if (end > count) throw new FormatError(`the file has only ${count} lines`);
  for (const b of sealedBlocks(source)) {
    if (start <= b.end && end >= b.start) throw new FormatError(`lines ${start}-${end} overlap a sealed block (lines ${b.start}-${b.end})`);
  }
  const text = lines.slice(start - 1, end).join("\n");
  if (!text.trim()) throw new FormatError(`lines ${start}-${end} are blank; there is nothing to seal`);
  // Cutting a code block in half would leave the rest of the file inside it.
  const fences = text.split("\n").filter((l) => /^ {0,3}(`{3,}|~{3,})/.test(l)).length;
  if (fences % 2) throw new FormatError(`lines ${start}-${end} cut a fenced code block in half; include the whole block`);
  return text;
}

/** Replaces lines `start`–`end` (1-based, inclusive) with new text. */
export function replaceLines(source: string, start: number, end: number, text: string): string {
  const lines = source.split("\n");
  lines.splice(start - 1, end - start + 1, ...text.split("\n"));
  return lines.join("\n");
}

/**
 * The body of a document without its first heading: what `seal` with no
 * --lines seals, so the title stays readable. Returns the range in file lines.
 */
export function wholeBodyRange(source: string): { start: number; end: number } | null {
  const lines = source.split("\n");
  let start = bodyStartLine(source);
  while (start <= lines.length && !lines[start - 1].trim()) start++;
  if (start <= lines.length && /^#{1,6}\s/.test(lines[start - 1])) start++;
  while (start <= lines.length && !lines[start - 1].trim()) start++;
  let end = lines.length;
  while (end >= start && !lines[end - 1].trim()) end--;
  return end >= start ? { start, end } : null;
}

// ── Fields ─────────────────────────────────────────────────────────────────

function frontMatterMap(source: string) {
  const { frontMatter, body } = splitFrontMatter(source);
  if (frontMatter === null) throw new FormatError("there is no front matter");
  const doc = parseDocument(frontMatter);
  if (doc.errors.length) throw new FormatError(`invalid YAML front matter: ${doc.errors[0].message}`);
  if (!isMap(doc.contents)) throw new FormatError("front matter must be a mapping");
  const map = doc.contents as YAMLMap<unknown, unknown>;
  const key = (name: string) => map.items.map((p) => p.key).find((n): n is Scalar => isScalar(n) && String(n.value) === name);
  const write = () => `---\n${doc.toString({ lineWidth: 0 }).trimEnd()}\n---\n${body}`;
  return { doc, map, key, write };
}

/** The YAML text of a field's value: the plaintext a sealed field holds. */
export function fieldPlaintext(source: string, name: string): string {
  const { map, key } = frontMatterMap(source);
  const k = key(name);
  if (!k) throw new FormatError(`there's no field called ${name}`);
  const value = (map.get(k, true) as Node | undefined)?.toJSON();
  if (isSealedValue(value)) throw new FormatError(`${name} is already sealed`);
  if (value === null || value === undefined || value === "") throw new FormatError(`${name} is empty; there is nothing to seal`);
  return stringify(value, { lineWidth: 0 }).replace(/\n$/, "");
}

/** Sets a field to armored text, written as a literal block scalar. Comments beside the old value are kept. */
export function setSealedField(source: string, name: string, armored: string): string {
  const { doc, map, key, write } = frontMatterMap(source);
  const k = key(name);
  if (!k) throw new FormatError(`there's no field called ${name}`);
  const node = doc.createNode(`${armored.trim()}\n`) as Scalar;
  node.type = "BLOCK_LITERAL";
  const old = map.get(k, true) as Node | undefined;
  if (old && isScalar(old)) node.comment = old.comment;
  map.set(k, node);
  return write();
}

/** Puts a field's plaintext (YAML) back as its value. */
export function setUnsealedField(source: string, name: string, plaintext: string): string {
  const { doc, map, key, write } = frontMatterMap(source);
  const k = key(name);
  if (!k) throw new FormatError(`there's no field called ${name}`);
  const node = doc.createNode(parse(plaintext)) as Node;
  const old = map.get(k, true) as Node | undefined;
  if (old && isScalar(old) && isScalar(node) && old.comment) node.comment = old.comment;
  map.set(k, node);
  return write();
}

// ── Recipients in config.yaml ──────────────────────────────────────────────

export interface RollRecipient {
  recipient: string;
  /** The comment written beside it, e.g. `- age1… # laptop`. */
  label?: string;
}

/** The Roll's recipients: `recipients:` in .gitroll/config.yaml, one age1… per item. */
export function recipientsFromConfig(text: string): RollRecipient[] {
  const doc = parseDocument(text);
  const seq = doc.get("recipients", true) as YAMLSeq | undefined;
  if (!seq || !Array.isArray((seq as { items?: unknown[] }).items)) return [];
  return seq.items.flatMap((item): RollRecipient[] => {
    if (!isScalar(item) || typeof item.value !== "string") return [];
    const label = item.comment?.trim();
    return [{ recipient: item.value.trim(), ...(label ? { label } : {}) }];
  });
}

/** config.yaml with a recipient added (labelled with a comment). Everything else is kept as written. */
export function addRecipientToConfig(text: string, recipient: string, label?: string): string {
  if (!isRecipient(recipient)) throw new FormatError(`not an age recipient: ${recipient} (one looks like age1…)`);
  const doc = parseDocument(text);
  if (doc.errors.length) throw new FormatError(`config.yaml isn't valid YAML: ${doc.errors[0].message}`);
  const node = doc.createNode(recipient) as Scalar;
  const clean = label?.replace(/[\r\n#]+/g, " ").trim();
  if (clean) node.comment = ` ${clean}`;
  const seq = doc.get("recipients", true) as YAMLSeq | undefined;
  if (seq && Array.isArray((seq as { items?: unknown[] }).items)) {
    seq.flow = false;
    seq.items.push(node);
  } else {
    const list = doc.createNode([]) as YAMLSeq;
    list.items.push(node);
    doc.set("recipients", list);
  }
  return doc.toString({ lineWidth: 0 });
}

/** config.yaml without the recipients matching `which` (the key itself, or its label). */
export function removeRecipientFromConfig(text: string, which: string): { text: string; removed: string[] } {
  const doc = parseDocument(text);
  const seq = doc.get("recipients", true) as YAMLSeq | undefined;
  if (!seq || !Array.isArray((seq as { items?: unknown[] }).items)) return { text, removed: [] };
  const removed: string[] = [];
  seq.items = seq.items.filter((item) => {
    if (!isScalar(item)) return true;
    const hit = String(item.value).trim() === which.trim() || (!!item.comment && item.comment.trim().toLowerCase() === which.trim().toLowerCase());
    if (hit) removed.push(String(item.value));
    return !hit;
  });
  if (!seq.items.length) doc.delete("recipients");
  return { text: doc.toString({ lineWidth: 0 }), removed };
}
