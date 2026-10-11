// A vault item's plaintext: a Markdown note with YAML front matter, like any
// other GitRoll record, so a person who opens one with the `age` tool and a
// vault key reads something familiar. It only ever exists inside an age
// object (format.ts) or in memory.
//
//   ---
//   gitroll_vault: 1
//   type: item
//   vault: <vault id>
//   id: <item id>
//   rev: 3
//   kind: login
//   title: Bank
//   created: 2026-10-11T15:00:00Z
//   updated: 2026-10-11T15:20:00Z
//   fields:
//     - name: username
//       value: jim
//     - name: password
//       value: correct horse battery staple
//       secret: true
//   ---
//   Free text notes.
//
// The vault, id and revision are inside the ciphertext as well as in the
// signed snapshot, so an object moved to another item, another revision or
// another vault is refused even though its hash would check out.

import { parseDocument, stringify } from "yaml";
import { X25519Recipient, decrypt, encrypt } from "../age/format.ts";
import type { X25519Identity } from "../age/format.ts";
import { fromUtf8, utf8 } from "../age/bytes.ts";
import type { VaultCrypto } from "./crypto.ts";
import { ID, LIMITS, VaultError, checkObject, sha256Hex } from "./format.ts";
import type { ItemRef, VerifiedState } from "./format.ts";

export interface VaultField {
  name: string;
  value: string;
  /** Secret fields are left out of listings and shown only when asked for by name. */
  secret: boolean;
}

export interface VaultItem {
  id: string;
  rev: number;
  /** login, note, secret, card, … — a label for how to show it, not a schema. */
  kind: string;
  title: string;
  fields: VaultField[];
  notes: string;
  created: string;
  updated: string;
  /** Front matter this GitRoll doesn't know, kept as it was (an importer's extra fields, a newer GitRoll's). */
  ext: Record<string, unknown>;
}

export const ITEM_KINDS = ["login", "note", "secret", "card"] as const;
export const KIND = /^[a-z][a-z0-9-]{0,31}$/;
export const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
/** Field names whose values are secret unless said otherwise. */
const SECRET_NAMES = /^(password|passphrase|pass|pin|cvv|cvc|secret|token|value|key|api[_-]?key|private[_-]?key|totp|otp|seed|recovery[_-]?codes?)$/i;
export const isSecretName = (name: string): boolean => SECRET_NAMES.test(name);

/** The fields a new item of each kind asks for, in order. */
export const KIND_FIELDS: Record<string, string[]> = {
  login: ["username", "password", "url"],
  note: [],
  secret: ["value"],
  card: ["cardholder", "number", "expiry", "cvv"],
};

const KNOWN = new Set(["gitroll_vault", "type", "vault", "id", "rev", "kind", "title", "created", "updated", "fields"]);
const invalid = (message: string): never => {
  throw new VaultError("VAULT_INVALID", message);
};

/** Checks an item a person or importer is about to store. */
export function checkItem(item: VaultItem): void {
  if (!ID.test(item.id)) invalid("An item id is 26 characters of a–z and 2–7.");
  if (!Number.isSafeInteger(item.rev) || item.rev < 1) invalid("An item revision is a positive whole number.");
  if (!KIND.test(item.kind)) invalid(`"${item.kind.slice(0, 40)}" isn't a kind of item (try ${ITEM_KINDS.join(", ")}).`);
  if (!item.title.trim()) invalid("Give the item a title.");
  if (item.title.length > LIMITS.title || /[\r\n]/.test(item.title)) invalid(`A title is one line of at most ${LIMITS.title} characters.`);
  if (item.fields.length > LIMITS.fields) invalid(`An item holds at most ${LIMITS.fields} fields.`);
  const seen = new Set<string>();
  for (const f of item.fields) {
    if (!FIELD_NAME.test(f.name)) invalid(`"${f.name.slice(0, 40)}" isn't a field name (letters, digits, _ . -, starting with a letter).`);
    if (seen.has(f.name)) invalid(`The field ${f.name} appears twice.`);
    seen.add(f.name);
    if (typeof f.value !== "string" || f.value.length > LIMITS.fieldValue) invalid(`The field ${f.name} is too long (at most ${LIMITS.fieldValue} characters).`);
    if (typeof f.secret !== "boolean") invalid(`The field ${f.name} must say whether it's secret.`);
  }
  if (item.notes.length > LIMITS.notes) invalid("The notes are too long.");
  for (const k of Object.keys(item.ext)) if (KNOWN.has(k)) invalid(`${k} can't be an extension field.`);
}

/** The item as Markdown with front matter. */
export function encodeItem(vaultId: string, item: VaultItem): string {
  checkItem(item);
  const front = {
    gitroll_vault: 1,
    type: "item",
    vault: vaultId,
    id: item.id,
    rev: item.rev,
    kind: item.kind,
    title: item.title,
    created: item.created,
    updated: item.updated,
    fields: item.fields.map((f) => (f.secret ? { name: f.name, value: f.value, secret: true } : { name: f.name, value: f.value })),
    ...item.ext,
  };
  return `---\n${stringify(front, { lineWidth: 0 })}---\n${item.notes}`;
}

const tampered = (message: string): never => {
  throw new VaultError("VAULT_TAMPERED", message);
};

