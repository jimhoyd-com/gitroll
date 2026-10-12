// Moving items into and out of a vault from other password managers' formats.
// Platform-free: the containers (KDBX's encryption, 1PUX's zip) are opened in
// src/node/vault/; here is only what their contents mean, item by item, and a
// plain account of what didn't carry over.
//
// Nothing here writes anything. An importer turns a parsed export into
// drafts, with a report; the CLI shows the report (a dry run stops there), and
// the broker stores the drafts encrypted.

import { base64, unbase64 } from "../age/bytes.ts";
import { FIELD_NAME, KIND, isSecretName } from "./items.ts";
import type { VaultField, VaultItem } from "./items.ts";
import { LIMITS } from "./format.ts";
import { child, children, escapeXml } from "./xml.ts";
import type { XmlElement } from "./xml.ts";

/** An item about to be imported: everything but the id and revision the vault gives it. */
export interface ImportDraft {
  kind: string;
  title: string;
  fields: VaultField[];
  notes: string;
  created?: string;
  updated?: string;
  /** What the source had that a vault item has no place for, kept encrypted with the item. */
  ext: Record<string, unknown>;
}

export interface ImportResult {
  format: "keepass" | "1password" | "sops";
  /** Items found in the file, before anything was skipped. */
  found: number;
  drafts: ImportDraft[];
  /** Items left out, and why. */
  skipped: { reason: string; count: number }[];
  /** What was dropped from items that were imported. */
  losses: { what: string; count: number }[];
}

class Tally {
  #counts = new Map<string, number>();
  add(what: string, n = 1): void {
    if (n > 0) this.#counts.set(what, (this.#counts.get(what) ?? 0) + n);
  }
  list(): { what: string; count: number }[] {
    return [...this.#counts].map(([what, count]) => ({ what, count }));
  }
}

/** A field name a vault accepts, made from whatever the source called it, unique within the item. */
export function fieldName(raw: string, taken: Set<string>): string {
  let name = raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9_.-]/g, "");
  if (!/^[A-Za-z_]/.test(name)) name = `field_${name}`;
  name = name.slice(0, 60).replace(/[_.-]+$/, "") || "field";
  let out = name;
  for (let n = 2; taken.has(out.toLowerCase()); n++) out = `${name}_${n}`;
  taken.add(out.toLowerCase());
  if (!FIELD_NAME.test(out)) return fieldName("field", taken);
  return out;
}

const oneLine = (s: string): string => s.replace(/[\r\n]+/g, " ").trim();

/**
 * Checks a draft against the vault's limits. Returns why it can't be imported,
 * or null; never truncates a value, since a cut-off password is worse than a
 * missing one.
 */
export function draftProblem(d: ImportDraft): string | null {
  if (d.fields.length > LIMITS.fields) return `more than ${LIMITS.fields} fields`;
  if (d.fields.some((f) => f.value.length > LIMITS.fieldValue)) return `a field longer than ${LIMITS.fieldValue / 1024} KiB`;
  if (d.notes.length > LIMITS.notes) return "notes longer than 1 MiB";
  if (d.title.length > LIMITS.title) return `a title longer than ${LIMITS.title} characters`;
  if (!KIND.test(d.kind)) return "an unknown kind";
  return null;
}

function finish(format: ImportResult["format"], found: number, drafts: ImportDraft[], skipped: Tally, losses: Tally): ImportResult {
  const ok: ImportDraft[] = [];
  for (const d of drafts) {
    const problem = draftProblem(d);
    if (problem) skipped.add(`too large or malformed for a vault item (${problem})`);
    else ok.push(d);
  }
  return { format, found, drafts: ok, skipped: skipped.list().map(({ what, count }) => ({ reason: what, count })), losses: losses.list() };
}

const fieldValue = (d: ImportDraft | VaultItem, name: string): string => d.fields.find((f) => f.name === name)?.value ?? "";

/**
 * What makes two items the same for duplicate checks: title, username and URL,
 * none of them secret, so a check can run against a vault listing that never
 * carries secret values.
 */
export function duplicateKey(item: { title: string; fields: { name: string; value?: string }[] }): string {
  const v = (n: string) => item.fields.find((f) => f.name === n)?.value ?? "";
  return [item.title.trim().toLowerCase(), v("username").trim().toLowerCase(), v("url").trim().replace(/\/+$/, "").toLowerCase()].join("\u0000");
}

const kindFor = (fields: VaultField[], notes: string): string =>
  fields.some((f) => f.name === "username" || f.name === "password") ? "login" : !fields.length && notes ? "note" : "secret";

