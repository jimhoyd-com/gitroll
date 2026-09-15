// The entry composer: every field of an event in one form, with autocomplete for
// projects and tags, and a draft that survives cancelling, switching screens and
// quitting. Pure model: the app feeds it keys and reads fields back.

import type { EntryChanges, EntryInput, LoadedEntry, Project } from "../../core/layout.ts";
import { normalizeData, typeFor, typeRegistry } from "../../core/types.ts";
import type { EventType } from "../../core/types.ts";
import { UserError, normalizeTimestamp, parseAmount, slugify } from "../../core/util.ts";
import { Input } from "./text.ts";
import type { Key } from "./text.ts";

export type ComposeMode = "new" | "edit" | "duplicate";

/** What the composer holds, as plain strings, so it can be written to disk and read back. */
export interface Draft {
  version: 1;
  mode: ComposeMode;
  /** The event being edited, for mode "edit". */
  id?: string;
  values: Record<string, string>;
  /** Attachments already on the event being edited, as `hash name` pairs. */
  attached?: { hash: string; name: string }[];
  updated: string;
}

export interface FieldSpec {
  key: string;
  label: string;
  kind: "multiline" | "line" | "type" | "list" | "files" | "choice" | "boolean";
  hint?: string;
  options?: string[];
}

export interface ComposerContext {
  types: EventType[];
  projects: Project[];
  /** Tags already used in the Roll, most used first. */
  tags: string[];
}

