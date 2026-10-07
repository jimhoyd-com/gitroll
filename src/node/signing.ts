/**
 * Signed commits, with Git's own SSH signing and nothing invented on top.
 *
 * - A Roll lists who may sign in `.gitroll/allowed_signers`, in ssh-keygen's
 *   ALLOWED SIGNERS format. People are listed by email, agents as
 *   `agent:<name>`. It is committed with the Roll, so anyone with a copy can
 *   check who signed what.
 * - An agent can have its own Ed25519 key (`gitroll agent-key`). The private
 *   half lives in GitRoll's settings folder on this computer, never in a Roll.
 *   GitRoll signs that agent's commits with it, using Git's `gpg.format ssh`.
 * - Checking is Git's: `git log` with %G? and %GS, told where the allowed
 *   signers are with `gpg.ssh.allowedSignersFile`. Git hands the work to
 *   ssh-keygen; nothing here checks a signature itself.
 *
 * A `Gitroll-Agent:` trailer is a claim anyone can type. A good signature by
 * `agent:<name>` is the proof, and a trailer whose signature names someone
 * else is flagged.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GITROLL_DIR } from "../core/layout.ts";
import { UserError, slugify } from "../core/util.ts";
import { insideRoll } from "./fs-safe.ts";
import { generateEd25519, parsePublicKeyLine, privateKeyFile, publicKeyLine } from "./sshkey.ts";
import { configDir } from "./user-config.ts";
import type { GitRoll } from "./repo.ts";

export const ALLOWED_SIGNERS_PATH = `${GITROLL_DIR}/allowed_signers`;
const TRAILER = "Gitroll-Agent";

/**
 * good: a valid signature by a key the Roll's allowed_signers lists.
 * bad: a signature that doesn't match the commit (or a revoked key).
 * unknown: signed, but by a key that isn't listed, or that can't be checked here.
 * unsigned: no signature at all.
 */
export type SignatureStatus = "good" | "bad" | "unknown" | "unsigned";
export interface Signature {
  status: SignatureStatus;
  /** The allowed_signers principal that signed, when the signature is good. */
  signer: string | null;
}

/** Git's %G? letter, said in words. */
export function signatureOf(code: string, signer: string): Signature {
  const c = code.trim();
  const status: SignatureStatus = c === "G" ? "good" : c === "B" || c === "R" ? "bad" : c === "N" || c === "" ? "unsigned" : "unknown";
  return { status, signer: status === "good" && signer.trim() ? signer.trim() : null };
}

/** The principal an agent signs as in allowed_signers. */
export const agentPrincipal = (name: string): string => `agent:${name}`;

