// Sealing: encrypting part of a Roll with age so only the Roll's recipients can
// read it. The format lives in ../core/age/ and ../core/sealed.ts; this file is
// where it meets the disk, the user's keys and Git.
//
// Keys never live in a Roll. A secret key is kept in the person's GitRoll
// settings folder (or wherever GITROLL_IDENTITY points), with 0600
// permissions. A Roll lists only public recipients, in .gitroll/config.yaml.

import fs from "node:fs";
import path from "node:path";
import { AgeError, X25519Identity, X25519Recipient, armor, dearmor, decrypt, decryptAny, encrypt, isArmored, parseHeader, parseIdentities } from "../core/age/format.ts";
import { fromUtf8, utf8 } from "../core/age/bytes.ts";
import { FormatError, retargetLinks, splitSource } from "../core/entry.ts";
import { FILES_DIR, MARKER_PATH, isRollDocument } from "../core/layout.ts";
import type { LoadedEntry } from "../core/layout.ts";
import {
  SEALED_PLACEHOLDER,
  SEALED_SUFFIX,
  addRecipientToConfig,
  fieldPlaintext,
  isSealedValue,
  linesToSeal,
  parseLineRange,
  recipientsFromConfig,
  removeRecipientFromConfig,
  replaceLines,
  replaceSealedBlocks,
  sealedBlocks,
  sealedFence,
  sealedFields,
  setSealedField,
  setUnsealedField,
  wholeBodyRange,
} from "../core/sealed.ts";
import type { RollRecipient, SealedPart } from "../core/sealed.ts";
import { findSensitive } from "../core/privacy.ts";
import { NotFoundError, UserError } from "../core/util.ts";
import { nodeAgeCrypto } from "./age-crypto.ts";
import { safeRead, safeRemove, safeWrite, walkFiles } from "./fs-safe.ts";
import { findGitRoot } from "./repo.ts";
import type { GitRoll } from "./repo.ts";
import { configDir } from "./user-config.ts";

const crypto = nodeAgeCrypto;
export const HISTORY_DOC = "SECURITY.md, \"Removing something from Git history\"";

// ── Keys ───────────────────────────────────────────────────────────────────

/** Where this person's secret keys are kept: GITROLL_IDENTITY, or keys.txt in the settings folder. */
export function identityPath(): string {
  return process.env.GITROLL_IDENTITY ? path.resolve(process.env.GITROLL_IDENTITY) : path.join(configDir(), "keys.txt");
}

/** This computer's identities, or [] when it has none. A key file that can't be read is an error, not "no key". */
export function loadIdentities(): X25519Identity[] {
  const file = identityPath();
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT" && !process.env.GITROLL_IDENTITY) return [];
    throw new UserError(`Couldn't read your key file at ${file}: ${(e as Error).message}`);
  }
  try {
    return parseIdentities(text);
  } catch (e) {
    throw new UserError(`${file}: ${(e as Error).message}`);
  }
}

/** True when this process can open sealed content (it has at least one key). Never throws. */
export function hasIdentity(): boolean {
  try {
    return loadIdentities().length > 0;
  } catch {
    return false;
  }
}

/** The public recipients of this computer's keys, with the names written beside them. */
export async function listKeys(): Promise<{ path: string; keys: { recipient: string; name?: string }[] }> {
  const file = identityPath();
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const keys: { recipient: string; name?: string }[] = [];
  let name: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const label = /^#\s*name:\s*(.+)$/.exec(line);
    if (label) name = label[1].trim();
    if (!line.startsWith("AGE-SECRET-KEY-1")) continue;
    keys.push({ recipient: (await X25519Identity.parse(line).recipient(crypto)).toString(), ...(name ? { name } : {}) });
    name = undefined;
  }
  return { path: file, keys };
}

/**
 * Creates a new X25519 identity and appends it to the key file, in the format
 * age-keygen writes, so `age -d -i <file>` can use it too. Refuses to write
 * anywhere inside a Git repository: a key committed by accident is a key
 * published.
 */
