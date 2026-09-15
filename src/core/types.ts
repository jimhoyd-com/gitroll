// Event types. A type is a template: a label, an icon, and optional structured
// fields stored under `data:`. Built-in types ship with GitRoll; custom types
// live in the log itself at .gitroll/types/<id>.yaml, so the data never depends
// on a plugin being installed.

import { parse } from "yaml";
import { DEFAULT_TYPE, TYPE_ID, isMapping } from "./entry.ts";

export type FieldKind = "text" | "longtext" | "number" | "date" | "select" | "boolean" | "url";
const KINDS: FieldKind[] = ["text", "longtext", "number", "date", "select", "boolean", "url"];

export interface FieldDef {
  key: string;
  label: string;
  kind: FieldKind;
  options?: string[];
  required?: boolean;
  help?: string;
}

/** Values prefilled when someone picks this type. Plain data only; nothing is executed. */
export interface TypeDefaults {
  text?: string;
  projects?: string[];
  tags?: string[];
  amount?: { value: number; currency: string };
  data?: Record<string, string | number | boolean>;
}

export interface EventType {
  id: string;
  label: string;
  icon: string;
  description?: string;
  /** Whether the composer shows the amount field. */
  amount: "none" | "optional" | "expected";
  fields: FieldDef[];
  defaults?: TypeDefaults;
  builtin: boolean;
}

export const TYPE_FILE = /^\.gitroll\/types\/([^/]+)\.ya?ml$/;
const FIELD_KEY = /^[a-z][a-z0-9_]{0,63}$/;

const t = (id: string, label: string, icon: string, amount: EventType["amount"], fields: FieldDef[], description: string): EventType => ({
  id,
  label,
  icon,
  amount,
  fields,
  description,
  builtin: true,
});
const text = (key: string, label: string, extra: Partial<FieldDef> = {}): FieldDef => ({ key, label, kind: "text", ...extra });
const date = (key: string, label: string): FieldDef => ({ key, label, kind: "date" });
const select = (key: string, label: string, options: string[]): FieldDef => ({ key, label, kind: "select", options });

// The starter set. Nothing else in GitRoll depends on these ids.
export const BUILTIN_TYPES: EventType[] = [
  t(DEFAULT_TYPE, "Log", "📝", "optional", [], "Something happened."),
  t("expense", "Expense", "🧾", "expected", [text("vendor", "Paid to"), text("category", "Category"), select("method", "Method", ["card", "cash", "check", "transfer", "other"])], "Money spent, usually with a receipt."),
  t("maintenance", "Maintenance", "🔧", "optional", [text("asset", "Asset"), text("vendor", "Done by"), date("next_due", "Next due"), date("warranty_until", "Warranty until")], "Service, repair or upkeep."),
  t("decision", "Decision", "⚖️", "none", [select("status", "Status", ["decided", "proposed", "reversed"]), { key: "alternatives", label: "Alternatives considered", kind: "longtext" }], "A choice that was made, and why."),
  t("milestone", "Milestone", "🏁", "none", [], "A notable moment."),
  t("issue", "Issue", "⚠️", "optional", [select("severity", "Severity", ["low", "medium", "high"]), select("status", "Status", ["open", "resolved"])], "A problem that was noticed."),
];

/** Parses a custom type definition from .gitroll/types/<id>.yaml. Throws on invalid definitions. */
export function parseTypeDef(id: string, source: string): EventType {
  if (!TYPE_ID.test(id)) throw new Error(`invalid type id: ${id}`);
  const d = parse(source);
  if (!isMapping(d)) throw new Error("type definition must be a mapping");
  const fields = Array.isArray(d.fields) ? d.fields : [];
  return {
    id,
    label: typeof d.label === "string" && d.label ? d.label : id,
    icon: typeof d.icon === "string" && d.icon ? [...d.icon].slice(0, 2).join("") : "•",
    description: typeof d.description === "string" ? d.description : undefined,
    amount: d.amount === "expected" || d.amount === "none" ? d.amount : "optional",
    defaults: parseDefaults(d.defaults),
    builtin: false,
    fields: fields.map((f, i): FieldDef => {
      if (!isMapping(f) || typeof f.key !== "string" || !FIELD_KEY.test(f.key)) {
        throw new Error(`fields[${i}] needs a key of lowercase letters, digits and underscores`);
      }
      const kind = KINDS.includes(f.kind as FieldKind) ? (f.kind as FieldKind) : "text";
      const def: FieldDef = { key: f.key, label: typeof f.label === "string" && f.label ? f.label : f.key, kind };
      if (kind === "select") def.options = Array.isArray(f.options) ? f.options.map(String) : [];
      if (f.required === true) def.required = true;
      if (typeof f.help === "string") def.help = f.help;
      return def;
    }),
  };
}