function gitConfig(root: string, key: string): string | null {
  try {
    return execFileSync("git", ["config", key], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

/** The Roll's allowed_signers file on disk, or null when it has none (or it isn't a plain file). */
export function allowedSignersFile(root: string): string | null {
  try {
    const abs = insideRoll(root, ALLOWED_SIGNERS_PATH);
    return fs.lstatSync(abs).isFile() ? abs : null;
  } catch {
    return null;
  }
}

/**
 * The `-c` options that tell Git where the allowed signers are, for a command
 * that reads signatures. The Roll's own list wins. With none, a person's own
 * gpg.ssh.allowedSignersFile still applies; with neither, an empty list, so a
 * signed commit reads as signed by an unknown key rather than as unsigned
 * (which is what Git says when it has no list at all).
 */
export function verifyConfig(root: string): string[] {
  const file = allowedSignersFile(root) ?? (gitConfig(root, "gpg.ssh.allowedSignersFile") ? null : emptySigners());
  // Checking needs no private key, so ssh-keygen does it even when a person signs
  // through another program (a password manager's, say) that may not verify.
  return file ? ["-c", `gpg.ssh.allowedSignersFile=${file}`, "-c", "gpg.ssh.program=ssh-keygen"] : ["-c", "gpg.ssh.program=ssh-keygen"];
}

function emptySigners(): string {
  if (process.platform !== "win32") return os.devNull;
  const file = path.join(os.tmpdir(), "gitroll-no-allowed-signers");
  if (!fs.existsSync(file)) fs.writeFileSync(file, "");
  return file;
}

// ── allowed_signers ─────────────────────────────────────────────────────────

export interface SignerLine {
  principals: string[];
  /** "ssh-ed25519 AAAA…", without options or comment. */
  key: string;
}

/** Reads ssh-keygen's ALLOWED SIGNERS format: principals, optional options, key type, key. */
export function parseAllowedSigners(text: string): SignerLine[] {
  const out: SignerLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    let principals: string;
    let rest: string;
    if (line.startsWith('"')) {
      const end = line.indexOf('"', 1);
      if (end < 0) continue;
      principals = line.slice(1, end);
      rest = line.slice(end + 1).trim();
    } else {
      const m = line.match(/^(\S+)\s+(.*)$/);
      if (!m) continue;
      [, principals, rest] = m;
    }
    // Options come before the key type and are optional.
    const key = rest.match(/(?:^|\s)((?:ssh-|ecdsa-|sk-)\S+\s+[A-Za-z0-9+/=]+)/)?.[1];
    if (!key) continue;
    out.push({ principals: principals.split(",").map((p) => p.trim()).filter(Boolean), key: key.replace(/\s+/g, " ") });
  }
  return out;
}

export function readAllowedSigners(root: string): SignerLine[] {
  const file = allowedSignersFile(root);
  return file ? parseAllowedSigners(fs.readFileSync(file, "utf8")) : [];
}

/** One allowed_signers line. A principal with a space in it is quoted. */
export function allowedSignersLine(principal: string, key: string): string {
  return `${/\s/.test(principal) ? `"${principal}"` : principal} ${key}`;
}

// ── Agent keys ──────────────────────────────────────────────────────────────

/** Where agents' private keys live: GitRoll's settings folder, never a Roll. */
export const agentKeysDir = (): string => path.join(configDir(), "agent-keys");

/**
 * An agent name that can be a principal. On top of --agent's own rule (one
 * line, 1–100 characters), it can't hold what allowed_signers treats as
 * syntax: a comma separates principals, *, ? and ! are patterns, and a quote
 * would end the field.
 */
export function checkAgentName(name: string): string {
  const clean = name.trim();
  if (!clean || clean.length > 100 || /[\x00-\x1f\x7f]/.test(clean)) throw new UserError("An agent name is 1–100 characters on one line.");
  if (/[,*?!"]/.test(clean)) throw new UserError('An agent name for a signing key can\'t contain , * ? ! or ".');
  return clean;
}

function keyFile(name: string): string {
  return path.join(agentKeysDir(), slugify(name) || "agent");
}

/**
 * The private key file for this agent, if this computer has one. The .pub
 * beside it names the principal, so two names that share a file name never
 * sign as each other.
 */
export function findAgentKey(name: string | null): { path: string; publicKey: string } | null {
  if (!name) return null;
  const file = keyFile(name);
  try {
    const pub = parsePublicKeyLine(fs.readFileSync(`${file}.pub`, "utf8"));
    if (pub.comment !== agentPrincipal(name) || !fs.statSync(file).isFile()) return null;
    return { path: file, publicKey: publicKeyLine({ publicKey: pub.publicKey, comment: "" }) };
  } catch {
    return null;
  }
}

/**
 * Makes an Ed25519 key for this agent in GitRoll's settings folder (0600), or
 * returns the one it already has. `forbidden` is a folder the key must never
 * be written inside: the Roll.
 */
export function createAgentKey(name: string, forbidden: string): { path: string; publicKey: string; created: boolean } {
  const agent = checkAgentName(name);
  const dir = agentKeysDir();
  const real = (p: string) => {
    // The deepest folder that exists, resolved, so a link can't hide where the key goes.
    let at = path.resolve(p);
    while (!fs.existsSync(at) && path.dirname(at) !== at) at = path.dirname(at);
    return path.join(fs.realpathSync(at), path.relative(at, path.resolve(p)));
  };
  const rel = path.relative(real(forbidden), real(dir));
  if (!rel || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    throw new UserError(`GitRoll's settings folder (${configDir()}) is inside this repository, so a private key there would be committed. Set GITROLL_HOME to a folder outside it.`);
  }
  const existing = findAgentKey(agent);
  if (existing) return { ...existing, created: false };
  const file = keyFile(agent);
  if (fs.existsSync(file) || fs.existsSync(`${file}.pub`)) {
    throw new UserError(`${file} already holds a key for a different agent name. Choose another name, or remove that key first.`);
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = generateEd25519(agentPrincipal(agent));
  // wx: never overwrite a key someone already has.
  fs.writeFileSync(file, privateKeyFile(key), { mode: 0o600, flag: "wx" });
  fs.chmodSync(file, 0o600);
  fs.writeFileSync(`${file}.pub`, `${publicKeyLine(key)}\n`, { mode: 0o644 });
  return { path: file, publicKey: publicKeyLine({ publicKey: key.publicKey, comment: "" }), created: true };
}

/**
 * The `-c` options that sign a commit with this agent's own key, or none: with
 * no key for the agent (or no agent), a person's own Git signing settings apply
 * exactly as they always did. The caller adds -S when this isn't empty.
 */
export function agentSigningConfig(agent: string | null): string[] {
  const key = findAgentKey(agent);
  // The agent's key is a file, which ssh-keygen signs with; a person's own
  // gpg.ssh.program (a password manager's, say) would not have it.
  return key ? ["-c", "gpg.format=ssh", "-c", "gpg.ssh.program=ssh-keygen", "-c", `user.signingkey=${key.path}`] : [];
}

// ── Verifying ───────────────────────────────────────────────────────────────

export interface VerifiedCommit {
  commit: string;
  date: string;
  author: string;
  subject: string;
  signed: boolean;
  status: SignatureStatus;
  /** The allowed_signers principal that signed, for a good signature. */
  signer: string | null;
  /** The signing key's fingerprint, when there is a signature. */
  key: string | null;
  /** The agent its Gitroll-Agent trailer names, or null. */
  agent: string | null;
  /**
   * For a commit with a trailer: match (signed by agent:<name>), mismatch
   * (a good signature by someone else), or unproven (unsigned, a key the
   * Roll doesn't list, or a bad signature, which fails on its own). Null
   * without a trailer.
   */
  agentCheck: "match" | "mismatch" | "unproven" | null;
}

export interface VerifyReport {
  ok: boolean;
  /** The allowed signers used, relative to the Roll, or null when the Roll has none. */
  allowedSigners: string | null;
  /** "roll": only commits touching .gitroll/, because the repository holds other work too. */
  scope: "repository" | "roll";
  requireSigned: boolean;
  summary: { total: number; good: number; unknown: number; bad: number; unsigned: number; mismatched: number };
  commits: VerifiedCommit[];
}

/** Whether the Roll shares its repository with a project: tracked files outside .gitroll/. */
function sharesRepository(roll: GitRoll): boolean {
  try {
    return roll.git(["ls-files", "--", ":!.gitroll", ":!.gitignore", ":!README.md"]).trim().length > 0;
  } catch {
    return false;
  }
}

/** Reads every commit's signature with Git and checks agent trailers against signers. */
export function verifyCommits(roll: GitRoll, opts: { since?: string; requireSigned?: boolean; limit?: number } = {}): VerifyReport {
  const shared = sharesRepository(roll);
  const range: string[] = [];
  let hasHead = true;
  try {
    roll.git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  } catch {
    hasHead = false;
  }
  if (opts.since !== undefined) {
    const since = opts.since.trim();
    if (!since || since.startsWith("-") || since.length > 200) throw new UserError("--since takes a commit or a date, e.g. --since HEAD~20 or --since 2026-01-01.");
    let sha: string | null = null;
    if (/^[0-9a-zA-Z_^~@{}./-]+$/.test(since)) {
      try {
        sha = roll.git(["rev-parse", "--verify", "--quiet", `${since}^{commit}`]).trim() || null;
      } catch {
        sha = null;
      }
    }
    range.push(...(sha ? [`${sha}..HEAD`] : [`--since=${since}`]));
  }
  const format = `%x1e%H%x1f%aI%x1f%an%x1f%s%x1f%G?%x1f%GS%x1f%GF%x1f%(trailers:key=${TRAILER},valueonly,separator=%x2C)`;
  const out = hasHead
    ? roll.git([...verifyConfig(roll.root), "log", `--format=${format}`, ...(opts.limit ? [`-n${opts.limit}`] : []), ...(range.length ? range : ["HEAD"]), ...(shared ? ["--", GITROLL_DIR] : [])])
    : "";
  const commits = out
    .split("\x1e")
    .filter((c) => c.trim())
    .map((chunk): VerifiedCommit => {
      const [commit, date, author, subject, code, signer, key, trailer = ""] = chunk.replace(/\n+$/, "").split("\x1f");
      const sig = signatureOf(code, signer);
      // Several trailers can't all be proven by one signature; the first is the claim.
      const agent = trailer.split(",")[0]?.trim() || null;
      const agentCheck = !agent ? null : sig.status === "good" ? (sig.signer === agentPrincipal(agent) ? "match" : "mismatch") : "unproven";
      return { commit, date, author, subject, signed: sig.status !== "unsigned", status: sig.status, signer: sig.signer, key: key.trim() || null, agent, agentCheck };
    });
  const count = (s: SignatureStatus) => commits.filter((c) => c.status === s).length;
  const summary = { total: commits.length, good: count("good"), unknown: count("unknown"), bad: count("bad"), unsigned: count("unsigned"), mismatched: commits.filter((c) => c.agentCheck === "mismatch").length };
  const requireSigned = !!opts.requireSigned;
  const ok = summary.bad === 0 && summary.mismatched === 0 && (!requireSigned || summary.good === summary.total);
  return { ok, allowedSigners: allowedSignersFile(roll.root) ? ALLOWED_SIGNERS_PATH : null, scope: shared ? "roll" : "repository", requireSigned, summary, commits };
}

/** For status: whether GitRoll's next commit here would be signed, and whether the Roll lists signers. */
export function signingStatus(roll: GitRoll, agent: string | null): { enabled: boolean; allowedSigners: string | null } {
  const enabled = !!findAgentKey(agent) || gitConfig(roll.root, "commit.gpgsign") === "true";
  return { enabled, allowedSigners: allowedSignersFile(roll.root) ? ALLOWED_SIGNERS_PATH : null };
}

/** Agents named in these commits' trailers that the Roll's allowed_signers doesn't list. */
export function agentsWithoutKeys(roll: GitRoll, commits: VerifiedCommit[]): string[] {
  const listed = new Set(readAllowedSigners(roll.root).flatMap((l) => l.principals));
  return [...new Set(commits.map((c) => c.agent).filter((a): a is string => !!a))].filter((a) => !listed.has(agentPrincipal(a)));
}
