// Reading a template file from a Roll.
//
// The YAML lives here rather than in core for the same reason the event parser's
// does not: core stays free of anything platform-shaped, and a template file is
// read exactly the way an event is — front matter split off, parsed, and the
// rest kept as written.

import { FormatError, splitFrontMatter } from "../core/entry.ts";
import { templateFrom } from "../core/templates.ts";
import type { EntryTemplate } from "../core/templates.ts";
import { slugify } from "../core/util.ts";
import { parseDocument } from "yaml";

/** Reads one `.gitroll/templates/*.md` file. Throws FormatError when its front matter won't parse. */
export function readTemplate(path: string, source: string): EntryTemplate {
  const { frontMatter, body } = splitFrontMatter(source);
  return templateFrom(path, metaOf(frontMatter), body, slugify);
}

function metaOf(frontMatter: string | null): Record<string, unknown> {
  if (frontMatter === null || !frontMatter.trim()) return {};
  const doc = parseDocument(frontMatter);
  if (doc.errors.length) throw new FormatError(`invalid YAML front matter: ${doc.errors[0].message}`);
  const data = doc.toJS({ maxAliasCount: 100 }) as unknown;
  if (data == null) return {};
  if (typeof data !== "object" || Array.isArray(data)) throw new FormatError("front matter must be a mapping, e.g. label: Rental inspection");
  return data as Record<string, unknown>;
}