export async function newKey(name?: string): Promise<{ recipient: string; path: string; name?: string }> {
  const file = identityPath();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const repo = findGitRoot(dir);
  if (repo) {
    throw new UserError(`Refusing to keep a secret key inside a Git repository (${repo}). Set GITROLL_IDENTITY or GITROLL_HOME to a folder outside any repository.`);
  }
  const identity = await X25519Identity.generate(crypto);
  const recipient = (await identity.recipient(crypto)).toString();
  const label = name?.replace(/[\r\n]+/g, " ").trim();
  const block = [`# created: ${new Date().toISOString().replace(/\.\d+Z$/, "Z")}`, ...(label ? [`# name: ${label}`] : []), `# public key: ${recipient}`, identity.toString(), ""].join("\n");
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const fd = fs.openSync(file, "a", 0o600);
  try {
    fs.writeSync(fd, `${existing && !existing.endsWith("\n") ? "\n" : ""}${existing ? "\n" : ""}${block}`);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(file, 0o600);
  return { recipient, path: file, ...(label ? { name: label } : {}) };
}

// ── Recipients ─────────────────────────────────────────────────────────────

const configText = (roll: GitRoll) => safeRead(roll.root, MARKER_PATH).toString("utf8");

export function rollRecipients(roll: GitRoll): RollRecipient[] {
  return recipientsFromConfig(configText(roll));
}

export function addRecipient(roll: GitRoll, recipient: string, label?: string): { recipients: RollRecipient[]; added: boolean } {
  const key = recipient.trim();
  try {
    X25519Recipient.parse(key);
  } catch (e) {
    throw new UserError((e as Error).message);
  }
  if (rollRecipients(roll).some((r) => r.recipient === key)) return { recipients: rollRecipients(roll), added: false };
  safeWrite(roll.root, MARKER_PATH, addRecipientToConfig(configText(roll), key, label));
  roll.commitFiles([MARKER_PATH], `recipients: add ${label?.trim() || `${key.slice(0, 12)}…`}`);
  return { recipients: rollRecipients(roll), added: true };
}

/** What `recipients remove` tells the person: re-seal, and what re-sealing can't reach. */
export const REMOVED_NOTICES = [
  "Content sealed before is still sealed to the removed key. Run: gitroll reseal, to seal it again to the recipients left.",
  `Re-sealing changes the current version only: the old ciphertext stays in Git history, and in every clone and backup made before, and the removed key can still open it there. Treat what it protected as seen by that key. To remove it from history yourself, see ${HISTORY_DOC}.`,
];

export function removeRecipient(roll: GitRoll, which: string): { recipients: RollRecipient[]; removed: string[]; notices: string[] } {
  const { text, removed } = removeRecipientFromConfig(configText(roll), which);
  if (!removed.length) throw new NotFoundError(`No recipient matches "${which}". Run: gitroll recipients`);
  safeWrite(roll.root, MARKER_PATH, text);
  roll.commitFiles([MARKER_PATH], `recipients: remove ${removed.map((r) => `${r.slice(0, 12)}…`).join(", ")}`);
  return { recipients: rollRecipients(roll), removed, notices: [...REMOVED_NOTICES] };
}

async function recipientsFor(roll: GitRoll): Promise<{ recipients: X25519Recipient[]; notices: string[] }> {
  const listed = rollRecipients(roll);
  if (!listed.length) {
    throw new UserError("This Roll has no recipients, so there is nobody to seal it for. Make a key with: gitroll key new, then add it with: gitroll recipients add <age1…>");
  }
  const recipients = listed.map((r) => {
    try {
      return X25519Recipient.parse(r.recipient);
    } catch (e) {
      throw new UserError(`.gitroll/config.yaml: ${(e as Error).message}`);
    }
  });
  const notices: string[] = [];
  const mine = await Promise.all(safeIdentities().map(async (i) => (await i.recipient(crypto)).toString()));
  if (!mine.some((m) => listed.some((r) => r.recipient === m))) {
    notices.push(mine.length
      ? "None of the keys on this computer is one of this Roll's recipients, so you won't be able to unseal this here."
      : "There's no key on this computer, so you won't be able to unseal this here. Only the Roll's recipients can.");
  }
  return { recipients, notices };
}

function safeIdentities(): X25519Identity[] {
  try {
    return loadIdentities();
  } catch {
    return [];
  }
}

function requireIdentities(): X25519Identity[] {
  const ids = loadIdentities();
  if (!ids.length) throw new UserError(`There's no key on this computer to unseal with. Put your key file at ${identityPath()}, or set GITROLL_IDENTITY to its path.`);
  return ids;
}

// ── History ────────────────────────────────────────────────────────────────

/** Commits that changed `rel` and still hold it, whose version passes `test` when one is given. Newest first. */
function plainInHistory(roll: GitRoll, rel: string, test?: (old: string) => boolean): string[] {
  let log = "";
  try {
    log = roll.git(["log", "--format=%H", "--max-count=200", "--", rel]);
  } catch {
    return [];
  }
  const hits: string[] = [];
  for (const sha of log.split("\n").map((s) => s.trim()).filter(Boolean)) {
    try {
      // A commit that removed the file touched it but doesn't hold it.
      if (!test) roll.git(["cat-file", "-e", `${sha}:${rel}`]);
      if (!test || test(roll.git(["show", `${sha}:${rel}`]))) hits.push(sha);
    } catch {
      // the file didn't exist in that commit (it was deleting it)
    }
  }
  return hits;
}

function historyNotice(what: string, commits: string[]): string[] {
  if (!commits.length) return [];
  const shown = commits.slice(0, 5).map((c) => c.slice(0, 12)).join(", ");
  const more = commits.length > 5 ? ` and ${commits.length - 5} more` : "";
  return [
    `Warning: ${what} was committed in plain before it was sealed. Git history still has it in ${commits.length === 1 ? "commit" : "commits"} ${shown}${more}, ` +
      `and anyone with a copy of this repository can read it there. Sealing doesn't change history. To remove it, see ${HISTORY_DOC}.`,
  ];
}

// ── Sealing documents ──────────────────────────────────────────────────────

export interface SealTarget {
  lines?: string;
  field?: string;
}

export interface SealResult {
  path: string;
  sealed: SealedPart[];
  notices: string[];
  /** Commits that still hold what was sealed, in plain. */
  history: string[];
  commit: string | null;
}

function lineRange(text: string): { start: number; end: number } {
  const range = parseLineRange(text);
  if (!range) throw new UserError(`--lines takes a line number or a range like 5-9, not "${text}".`);
  return range;
}

/** What a seal argument names: a document (event or note), or a file under .gitroll/files/. */
export function sealTarget(roll: GitRoll, arg: string): { kind: "file"; path: string } | { kind: "document"; entry: LoadedEntry } {
  const clean = arg.replace(/\\/g, "/").replace(/^\.\//, "");
  const candidates = [clean, `.gitroll/${clean}`];
  for (const rel of candidates) {
    if (!rel.startsWith(`${FILES_DIR}/`) || isRollDocument(rel)) continue;
    if (roll.attachmentFile(rel)) return { kind: "file", path: rel };
  }
  if (clean.startsWith("files/") || clean.startsWith(`${FILES_DIR}/`)) throw new NotFoundError(`There's no file at ${clean.startsWith(".gitroll/") ? clean : `.gitroll/${clean}`}.`);
  return { kind: "document", entry: roll.entry(arg) };
}

/**
 * Seals part of an event or note in place: lines of its body become a sealed
 * block, or a front matter field becomes a sealed value. With neither, the
 * whole body after the title is sealed.
 */
export async function sealDocument(roll: GitRoll, entry: LoadedEntry, target: SealTarget = {}): Promise<SealResult> {
  if (target.lines && target.field) throw new UserError("Choose either --lines or --field, not both.");
  const { recipients, notices } = await recipientsFor(roll);
  const rel = entry.path;
  const source = safeRead(roll.root, rel).toString("utf8");
  let next: string;
  let part: SealedPart;
  let plaintext: string;
  try {
    if (target.field) {
      const key = target.field.trim();
      if (["date", "source"].includes(key.toLowerCase())) throw new FormatError(`${key} can't be sealed: GitRoll needs to read it to know what the file is`);
      plaintext = fieldPlaintext(source, key);
      next = setSealedField(source, key, armor(await encrypt(utf8(`${plaintext}\n`), recipients, crypto)));
      part = { sealed: true, kind: "field", field: key };
    } else {
      const range = target.lines ? lineRange(target.lines) : wholeBodyRange(source);
      if (!range) throw new FormatError("there's no text under the title to seal");
      plaintext = linesToSeal(source, range.start, range.end);
      const fence = sealedFence(armor(await encrypt(utf8(`${plaintext}\n`), recipients, crypto)));
      next = replaceLines(source, range.start, range.end, fence);
      part = { sealed: true, kind: "block", lines: `${range.start}-${range.start + fence.split("\n").length - 1}` };
    }
  } catch (e) {
    if (e instanceof FormatError) throw new UserError(`Nothing was sealed: ${e.message}.`);
    throw e;
  }
  // Every line is checked rather than the whole text: a commit that holds any
  // one of them in plain still gives that line away.
  const telling = plaintext.split("\n").map((l) => l.trim()).filter((l) => l.length >= 4);
  const history = telling.length ? plainInHistory(roll, rel, (old) => telling.some((l) => old.includes(l))) : [];
  safeWrite(roll.root, rel, next);
  const commit = roll.commitFiles([rel], `seal: ${part.kind === "field" ? `${part.field} in ` : ""}${rel.replace(/^\.gitroll\//, "")}`);
  return { path: rel, sealed: [part], notices: [...notices, ...historyNotice(part.kind === "field" ? `The value of ${part.field}` : "That text", history)], history, commit };
}

/** Writes sealed blocks and fields back in plain. Only ever because someone asked: the plaintext is committed. */
export async function unsealDocument(roll: GitRoll, entry: LoadedEntry, target: SealTarget = {}): Promise<{ path: string; unsealed: SealedPart[]; commit: string | null; notices: string[] }> {
  if (target.lines && target.field) throw new UserError("Choose either --lines or --field, not both.");
  const identities = requireIdentities();
  const rel = entry.path;
  let source = safeRead(roll.root, rel).toString("utf8");
  const range = target.lines ? lineRange(target.lines) : null;
  const unsealed: SealedPart[] = [];
  try {
    const fields = target.lines ? [] : sealedFields(entry.meta).filter((k) => !target.field || k === target.field);
    if (target.field && !fields.length) throw new UserError(`${target.field} isn't a sealed field in ${rel}.`);
    for (const key of fields) {
      const plain = fromUtf8(await decryptAny(String(entry.meta[key]), identities, crypto)).replace(/\n$/, "");
      source = setUnsealedField(source, key, plain);
      unsealed.push({ sealed: true, kind: "field", field: key });
    }
    if (!target.field) {
      const blocks = sealedBlocks(source).filter((b) => !range || (range.start <= b.end && range.end >= b.start));
      if (range && !blocks.length) throw new UserError(`There's no sealed block at lines ${target.lines} of ${rel}. Run: gitroll show ${rel}`);
      for (const b of [...blocks].reverse()) {
        const plain = fromUtf8(await decryptAny(b.armor, identities, crypto)).replace(/\n$/, "");
        source = replaceLines(source, b.start, b.end, plain);
        unsealed.unshift({ sealed: true, kind: "block", lines: `${b.start}-${b.end}` });
      }
    }
  } catch (e) {
    if (e instanceof AgeError) throw new UserError(`Nothing was unsealed: ${e.message}`);
    throw e;
  }
  if (!unsealed.length) throw new UserError(`${rel} has nothing sealed in it.`);
  safeWrite(roll.root, rel, source);
  const commit = roll.commitFiles([rel], `unseal: ${rel.replace(/^\.gitroll\//, "")}`);
  return { path: rel, unsealed, commit, notices: ["The plain text is now in the file, and in history once committed."] };
}

// ── Sealing files ──────────────────────────────────────────────────────────

/** Rewrites every link to `from` so it points at `to`, in every event and note. */
function relinkEverywhere(roll: GitRoll, from: string, to: string): string[] {
  const changed: string[] = [];
  for (const e of roll.documents()) {
    if (!e.attachments.some((a) => a.path === from)) continue;
    const source = safeRead(roll.root, e.path).toString("utf8");
    const { head, body } = splitSource(source);
    const next = `${head}${retargetLinks(body, e.path, from, to)}`;
    if (next !== source) {
      safeWrite(roll.root, e.path, next);
      changed.push(e.path);
    }
  }
  return changed;
}

/** Seals a file under .gitroll/files/: x.pdf becomes x.pdf.age (binary age), and links follow it. */
export async function sealFile(roll: GitRoll, rel: string): Promise<SealResult> {
  if (rel.endsWith(SEALED_SUFFIX)) throw new UserError(`${rel} is already sealed.`);
  const { recipients, notices } = await recipientsFor(roll);
  const target = `${rel}${SEALED_SUFFIX}`;
  if (roll.attachmentFile(target)) throw new UserError(`There's already a file at ${target}.`);
  const plain = safeRead(roll.root, rel);
  const history = plainInHistory(roll, rel);
  safeWrite(roll.root, target, await encrypt(new Uint8Array(plain), recipients, crypto));
  safeRemove(roll.root, rel);
  const relinked = relinkEverywhere(roll, rel, target);
  const commit = roll.commitFiles([rel, target, ...relinked], `seal: ${rel.replace(/^\.gitroll\//, "")}`);
  return {
    path: target,
    sealed: [{ sealed: true, kind: "file", file: target }],
    notices: [...notices, ...(relinked.length ? [`Links updated in ${relinked.join(", ")}.`] : []), ...historyNotice(rel.replace(/^\.gitroll\//, ""), history)],
    history,
    commit,
  };
}

/** Writes a sealed file back in plain (x.pdf.age becomes x.pdf), and links follow it. */
export async function unsealFile(roll: GitRoll, rel: string): Promise<{ path: string; unsealed: string; commit: string | null; notices: string[] }> {
  if (!rel.endsWith(SEALED_SUFFIX)) throw new UserError(`${rel} isn't sealed (a sealed file ends in ${SEALED_SUFFIX}).`);
  const identities = requireIdentities();
  const target = rel.slice(0, -SEALED_SUFFIX.length);
  if (roll.attachmentFile(target)) throw new UserError(`There's already a file at ${target}.`);
  let plain: Uint8Array;
  try {
    plain = await decrypt(new Uint8Array(safeRead(roll.root, rel)), identities, crypto);
  } catch (e) {
    if (e instanceof AgeError) throw new UserError(`Nothing was unsealed: ${e.message}`);
    throw e;
  }
  safeWrite(roll.root, target, plain);
  safeRemove(roll.root, rel);
  const relinked = relinkEverywhere(roll, rel, target);
  const commit = roll.commitFiles([rel, target, ...relinked], `unseal: ${target.replace(/^\.gitroll\//, "")}`);
  return { path: target, unsealed: rel, commit, notices: ["The plain file is in the Roll now, and in history once committed."] };
}

/** A sealed file's contents, for showing (never written to disk). Null without a key that opens it. */
export async function openSealedFile(abs: string): Promise<Uint8Array | null> {
  const identities = safeIdentities();
  if (!identities.length) return null;
  try {
    return await decrypt(new Uint8Array(fs.readFileSync(abs)), identities, crypto);
  } catch {
    return null;
  }
}

// ── Re-sealing ─────────────────────────────────────────────────────────────

/** One sealed part, as reseal reports it. */
export interface ResealPart {
  path: string;
  kind: "block" | "field" | "file";
  /** For a block: its fence lines in the file (where they are after re-sealing). */
  lines?: string;
  /** For a field: its front matter key. */
  field?: string;
}

export interface ResealResult {
  /** The recipients everything is sealed to now: the Roll's, from .gitroll/config.yaml. */
  recipients: string[];
  dryRun: boolean;
  /** Sealed again to `recipients` (with dryRun, what would be). */
  resealed: ResealPart[];
  /** Already sealed to exactly `recipients`, as far as the age header shows: left as it is. */
  unchanged: ResealPart[];
  /** Not opened, and left exactly as it is: no key here opens it, or it is damaged. */
  unopened: (ResealPart & { reason: string })[];
  commit: string | null;
  notices: string[];
}

/**
 * True only when the age header shows the file is sealed to exactly these
 * recipients. An X25519 stanza doesn't name its recipient, so the only stanzas
 * that can be told apart are the ones a key on this computer opens: unless
 * every current recipient is a key here, this is false and the part is sealed
 * again, which is always safe.
 */
async function sealedToExactly(file: Uint8Array, identities: X25519Identity[], current: X25519Recipient[]): Promise<boolean> {
  try {
    const { stanzas } = parseHeader(file);
    const wanted = new Set(current.map((r) => r.toString()));
    if (stanzas.length !== wanted.size) return false;
    const owners: { identity: X25519Identity; recipient: string }[] = [];
    for (const identity of identities) {
      const recipient = (await identity.recipient(crypto)).toString();
      if (wanted.has(recipient) && !owners.some((o) => o.recipient === recipient)) owners.push({ identity, recipient });
    }
    if (owners.length !== wanted.size) return false;
    const matched = new Set<string>();
    for (const stanza of stanzas) {
      if (stanza.type !== "X25519") return false;
      let owner: string | null = null;
      for (const o of owners) {
        if (!matched.has(o.recipient) && (await o.identity.unwrap([stanza], crypto)) !== null) {
          owner = o.recipient;
          break;
        }
      }
      if (!owner) return false;
      matched.add(owner);
    }
    return matched.size === wanted.size;
  } catch {
    return false;
  }
}

interface Opened {
  part: ResealPart;
  /** For a block: its index among the file's sealed blocks. */
  block?: number;
  plain?: Uint8Array;
  current?: boolean;
  reason?: string;
}

/** Opens one sealed part with these keys. A failure to open is recorded, not thrown. */
async function openPart(part: ResealPart, file: () => Uint8Array, identities: X25519Identity[], current: X25519Recipient[], block?: number): Promise<Opened> {
  try {
    const bytes = file();
    const plain = await decrypt(bytes, identities, crypto);
    return { part, block, plain, current: await sealedToExactly(bytes, identities, current) };
  } catch (e) {
    if (e instanceof AgeError) return { part, block, reason: e.message };
    throw e;
  }
}

interface Planned {
  write: { path: string; data: string | Uint8Array } | null;
  resealed: ResealPart[];
  unchanged: ResealPart[];
  unopened: (ResealPart & { reason: string })[];
}

const hasSealed = (roll: GitRoll, entry: LoadedEntry): boolean =>
  sealedFields(entry.meta).length > 0 || sealedBlocks(safeRead(roll.root, entry.path).toString("utf8")).length > 0;

async function planDocument(roll: GitRoll, entry: LoadedEntry, identities: X25519Identity[], recipients: X25519Recipient[]): Promise<Planned> {
  const rel = entry.path;
  const source = safeRead(roll.root, rel).toString("utf8");
  const blocks = sealedBlocks(source);
  const plan: Planned = { write: null, resealed: [], unchanged: [], unopened: [] };
  const opened: Opened[] = [];
  for (const field of sealedFields(entry.meta)) {
    opened.push(await openPart({ path: rel, kind: "field", field }, () => dearmor(String(entry.meta[field])), identities, recipients));
  }
  for (const [i, b] of blocks.entries()) {
    opened.push(await openPart({ path: rel, kind: "block", lines: `${b.start}-${b.end}` }, () => dearmor(b.armor), identities, recipients, i));
  }
  // A file is rewritten whole or not at all: one part that can't be opened
  // leaves every part of that file as it is.
  if (opened.some((o) => o.reason !== undefined)) {
    plan.unopened = opened.map((o) => ({ ...o.part, reason: o.reason ?? "Left as it is, because another sealed part of this file can't be opened." }));
    return plan;
  }
  const todo = opened.filter((o) => !o.current);
  if (!todo.length) {
    plan.unchanged = opened.map((o) => o.part);
    return plan;
  }
  // Blocks first, from the last one up, so the line numbers above still hold;
  // then fields, which change only the front matter.
  let next = source;
  const lines = source.split("\n");
  for (const o of [...todo].filter((p) => p.block !== undefined).reverse()) {
    const b = blocks[o.block!];
    const indent = /^ */.exec(lines[b.start - 1])![0];
    const fence = sealedFence(armor(await encrypt(o.plain!, recipients, crypto))).split("\n").map((l) => `${indent}${l}`).join("\n");
    next = replaceLines(next, b.start, b.end, fence);
  }
  for (const o of todo.filter((p) => p.part.kind === "field")) {
    try {
      next = setSealedField(next, o.part.field!, armor(await encrypt(o.plain!, recipients, crypto)));
    } catch (e) {
      if (e instanceof FormatError) throw new UserError(`Nothing was re-sealed: ${rel}: ${e.message}.`);
      throw e;
    }
  }
  // Report blocks where they are now: a different recipient list changes their length.
  const after = sealedBlocks(next);
  const where = (o: Opened): ResealPart => {
    const now = o.block === undefined ? undefined : after[o.block];
    return now ? { ...o.part, lines: `${now.start}-${now.end}` } : o.part;
  };
  plan.resealed = todo.map(where);
  plan.unchanged = opened.filter((o) => o.current).map(where);
  plan.write = { path: rel, data: next };
  return plan;
}

async function planFile(roll: GitRoll, rel: string, identities: X25519Identity[], recipients: X25519Recipient[]): Promise<Planned> {
  const part: ResealPart = { path: rel, kind: "file" };
  const plan: Planned = { write: null, resealed: [], unchanged: [], unopened: [] };
  const bytes = new Uint8Array(safeRead(roll.root, rel));
  // GitRoll writes sealed files in binary; one written with `age --armor` stays armored.
  const armored = isArmored(Buffer.from(bytes.subarray(0, 64)).toString("latin1"));
  const o = await openPart(part, () => (armored ? dearmor(fromUtf8(bytes)) : bytes), identities, recipients);
  if (o.reason !== undefined) plan.unopened.push({ ...part, reason: o.reason });
  else if (o.current) plan.unchanged.push(part);
  else {
    const sealed = await encrypt(o.plain!, recipients, crypto);
    plan.write = { path: rel, data: armored ? armor(sealed) : sealed };
    plan.resealed.push(part);
  }
  return plan;
}

/**
 * Opens sealed content with this computer's keys and seals it again to the
 * Roll's current recipients, as one commit: every sealed block, field and file
 * in the Roll, or in the one file named. What no key here opens is reported
 * and left exactly as it is, and a file is never half rewritten.
 */
export async function reseal(roll: GitRoll, arg?: string, opts: { dryRun?: boolean } = {}): Promise<ResealResult> {
  const identities = requireIdentities();
  const { recipients, notices } = await recipientsFor(roll);
  const dryRun = !!opts.dryRun;
  if (notices.length) {
    // Sealing to a list without your own key would lock you out of everything at once.
    const lockout = "None of the keys on this computer is one of this Roll's recipients, so re-sealing would leave you unable to open any of it here. Add yours first with: gitroll recipients add <age1…> (gitroll key shows it)";
    if (!dryRun) throw new UserError(`Nothing was re-sealed. ${lockout}`);
    notices.splice(0, notices.length, lockout);
  }
  const plans: Planned[] = [];
  if (arg !== undefined) {
    const target = sealTarget(roll, arg);
    if (target.kind === "file") {
      if (!target.path.endsWith(SEALED_SUFFIX)) throw new UserError(`${target.path} isn't sealed (a sealed file ends in ${SEALED_SUFFIX}).`);
      plans.push(await planFile(roll, target.path, identities, recipients));
    } else {
      if (!hasSealed(roll, target.entry)) throw new UserError(`${target.entry.path} has nothing sealed in it.`);
      plans.push(await planDocument(roll, target.entry, identities, recipients));
    }
  } else {
    for (const entry of roll.documents()) if (hasSealed(roll, entry)) plans.push(await planDocument(roll, entry, identities, recipients));
    const files = walkFiles(roll.root, FILES_DIR).files.filter((f) => f.endsWith(SEALED_SUFFIX)).sort();
    for (const rel of files) plans.push(await planFile(roll, rel, identities, recipients));
  }
  const resealed = plans.flatMap((p) => p.resealed);
  const unchanged = plans.flatMap((p) => p.unchanged);
  const unopened = plans.flatMap((p) => p.unopened);
  const writes = plans.flatMap((p) => (p.write ? [p.write] : []));
  let commit: string | null = null;
  if (!dryRun && writes.length) {
    // Everything is encrypted before anything is written.
    for (const w of writes) safeWrite(roll.root, w.path, w.data);
    const parts = `${resealed.length} sealed ${resealed.length === 1 ? "part" : "parts"}`;
    commit = roll.commitFiles(writes.map((w) => w.path), `reseal: ${parts} to ${recipients.length} ${recipients.length === 1 ? "recipient" : "recipients"}`);
  }
  if (unopened.length) {
    const where = [...new Set(unopened.map((u) => u.path))].join(", ");
    notices.push(`Not re-sealed, because no key on this computer opens it (or it is damaged): ${where}. It is still sealed to the recipients it had. Run gitroll reseal where a key that opens it is kept.`);
  }
  if (resealed.length) {
    notices.push(`Re-sealing changes the current version only: the earlier ciphertext stays in Git history, and in every clone and backup made before, and every key it was sealed to can still open it there. To remove it from history yourself, see ${HISTORY_DOC}.`);
  }
  return { recipients: recipients.map((r) => r.toString()), dryRun, resealed, unchanged, unopened, commit, notices };
}

// ── Reading ────────────────────────────────────────────────────────────────

/**
 * An entry as a reader without a key sees it: each sealed field is
 * `{sealed: true}` and `sealed` lists where every sealed part is. The body is
 * unchanged (sealed blocks are ciphertext), so an edit that copies it back
 * keeps them. With `unseal`, each part also carries its plaintext, for display
 * only, when a key on this computer opens it.
 */
export async function presentEntry<T extends LoadedEntry>(entry: T, opts: { source?: string; unseal?: boolean } = {}): Promise<T & { sealed?: SealedPart[] }> {
  const identities = opts.unseal ? safeIdentities() : [];
  if (!identities.length) return maskEntry(entry, opts.source);
  const texts = new Map<string, string>();
  const armored = [...sealedFields(entry.meta).map((f) => String(entry.meta[f])), ...sealedBlocks(opts.source ?? entry.body).map((b) => b.armor)];
  for (const a of armored) {
    try {
      texts.set(a, fromUtf8(await decryptAny(a, identities, crypto)).replace(/\n$/, ""));
    } catch {
      // Not sealed for any key here, or damaged: it stays a placeholder.
    }
  }
  return maskEntry(entry, opts.source, texts);
}

/** The same, without opening anything: what every list and search returns. Synchronous. */
export function maskEntry<T extends LoadedEntry>(entry: T, source?: string, texts: Map<string, string> = new Map()): T & { sealed?: SealedPart[] } {
  const fields = sealedFields(entry.meta);
  const blocks = sealedBlocks(source ?? entry.body);
  if (!fields.length && !blocks.length) return entry;
  const meta: Record<string, unknown> = { ...entry.meta };
  const parts: SealedPart[] = [];
  for (const field of fields) {
    const text = texts.get(String(entry.meta[field]));
    meta[field] = text === undefined ? { sealed: true } : { sealed: true, text };
    parts.push({ sealed: true, kind: "field", field, ...(text === undefined ? {} : { text }) });
  }
  for (const b of blocks) {
    const text = texts.get(b.armor);
    parts.push({ sealed: true, kind: "block", ...(source !== undefined ? { lines: `${b.start}-${b.end}` } : {}), ...(text === undefined ? {} : { text }) });
  }
  return { ...entry, meta, sealed: parts };
}

/** The body as shown to a person: each sealed block replaced by its plaintext, or by a placeholder. */
export function displayBody(body: string, parts?: SealedPart[]): string {
  const texts = (parts ?? []).filter((p) => p.kind === "block");
  return replaceSealedBlocks(body, (_b, i) => {
    const text = texts[i]?.text;
    return text === undefined ? `${SEALED_PLACEHOLDER} (gitroll show --unsealed opens it with your key)` : `${SEALED_PLACEHOLDER} ↓\n${text}\n${SEALED_PLACEHOLDER} ↑`;
  });
}

/** A front matter value as shown to a person. */
export function displayValue(value: unknown): string | null {
  if (isSealedValue(value)) return SEALED_PLACEHOLDER;
  if (value && typeof value === "object" && (value as { sealed?: unknown }).sealed === true) {
    const text = (value as { text?: string }).text;
    return text === undefined ? SEALED_PLACEHOLDER : `${text} ${SEALED_PLACEHOLDER}`;
  }
  return null;
}

/**
 * What to suggest when a save turns up something that looks like a secret:
 * the exact `gitroll seal` command for the lines it is on.
 */
export function sealSuggestion(roll: GitRoll, rel: string): { path: string; lines: string; command: string } | null {
  let source: string;
  try {
    source = safeRead(roll.root, rel).toString("utf8");
  } catch {
    return null;
  }
  const lines = source.split("\n");
  const blocked = new Set<number>();
  for (const b of sealedBlocks(source)) for (let i = b.start; i <= b.end; i++) blocked.add(i);
  const { head } = splitSource(source);
  const first = head ? head.split("\n").length : 1;
  const hits: number[] = [];
  for (let i = first; i <= lines.length; i++) if (!blocked.has(i) && findSensitive(lines[i - 1]).length) hits.push(i);
  if (!hits.length) return null;
  const range = `${hits[0]}-${hits[hits.length - 1]}`;
  return { path: rel, lines: range, command: `gitroll seal ${rel} --lines ${range}` };
}