/** Custom definitions override built-ins with the same id. */
export function typeRegistry(custom: EventType[] = []): Map<string, EventType> {
  const map = new Map(BUILTIN_TYPES.map((x) => [x.id, x]));
  for (const c of custom) map.set(c.id, c);
  return map;
}

/** Falls back to a generic definition so unknown types always render. */
export function typeFor(registry: Map<string, EventType>, id: string): EventType {
  return registry.get(id) ?? { ...registry.get(DEFAULT_TYPE)!, id, label: id, icon: "•", builtin: false };
}

/**
 * Coerces form input into typed values. Keys the type doesn't define are kept,
 * because data written by another tool must never be silently dropped.
 */
export function normalizeData(type: EventType, raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const field = type.fields.find((f) => f.key === key);
    if (value === "" || value == null) continue;
    if (!field) {
      out[key] = value;
      continue;
    }
    switch (field.kind) {
      case "number": {
        const n = typeof value === "number" ? value : Number(String(value).replace(/,/g, ""));
        out[key] = Number.isFinite(n) ? n : value;
        break;
      }
      case "boolean":
        out[key] = value === true || value === "true" || value === "on" || value === "yes";
        break;
      default:
        out[key] = typeof value === "string" ? value.trim() : value;
    }
  }
  return out;
}

/** Problems with structured data. Missing required fields are a UI concern, not a format error. */
export function validateData(type: EventType, data: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const f of type.fields) {
    const v = data[f.key];
    if (v == null) continue;
    if (f.kind === "number" && typeof v !== "number") errors.push(`${f.key} should be a number`);
    if (f.kind === "boolean" && typeof v !== "boolean") errors.push(`${f.key} should be true or false`);
    if (f.kind === "date" && Number.isNaN(Date.parse(String(v)))) errors.push(`${f.key} should be a date`);
    if (f.kind === "url" && !/^https?:\/\//.test(String(v))) errors.push(`${f.key} should be an http(s) link`);
    if (f.kind === "select" && f.options?.length && !f.options.includes(String(v))) {
      errors.push(`${f.key} should be one of: ${f.options.join(", ")}`);
    }
  }
  return errors;
}

function parseDefaults(v: unknown): TypeDefaults | undefined {
  if (!isMapping(v)) return undefined;
  const strings = (x: unknown) => (Array.isArray(x) ? x.filter((i): i is string => typeof i === "string").slice(0, 20) : undefined);
  const out: TypeDefaults = {};
  if (typeof v.text === "string") out.text = v.text.slice(0, 2000);
  if (strings(v.projects)) out.projects = strings(v.projects);
  if (strings(v.tags)) out.tags = strings(v.tags);
  if (isMapping(v.amount) && Number.isFinite(Number(v.amount.value))) {
    out.amount = { value: Number(v.amount.value), currency: typeof v.amount.currency === "string" ? v.amount.currency.toUpperCase().slice(0, 3) : "USD" };
  }
  if (isMapping(v.data)) {
    out.data = Object.fromEntries(
      Object.entries(v.data).filter((e): e is [string, string | number | boolean] => /^[a-z][a-z0-9_]{0,63}$/.test(e[0]) && ["string", "number", "boolean"].includes(typeof e[1])),
    );
  }
  return Object.keys(out).length ? out : undefined;
}