// ── KeePass (KDBX 4 XML) ─────────────────────────────────────────────────

/** Seconds from 0001-01-01 to 1970-01-01, KeePass's epoch for KDBX 4 times. */
const KEEPASS_EPOCH_S = 62135596800;

function keepassTime(el: XmlElement | undefined): string | undefined {
  const text = el?.text.trim();
  if (!text) return undefined;
  if (/^\d{4}-\d\d-\d\dT/.test(text)) {
    const t = Date.parse(text);
    return Number.isNaN(t) ? undefined : new Date(t).toISOString().replace(/\.\d+Z$/, "Z");
  }
  const bytes = unbase64(text);
  if (!bytes || bytes.length !== 8) return undefined;
  const s = Number(new DataView(bytes.buffer, bytes.byteOffset, 8).getBigInt64(0, true)) - KEEPASS_EPOCH_S;
  const ms = s * 1000;
  return Number.isFinite(ms) && Math.abs(ms) < 8.64e15 ? new Date(ms).toISOString().replace(/\.\d+Z$/, "Z") : undefined;
}

const uuidHex = (el: XmlElement | undefined): string => {
  const b = el ? unbase64(el.text.trim()) : null;
  return b && b.length === 16 ? Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("") : "";
};

const STANDARD: Record<string, string> = { UserName: "username", Password: "password", URL: "url" };
/** KeePass's own string names, which a custom field can't reuse. */
const RESERVED = new Set(["Title", "UserName", "Password", "URL", "Notes"]);

/**
 * Drafts from a KeePass database's XML, whose protected values the caller has
 * already decrypted in place (src/node/vault/kdbx.ts).
 */
export function keepassDrafts(root: XmlElement): ImportResult {
  if (root.name !== "KeePassFile") throw new Error("This isn't a KeePass database's XML.");
  const meta = child(root, "Meta");
  const recycle = child(meta, "RecycleBinEnabled")?.text.trim() === "True" ? uuidHex(child(meta, "RecycleBinUUID")) : "";
  const drafts: ImportDraft[] = [];
  const skipped = new Tally();
  const losses = new Tally();
  let found = 0;
  const walk = (group: XmlElement, path: string[], binned: boolean) => {
    const name = child(group, "Name")?.text ?? "";
    const here = [...path, name];
    const inBin = binned || (!!recycle && uuidHex(child(group, "UUID")) === recycle);
    for (const entry of children(group, "Entry")) {
      found++;
      if (inBin) {
        skipped.add("in KeePass's recycle bin");
        continue;
      }
      const taken = new Set<string>(["username", "password", "url"]);
      const fields: VaultField[] = [];
      let title = "";
      let notes = "";
      for (const s of children(entry, "String")) {
        const key = child(s, "Key")?.text ?? "";
        const valueEl = child(s, "Value");
        const value = valueEl?.text ?? "";
        const protectedValue = valueEl?.attrs.Protected === "True" || valueEl?.attrs.ProtectInMemory === "True";
        if (key === "Title") title = oneLine(value);
        else if (key === "Notes") notes = value;
        else if (key in STANDARD) {
          if (value) fields.push({ name: STANDARD[key], value, secret: key === "Password" });
        } else if (value || protectedValue) fields.push({ name: fieldName(key, taken), value, secret: protectedValue || isSecretName(key) || /^(otp|totp|TOTP Seed)$/i.test(key) });
      }
      // UserName, Password, URL first, in that order, then the rest as they came.
      const order = (f: VaultField) => ["username", "password", "url"].indexOf(f.name) + 1 || 4;
      fields.sort((a, b) => order(a) - order(b));
      const binaries = children(entry, "Binary").length;
      if (binaries) losses.add("attachments (vault items don't hold files)", binaries);
      const history = children(child(entry, "History"), "Entry").length;
      if (history) losses.add("older versions from an entry's history", history);
      if (child(entry, "AutoType") && children(child(entry, "AutoType"), "Association").length) losses.add("auto-type associations");
      const tags = (child(entry, "Tags")?.text ?? "").split(/[;,]/).map((t) => t.trim()).filter(Boolean);
      const times = child(entry, "Times");
      const expires = child(times, "Expires")?.text.trim() === "True" ? keepassTime(child(times, "ExpiryTime")) : undefined;
      const keepass: Record<string, unknown> = { uuid: uuidHex(child(entry, "UUID")), group: here.join("/") };
      if (tags.length) keepass.tags = tags;
      if (expires) keepass.expires = expires;
      drafts.push({
        kind: kindFor(fields, notes),
        title: title || "(untitled)",
        fields,
        notes,
        created: keepassTime(child(times, "CreationTime")),
        updated: keepassTime(child(times, "LastModificationTime")),
        ext: { keepass },
      });
    }
    for (const sub of children(group, "Group")) walk(sub, here, inBin);
  };
  const top = child(child(root, "Root"), "Group");
  if (!top) throw new Error("This KeePass database has no root group.");
  walk(top, [], false);
  return finish("keepass", found, drafts, skipped, losses);
}