const DATA_PREFIX = "data:";
const listValues = (raw: string): string[] => raw.split(",").map((s) => s.trim().replace(/^#/, "")).filter(Boolean);

export class Composer {
  readonly ctx: ComposerContext;
  readonly mode: ComposeMode;
  readonly id?: string;
  /** Attachments the event already has (edit mode), minus any marked for removal. */
  attached: { hash: string; name: string }[];
  removed: string[] = [];
  index = 0;
  attachedIndex = 0;
  /** The autocomplete choice currently offered, if any. */
  suggestions: string[] = [];
  suggestion = 0;
  #inputs = new Map<string, Input>();
  #initial: string;

  constructor(ctx: ComposerContext, draft?: Draft) {
    this.ctx = ctx;
    this.mode = draft?.mode ?? "new";
    this.id = draft?.id;
    this.attached = draft?.attached ?? [];
    for (const [key, value] of Object.entries(draft?.values ?? {})) this.input(key).set(value);
    if (!draft) this.applyTypeDefaults(this.type());
    this.#initial = this.#signature();
  }

  static forEntry(ctx: ComposerContext, entry: LoadedEntry, mode: ComposeMode): Composer {
    const values: Record<string, string> = {
      text: entry.body,
      when: mode === "duplicate" ? "" : entry.occurred.slice(0, 16),
      kind: entry.type,
      amount: entry.amount ? `${entry.amount.value} ${entry.amount.currency}` : "",
      projects: entry.projects.join(", "),
      tags: entry.tags.join(", "),
    };
    for (const [key, value] of Object.entries(entry.data)) values[DATA_PREFIX + key] = String(value ?? "");
    return new Composer(ctx, {
      version: 1,
      mode,
      id: mode === "edit" ? entry.id : undefined,
      values,
      attached: mode === "edit" ? entry.attachments.map((a) => ({ hash: a.hash, name: a.name })) : [],
      updated: new Date().toISOString(),
    });
  }

  // ── Fields ────────────────────────────────────────────────────────────────

  fields(): FieldSpec[] {
    const type = this.type();
    const out: FieldSpec[] = [
      { key: "text", label: "What happened?", kind: "multiline", hint: "Enter adds a line · Ctrl+E opens your editor" },
      { key: "when", label: "When", kind: "line", hint: "Blank means now. 2026-09-15, or 2026-09-15T14:30" },
      { key: "kind", label: "Type", kind: "type", hint: "←→ choose" },
    ];
    if (type.amount !== "none") out.push({ key: "amount", label: "Amount", kind: "line", hint: '325, $1,850 or "99.50 EUR"' });
    out.push(
      { key: "projects", label: "Topics", kind: "list", hint: "Comma separated · Tab completes" },
      { key: "tags", label: "Tags", kind: "list", hint: "Comma separated · Tab completes" },
      { key: "files", label: "Photos or files", kind: "files", hint: "Drag files here, or paste paths" },
    );
    if (this.attached.length) {
      out.push({ key: "attached", label: "Files already attached", kind: "choice", hint: "←→ choose · Ctrl+X removes it from the event", options: this.attached.map((a) => a.name) });
    }
    for (const f of type.fields) {
      out.push({
        key: DATA_PREFIX + f.key,
        label: f.label,
        kind: f.kind === "longtext" ? "multiline" : f.kind === "select" ? "choice" : f.kind === "boolean" ? "boolean" : "line",
        options: f.options,
        hint: f.help ?? (f.kind === "date" ? "2026-09-15" : undefined),
      });
    }
    return out;
  }

  field(): FieldSpec {
    const fields = this.fields();
    this.index = Math.min(this.index, fields.length - 1);
    return fields[this.index];
  }

  input(key: string): Input {
    let input = this.#inputs.get(key);
    if (!input) {
      input = new Input("", key === "text" || key.startsWith(DATA_PREFIX));
      this.#inputs.set(key, input);
    }
    return input;
  }

  value(key: string): string {
    return this.#inputs.get(key)?.value ?? "";
  }

  type(): EventType {
    const registry = typeRegistry(this.ctx.types);
    return typeFor(registry, this.value("kind") || "log");
  }

  types(): EventType[] {
    const registry = typeRegistry(this.ctx.types);
    return [...registry.values()];
  }

  /** Prefills empty fields from a type's `defaults`. Plain data only; nothing is run. */
  applyTypeDefaults(type: EventType): void {
    const d = type.defaults;
    this.input("kind").set(type.id);
    if (!d) return;
    const fill = (key: string, value: string | undefined) => {
      if (value && !this.value(key).trim()) this.input(key).set(value);
    };
    fill("text", d.text);
    fill("projects", d.projects?.join(", "));
    fill("tags", d.tags?.join(", "));
    fill("amount", d.amount ? `${d.amount.value} ${d.amount.currency}` : undefined);
    for (const [key, value] of Object.entries(d.data ?? {})) fill(DATA_PREFIX + key, String(value));
  }

  // ── Keys ──────────────────────────────────────────────────────────────────

  /** Handles one key. Movement between fields and saving are the app's job. */
  key(k: Key): void {
    const field = this.field();
    const input = this.input(field.key);
    if (k.name === "tab" && this.suggestions.length) {
      this.accept();
      return;
    }
    if (this.suggestions.length && (k.name === "up" || k.name === "down")) {
      this.suggestion = (this.suggestion + (k.name === "down" ? 1 : this.suggestions.length - 1)) % this.suggestions.length;
      return;
    }
    if (field.kind === "type" && (k.name === "left" || k.name === "right")) {
      const types = this.types();
      const at = Math.max(0, types.findIndex((t) => t.id === this.type().id));
      const next = types[(at + (k.name === "right" ? 1 : types.length - 1) + types.length) % types.length];
      this.applyTypeDefaults(next);
      return;
    }
    if (field.kind === "boolean" && (k.name === "left" || k.name === "right" || k.ch === " ")) {
      input.set(input.value === "yes" ? "no" : "yes");
      return;
    }
    if (field.key === "attached") {
      if (k.name === "left" || k.name === "right") {
        const n = this.attached.length;
        this.attachedIndex = (this.attachedIndex + (k.name === "right" ? 1 : n - 1) + n) % n;
      }
      return;
    }
    if (field.kind === "choice" && (k.name === "left" || k.name === "right")) {
      const options = ["", ...(field.options ?? [])];
      const at = Math.max(0, options.indexOf(input.value));
      input.set(options[(at + (k.name === "right" ? 1 : options.length - 1)) % options.length]);
      return;
    }
    input.key(k);
    this.#suggest();
  }

  /** Accepts the offered completion. */
  accept(): void {
    const pick = this.suggestions[this.suggestion];
    if (!pick) return;
    const input = this.input(this.field().key);
    const parts = input.value.split(",");
    parts[parts.length - 1] = ` ${pick}`;
    input.set(`${parts.join(",").replace(/^\s+/, "")}, `);
    this.suggestions = [];
  }

  #suggest(): void {
    this.suggestions = [];
    this.suggestion = 0;
    const field = this.field();
    if (field.kind !== "list") return;
    const partial = this.input(field.key).value.split(",").pop()!.trim().replace(/^#/, "").toLowerCase();
    if (!partial) return;
    const chosen = new Set(listValues(this.input(field.key).value).map((v) => slugify(v)));
    const pool = field.key === "projects" ? this.ctx.projects.map((p) => p.slug) : this.ctx.tags;
    this.suggestions = pool.filter((v) => v.toLowerCase().startsWith(partial) && !chosen.has(slugify(v))).slice(0, 5);
  }

  // ── Saving ────────────────────────────────────────────────────────────────

  draft(): Draft {
    const values: Record<string, string> = {};
    for (const [key, input] of this.#inputs) if (input.value) values[key] = input.value;
    return { version: 1, mode: this.mode, id: this.id, values, attached: this.attached, updated: new Date().toISOString() };
  }

  /** True when there is anything worth keeping or warning about. */
  dirty(): boolean {
    return this.#signature() !== this.#initial;
  }

  empty(): boolean {
    return !this.value("text").trim() && !this.value("files").trim() && this.attached.length === 0;
  }

  #signature(): string {
    return JSON.stringify(this.draft().values);
  }

  #data(): Record<string, unknown> {
    const type = this.type();
    const raw: Record<string, unknown> = {};
    for (const [key, input] of this.#inputs) {
      if (!key.startsWith(DATA_PREFIX) || !input.value.trim()) continue;
      const field = type.fields.find((f) => f.key === key.slice(DATA_PREFIX.length));
      raw[key.slice(DATA_PREFIX.length)] = field?.kind === "boolean" ? input.value === "yes" : input.value.trim();
    }
    return normalizeData(type, raw);
  }

  #amount(): { value: number; currency: string } | null {
    const raw = this.value("amount").trim();
    if (!raw) return null;
    const amount = parseAmount(raw);
    if (!amount) throw new UserError(`"${raw}" isn't an amount. Try 325 or "$1,850".`);
    return amount;
  }

  #occurred(): string | undefined {
    const raw = this.value("when").trim();
    return raw ? normalizeTimestamp(raw) : undefined;
  }

  /** Forgets one of the attachments the event already has. It stays in Git history. */
  removeAttached(): string | null {
    const gone = this.attached[this.attachedIndex];
    if (!gone) return null;
    this.attached = this.attached.filter((a) => a.hash !== gone.hash);
    this.removed.push(gone.hash);
    this.attachedIndex = Math.max(0, Math.min(this.attachedIndex, this.attached.length - 1));
    return gone.name;
  }

  toInput(): EntryInput {
    const input: EntryInput = {
      text: this.value("text").trim(),
      type: this.type().id,
      projects: listValues(this.value("projects")),
      tags: listValues(this.value("tags")),
      data: this.#data(),
    };
    const occurred = this.#occurred();
    if (occurred) input.occurred = occurred;
    const amount = this.#amount();
    if (amount) input.amount = amount;
    return input;
  }

  toChanges(): EntryChanges {
    return {
      text: this.value("text").trim(),
      type: this.type().id,
      occurred: this.value("when").trim() ? this.#occurred() : "",
      projects: listValues(this.value("projects")),
      tags: listValues(this.value("tags")),
      amount: this.#amount(),
      data: this.#data(),
      removeAttachments: this.removed,
    };
  }
}
