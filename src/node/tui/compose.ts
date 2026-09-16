// The entry composer: every field of an event in one form, with autocomplete for
// projects and tags, and a draft that survives cancelling, switching screens and
// quitting. Pure model: the app feeds it keys and reads fields back.

import type { EntryChanges, EntryInput, LoadedEntry } from "../../core/layout.ts";
import { UserError, formatAmount, parseAmount, slugify } from "../../core/util.ts";
import { Input } from "./text.ts";
import type { Key } from "./text.ts";

export type ComposeMode = "new" | "edit" | "duplicate";

/** What the composer holds, as plain strings, so it can be written to disk and read back. */
export interface Draft {
  version: 1;
  mode: ComposeMode;
  /** The event being edited (its path), for mode "edit". */
  id?: string;
  values: Record<string, string>;
  updated: string;
}

export interface FieldSpec {
  key: string;
  label: string;
  kind: "multiline" | "line" | "list" | "files";
  hint?: string;
  options?: string[];
}

export interface ComposerContext {
  /** Projects already used in the Roll. They need no definition anywhere. */
  projects: string[];
  /** Tags already used in the Roll, most used first. */
  tags: string[];
}

const listValues = (raw: string): string[] => raw.split(",").map((s) => s.trim().replace(/^#/, "")).filter(Boolean);

export class Composer {
  readonly ctx: ComposerContext;
  readonly mode: ComposeMode;
  readonly id?: string;
  index = 0;
  /** The autocomplete choice currently offered, if any. */
  suggestions: string[] = [];
  suggestion = 0;
  #inputs = new Map<string, Input>();
  #initial: string;

  constructor(ctx: ComposerContext, draft?: Draft) {
    this.ctx = ctx;
    this.mode = draft?.mode ?? "new";
    this.id = draft?.id;
    for (const [key, value] of Object.entries(draft?.values ?? {})) this.input(key).set(value);
    this.#initial = this.#signature();
  }

  /**
   * Edits an event as it is written. The text field holds the whole Markdown
   * body, links included, so nothing a person typed is hidden from them.
   */
  static forEntry(ctx: ComposerContext, entry: LoadedEntry, mode: ComposeMode): Composer {
    const values: Record<string, string> = {
      text: entry.body,
      title: entry.title,
      when: mode === "duplicate" ? "" : (entry.date ?? ""),
      // Shown the way it reads everywhere else; parseAmount takes it back.
      amount: entry.amount ? formatAmount(entry.amount) : "",
      projects: entry.projects.join(", "),
      tags: entry.tags.join(", "),
    };
    return new Composer(ctx, { version: 1, mode, id: mode === "edit" ? entry.path : undefined, values, updated: new Date().toISOString() });
  }

  // ── Fields ────────────────────────────────────────────────────────────────

  fields(): FieldSpec[] {
    return [
      { key: "text", label: "What happened?", kind: "multiline", hint: "Markdown · Enter adds a line · Ctrl+E opens your editor" },
      { key: "when", label: "Date", kind: "line", hint: "Blank means today. 2026-09-15" },
      { key: "amount", label: "Amount", kind: "line", hint: '325, $1,850 or "99.50 EUR" · counted in totals' },
      { key: "projects", label: "Topics", kind: "list", hint: "Comma separated · Tab completes" },
      { key: "tags", label: "Tags", kind: "list", hint: "Comma separated · Tab completes" },
      { key: "files", label: "Photos or files", kind: "files", hint: "Drag files here, or paste paths" },
    ];
  }

  field(): FieldSpec {
    const fields = this.fields();
    this.index = Math.min(this.index, fields.length - 1);
    return fields[this.index];
  }

  input(key: string): Input {
    let input = this.#inputs.get(key);
    if (!input) {
      input = new Input("", key === "text");
      this.#inputs.set(key, input);
    }
    return input;
  }

  value(key: string): string {
    return this.#inputs.get(key)?.value ?? "";
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
    const pool = field.key === "projects" ? this.ctx.projects : this.ctx.tags;
    this.suggestions = pool.filter((v) => v.toLowerCase().startsWith(partial) && !chosen.has(slugify(v))).slice(0, 5);
  }

  // ── Saving ────────────────────────────────────────────────────────────────

  draft(): Draft {
    const values: Record<string, string> = {};
    for (const [key, input] of this.#inputs) if (input.value) values[key] = input.value;
    return { version: 1, mode: this.mode, id: this.id, values, updated: new Date().toISOString() };
  }

  /** True when there is anything worth keeping or warning about. */
  dirty(): boolean {
    return this.#signature() !== this.#initial;
  }

  empty(): boolean {
    return !this.value("text").trim() && !this.value("files").trim();
  }

  #signature(): string {
    return JSON.stringify(this.draft().values);
  }

  #amount(): { value: number; currency: string } | null {
    const raw = this.value("amount").trim();
    if (!raw) return null;
    const amount = parseAmount(raw);
    if (!amount) throw new UserError(`"${raw}" isn't an amount. Try 325 or "$1,850".`);
    return amount;
  }

  #date(): string | undefined {
    const raw = this.value("when").trim();
    if (!raw) return undefined;
    if (!/^\d{4}-\d{2}-\d{2}/.test(raw)) throw new UserError(`"${raw}" isn't a date. Try 2026-09-15.`);
    return raw;
  }

  toInput(): EntryInput {
    const input: EntryInput = {
      title: this.value("title").trim() || undefined,
      text: this.value("text").trim(),
      projects: listValues(this.value("projects")),
      tags: listValues(this.value("tags")),
    };
    const date = this.#date();
    if (date) input.date = date;
    const amount = this.#amount();
    if (amount) input.amount = amount;
    return input;
  }

  toChanges(): EntryChanges {
    return {
      text: this.value("text").trim(),
      date: this.#date() ?? "",
      projects: listValues(this.value("projects")),
      tags: listValues(this.value("tags")),
      amount: this.#amount(),
    };
  }
}