const keepassTimeText = (iso: string): string => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, BigInt(Math.floor(Date.parse(iso) / 1000) + KEEPASS_EPOCH_S), true);
  return base64(b);
};

/**
 * A KeePass database's XML for these items. `protect` encrypts one protected
 * value with the inner stream and returns its base64; it is called in document
 * order, as KeePass requires. `uuid` makes 16 random bytes.
 */
export function keepassXml(name: string, items: VaultItem[], now: string, protect: (plain: string) => string, uuid: () => Uint8Array): { xml: string; losses: { what: string; count: number }[] } {
  const losses = new Tally();
  type Node = { name: string; groups: Map<string, Node>; items: VaultItem[] };
  const tree: Node = { name, groups: new Map(), items: [] };
  for (const item of items) {
    const kp = item.ext.keepass as { group?: unknown } | undefined;
    const path = typeof kp?.group === "string" ? kp.group.split("/").slice(1).filter(Boolean) : [];
    let node = tree;
    for (const p of path) {
      if (!node.groups.has(p)) node.groups.set(p, { name: p, groups: new Map(), items: [] });
      node = node.groups.get(p)!;
    }
    node.items.push(item);
    const others = Object.keys(item.ext).filter((k) => k !== "keepass");
    if (others.length) losses.add("items' extra data from other password managers (it stays in the vault)");
  }
  const uuidText = (hexOrEmpty: unknown): string => {
    const hex = typeof hexOrEmpty === "string" && /^[0-9a-f]{32}$/.test(hexOrEmpty) ? hexOrEmpty : "";
    return base64(hex ? Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16))) : uuid());
  };
  const times = (created: string, updated: string, expires?: string) =>
    `<Times><CreationTime>${keepassTimeText(created)}</CreationTime><LastModificationTime>${keepassTimeText(updated)}</LastModificationTime><LastAccessTime>${keepassTimeText(updated)}</LastAccessTime><ExpiryTime>${keepassTimeText(expires ?? now)}</ExpiryTime><Expires>${expires ? "True" : "False"}</Expires><UsageCount>0</UsageCount><LocationChanged>${keepassTimeText(updated)}</LocationChanged></Times>`;
  const out: string[] = [];
  const str = (key: string, value: string, protectedValue: boolean) =>
    out.push(protectedValue ? `<String><Key>${escapeXml(key)}</Key><Value Protected="True">${protect(value)}</Value></String>` : `<String><Key>${escapeXml(key)}</Key><Value>${escapeXml(value)}</Value></String>`);
  const entry = (item: VaultItem) => {
    const kp = (item.ext.keepass ?? {}) as { uuid?: unknown; tags?: unknown; expires?: unknown };
    out.push(`<Entry><UUID>${uuidText(kp.uuid)}</UUID><IconID>0</IconID>`);
    if (Array.isArray(kp.tags)) out.push(`<Tags>${escapeXml(kp.tags.filter((t) => typeof t === "string").join(";"))}</Tags>`);
    out.push(times(item.created, item.updated, typeof kp.expires === "string" && !Number.isNaN(Date.parse(kp.expires)) ? kp.expires : undefined));
    // Strings in the order KeePass writes them, protected ones encrypted in that same order.
    const rest = item.fields.filter((f) => !["username", "password", "url"].includes(f.name));
    const pairs: [string, string, boolean][] = [
      ["Notes", item.notes, false],
      ["Password", fieldValue(item, "password"), true],
      ["Title", item.title, false],
      ["URL", fieldValue(item, "url"), false],
      ["UserName", fieldValue(item, "username"), false],
      ...rest.map((f): [string, string, boolean] => [RESERVED.has(f.name) ? `${f.name}_field` : f.name, f.value, f.secret]),
    ];
    for (const [k, v, p] of pairs) str(k, v, p);
    out.push(`<AutoType><Enabled>True</Enabled><DataTransferObfuscation>0</DataTransferObfuscation></AutoType></Entry>`);
  };
  const group = (node: Node) => {
    out.push(`<Group><UUID>${base64(uuid())}</UUID><Name>${escapeXml(node.name)}</Name><Notes></Notes><IconID>48</IconID>${times(now, now)}<IsExpanded>True</IsExpanded>`);
    for (const item of node.items) entry(item);
    for (const g of node.groups.values()) group(g);
    out.push(`</Group>`);
  };
  out.push(
    `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<KeePassFile><Meta><Generator>GitRoll</Generator><DatabaseName>${escapeXml(name)}</DatabaseName><DatabaseNameChanged>${keepassTimeText(now)}</DatabaseNameChanged>` +
      `<MemoryProtection><ProtectTitle>False</ProtectTitle><ProtectUserName>False</ProtectUserName><ProtectPassword>True</ProtectPassword><ProtectURL>False</ProtectURL><ProtectNotes>False</ProtectNotes></MemoryProtection>` +
      `<RecycleBinEnabled>False</RecycleBinEnabled><HistoryMaxItems>10</HistoryMaxItems><HistoryMaxSize>6291456</HistoryMaxSize></Meta><Root>`,
  );
  group(tree);
  out.push(`<DeletedObjects/></Root></KeePassFile>`);
  return { xml: out.join(""), losses: losses.list() };
}