/** Reads an item's plaintext. Strict: a value that isn't what this file writes is refused, not guessed at. */
export function parseItem(text: string): { vault: string; item: VaultItem } {
  const m = /^---\n([\s\S]*?\n)?---\n([\s\S]*)$/.exec(text);
  if (!m) tampered("A vault item has no front matter.");
  const doc = parseDocument(m![1] ?? "", { schema: "core", uniqueKeys: true });
  if (doc.errors.length) tampered("A vault item's front matter isn't valid YAML.");
  const data = doc.toJS({ maxAliasCount: 0 }) as Record<string, unknown> | null;
  if (!data || typeof data !== "object" || Array.isArray(data)) tampered("A vault item's front matter isn't a mapping.");
  if (data!.gitroll_vault !== 1) throw new VaultError("VAULT_UNSUPPORTED", `A vault item is version ${String(data!.gitroll_vault)}; this GitRoll reads version 1.`);
  if (data!.type !== "item") tampered("A vault object isn't an item.");
  const str = (k: string): string => (typeof data![k] === "string" ? (data![k] as string) : tampered(`A vault item's ${k} is missing or malformed.`));
  if (!Array.isArray(data!.fields)) tampered("A vault item's fields are malformed.");
  const fields = (data!.fields as unknown[]).map((f) => {
    if (!f || typeof f !== "object" || Array.isArray(f)) tampered("A vault item has a malformed field.");
    const o = f as Record<string, unknown>;
    const extra = Object.keys(o).filter((k) => !["name", "value", "secret"].includes(k));
    if (extra.length) throw new VaultError("VAULT_UNSUPPORTED", "A vault item's field has properties this GitRoll doesn't know.");
    if (typeof o.name !== "string" || typeof o.value !== "string" || (o.secret !== undefined && o.secret !== true)) tampered("A vault item has a malformed field.");
    return { name: o.name as string, value: o.value as string, secret: o.secret === true };
  });
  const rev = data!.rev;
  if (typeof rev !== "number") tampered("A vault item's revision is malformed.");
  const ext: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data!)) if (!KNOWN.has(k)) ext[k] = v;
  const item: VaultItem = { id: str("id"), rev: rev as number, kind: str("kind"), title: str("title"), fields, notes: m![2], created: str("created"), updated: str("updated"), ext };
  try {
    checkItem(item);
  } catch (e) {
    if (e instanceof VaultError) tampered(`A vault item is malformed: ${e.message}`);
    throw e;
  }
  return { vault: str("vault"), item };
}

/** Encrypts an item to the vault key. Returns the object's bytes and the name it is stored under. */
export async function sealItem(vaultId: string, item: VaultItem, recipient: string, crypto: VaultCrypto): Promise<{ bytes: Uint8Array; hash: string; ref: ItemRef }> {
  const bytes = await encrypt(utf8(encodeItem(vaultId, item)), [X25519Recipient.parse(recipient)], crypto);
  const hash = await sha256Hex(bytes, crypto);
  return { bytes, hash, ref: { id: item.id, rev: item.rev, object: hash } };
}

/**
 * Opens one item the snapshot lists and checks that what is inside is that
 * item, at that revision, in this vault.
 */
export async function openItem(state: VerifiedState, ref: ItemRef, bytes: Uint8Array | null, vaultKey: X25519Identity, crypto: VaultCrypto): Promise<VaultItem> {
  const object = await checkObject(ref.object, bytes, crypto);
  let plain: Uint8Array;
  try {
    plain = await decrypt(object, [vaultKey], crypto);
  } catch {
    return tampered(`Item ${ref.id} doesn't open with the vault key.`);
  }
  let text: string;
  try {
    text = fromUtf8(plain);
  } catch {
    return tampered(`Item ${ref.id} isn't text.`);
  }
  const { vault, item } = parseItem(text);
  if (vault !== state.vaultId) tampered(`Item ${ref.id} belongs to another vault.`);
  if (item.id !== ref.id) tampered(`The object listed for item ${ref.id} holds a different item.`);
  if (item.rev !== ref.rev) tampered(`Item ${ref.id} is at revision ${item.rev}, but the snapshot lists ${ref.rev}.`);
  return item;
}

/** An item as listings show it: every field's name, and no secret value. */
export function redactItem(item: VaultItem): { id: string; rev: number; kind: string; title: string; fields: { name: string; secret: boolean; value?: string }[]; notes: boolean; created: string; updated: string } {
  return {
    id: item.id,
    rev: item.rev,
    kind: item.kind,
    title: item.title,
    fields: item.fields.map((f) => (f.secret ? { name: f.name, secret: true } : { name: f.name, secret: false, value: f.value })),
    notes: item.notes.length > 0,
    created: item.created,
    updated: item.updated,
  };
}

/** Finds an item by id, or by a title that only one item has (case-insensitive). */
export function findItem(items: VaultItem[], ref: string): VaultItem {
  const byId = items.find((i) => i.id === ref);
  if (byId) return byId;
  const want = ref.trim().toLowerCase();
  const hits = items.filter((i) => i.title.toLowerCase() === want);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new VaultError("VAULT_INVALID", `${hits.length} items are called that. Use an id: ${hits.map((h) => h.id).join(", ")}`);
  throw new VaultError("VAULT_INVALID", "There's no item with that id or title. List them with: gitroll vault list");
}

/** In-memory search over unlocked items: title, kind and non-secret field values. Never secret values. */
export function searchItems(items: VaultItem[], query: string): VaultItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return items;
  return items.filter((i) => {
    const hay = [i.title, i.kind, ...i.fields.filter((f) => !f.secret).flatMap((f) => [f.name, f.value])].join("\n").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
