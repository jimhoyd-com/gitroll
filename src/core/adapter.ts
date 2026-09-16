// Adapters turn something that happened elsewhere into GitRoll event drafts.
//
//   external payload ──adapter.toEvents()──▶ EventDraft[] ──store──▶ Markdown/YAML ──▶ Git
//
// An adapter is a pure function: it doesn't touch Git, the network or the
// filesystem, and it owns no data. Every draft carries a `source` whose
// adapter + id is unique, so running the same input twice creates nothing new.

import type { Entry, Source } from "./entry.ts";
import type { EntryInput } from "./layout.ts";
import { UserError } from "./util.ts";

/** Identity of an imported event: the same adapter and id is the same event. */
export const sourceKey = (s: Source) => `${s.adapter}\u0000${s.id}`;

export interface DraftFile {
  name: string;
  type?: string;
  data: Uint8Array;
}

export interface EventDraft extends EntryInput {
  source: Source;
  files?: DraftFile[];
}

export interface AdapterContext {
  /** Free-form options, e.g. from CLI flags: { event: "release", project: "website" } */
  options: Record<string, string | undefined>;
}

export interface Adapter {
  /** Stable id recorded in source.adapter, e.g. "github". */
  id: string;
  label: string;
  description: string;
  toEvents(input: unknown, ctx: AdapterContext): EventDraft[];
}

export class AdapterError extends UserError {}

/** Splits drafts into ones to create and ones already in the log. */
export function planIngest(existing: Entry[], drafts: EventDraft[]): { create: EventDraft[]; skip: EventDraft[] } {
  const seen = new Set(existing.flatMap((e) => (e.source ? [sourceKey(e.source)] : [])));
  const create: EventDraft[] = [];
  const skip: EventDraft[] = [];
  for (const d of drafts) {
    const key = sourceKey(d.source);
    if (seen.has(key)) skip.push(d);
    else {
      seen.add(key);
      create.push(d);
    }
  }
  return { create, skip };
}

/** Applies options every adapter should honour: extra projects and tags. */
export function withDefaults(drafts: EventDraft[], ctx: AdapterContext): EventDraft[] {
  const projects = ctx.options.project?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  const tags = ctx.options.tag?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  return drafts.map((d) => ({ ...d, projects: [...(d.projects ?? []), ...projects], tags: [...(d.tags ?? []), ...tags] }));
}