// ── 1Password (1PUX export.data) ─────────────────────────────────────────

const ONEPASSWORD_KINDS: Record<string, string> = {
  "001": "login",
  "002": "card",
  "003": "note",
  "004": "identity",
  "005": "secret",
  "100": "software-license",
  "101": "bank-account",
  "102": "database",
  "103": "driver-license",
  "104": "outdoor-license",
  "105": "membership",
  "106": "passport",
  "107": "rewards",
  "108": "ssn",
  "109": "wireless-router",
  "110": "server",
  "111": "email-account",
  "112": "secret",
  "113": "medical-record",
  "114": "secret",
  "115": "crypto-wallet",
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const s = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/** One 1PUX field value as text, whether it's secret, or null when it can't be carried. */
function onePasswordValue(value: unknown): { text: string; secret: boolean; extra?: [string, string] } | { unsupported: string } | null {
  if (!isObj(value)) return null;
  const [type] = Object.keys(value);
  if (type === undefined) return null;
  const v = value[type];
  switch (type) {
    case "string":
    case "email":
    case "url":
    case "phone":
    case "menu":
    case "creditCardType":
    case "gender":
      return { text: isObj(v) ? s(v.email_address ?? v.value) : s(v), secret: false };
    case "concealed":
    case "totp":
    case "creditCardNumber":
      return { text: s(v), secret: true };
    case "date": {
      const n = Number(v);
      return { text: Number.isFinite(n) && n ? new Date(n * 1000).toISOString().slice(0, 10) : "", secret: false };
    }
    case "monthYear": {
      const n = s(v);
      return { text: /^\d{6}$/.test(n) ? `${n.slice(0, 4)}-${n.slice(4)}` : n, secret: false };
    }
    case "address":
      return isObj(v) ? { text: ["street", "city", "state", "zip", "country"].map((k) => s(v[k])).filter(Boolean).join(", "), secret: false } : null;
    case "sshKey":
      if (!isObj(v)) return null;
      return { text: s(v.privateKey), secret: true, extra: isObj(v.metadata) && s(v.metadata.publicKey) ? ["public_key", s(v.metadata.publicKey)] : undefined };
    case "file":
      return { unsupported: "attachments (vault items don't hold files)" };
    case "reference":
      return { unsupported: "links to other 1Password items" };
    default:
      return { unsupported: `fields of a type GitRoll doesn't read (${type.slice(0, 30)}), kept in the item's extra data` };
  }
}

/** Drafts from a 1PUX export's export.data. */
export function onePasswordDrafts(data: unknown): ImportResult {
  if (!isObj(data) || !Array.isArray(data.accounts)) throw new Error("This isn't a 1Password export (1PUX): export.data has no accounts.");
  const drafts: ImportDraft[] = [];
  const skipped = new Tally();
  const losses = new Tally();
  let found = 0;
  for (const account of data.accounts) {
    if (!isObj(account) || !Array.isArray(account.vaults)) continue;
    for (const vault of account.vaults) {
      if (!isObj(vault) || !Array.isArray(vault.items)) continue;
      const vaultName = isObj(vault.attrs) ? s(vault.attrs.name) : "";
      for (const raw of vault.items) {
        // Older exports wrap each item: { item: {...} }.
        const item = isObj(raw) && isObj(raw.item) ? raw.item : raw;
        if (!isObj(item)) continue;
        found++;
        if (item.state === "archived") {
          skipped.add("archived in 1Password");
          continue;
        }
        const category = s(item.categoryUuid);
        if (category === "006") {
          skipped.add("documents (vault items don't hold files)");
          continue;
        }
        const overview = isObj(item.overview) ? item.overview : {};
        const details = isObj(item.details) ? item.details : {};
        const taken = new Set<string>();
        const fields: VaultField[] = [];
        const unmapped: unknown[] = [];
        const push = (name: string, text: string, secret: boolean) => {
          if (text) fields.push({ name: fieldName(name, taken), value: text, secret: secret || isSecretName(name) });
        };
        for (const f of Array.isArray(details.loginFields) ? details.loginFields : []) {
          if (!isObj(f)) continue;
          const designation = s(f.designation);
          const name = designation === "username" ? "username" : designation === "password" ? "password" : s(f.name) || s(f.id) || "field";
          push(name, s(f.value), designation === "password" || s(f.fieldType) === "P");
        }
        if (s(details.password)) push("password", s(details.password), true);
        const url = s(overview.url) || (Array.isArray(overview.urls) && isObj(overview.urls[0]) ? s(overview.urls[0].url) : "");
        if (url) push("url", url, false);
        if (Array.isArray(overview.urls))
          for (const u of overview.urls.slice(1)) if (isObj(u) && s(u.url) && s(u.url) !== url) push(s(u.label) || "url", s(u.url), false);
        for (const section of Array.isArray(details.sections) ? details.sections : []) {
          if (!isObj(section) || !Array.isArray(section.fields)) continue;
          for (const f of section.fields) {
            if (!isObj(f)) continue;
            const name = s(f.title) || s(f.id) || "field";
            const v = onePasswordValue(f.value);
            if (!v) continue;
            if ("unsupported" in v) {
              losses.add(v.unsupported);
              if (v.unsupported.includes("kept in")) unmapped.push({ section: s(section.title), title: name, value: f.value });
              continue;
            }
            push(name, v.text, v.secret || f.guarded === true);
            if (v.extra) push(v.extra[0], v.extra[1], false);
          }
        }
        const history = Array.isArray(details.passwordHistory) ? details.passwordHistory.length : 0;
        if (history) losses.add("earlier passwords from an item's history", history);
        if (isObj(details.documentAttributes)) losses.add("attachments (vault items don't hold files)");
        const tags = Array.isArray(overview.tags) ? overview.tags.filter((t): t is string => typeof t === "string") : [];
        const onepassword: Record<string, unknown> = { uuid: s(item.uuid), vault: vaultName, category };
        if (tags.length) onepassword.tags = tags;
        if (unmapped.length) onepassword.unmapped = unmapped;
        const notes = s(details.notesPlain);
        const time = (n: unknown) => (typeof n === "number" && n > 0 ? new Date(n * 1000).toISOString().replace(/\.\d+Z$/, "Z") : undefined);
        drafts.push({
          kind: ONEPASSWORD_KINDS[category] ?? kindFor(fields, notes),
          title: oneLine(s(overview.title)) || "(untitled)",
          fields,
          notes,
          created: time(item.createdAt),
          updated: time(item.updatedAt),
          ext: { onepassword },
        });
      }
    }
  }
  return finish("1password", found, drafts, skipped, losses);
}

// ── SOPS ─────────────────────────────────────────────────────────────────

/**
 * One draft from a decrypted SOPS document: each top-level key a secret field.
 * The values come from `sops --decrypt`; this never reads SOPS's own format.
 */
export function sopsDraft(title: string, data: unknown, source: string): ImportResult {
  if (!isObj(data)) throw new Error("A SOPS document to import must be a mapping of names to values.");
  const skipped = new Tally();
  const losses = new Tally();
  const taken = new Set<string>();
  const fields: VaultField[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (k === "sops") continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") fields.push({ name: fieldName(k, taken), value: String(v), secret: true });
    else losses.add("nested values (only top-level names are read)");
  }
  return finish("sops", 1, [{ kind: "secret", title, fields, notes: "", ext: { sops: { source } } }], skipped, losses);
}

/** An item's fields as a flat mapping for `sops --encrypt`. Field names that aren't environment-safe keep their name. */
export function sopsDocument(item: VaultItem): Record<string, string> {
  return Object.fromEntries(item.fields.map((f) => [f.name, f.value]));
}
