// The contract between `gitroll secrets` (the client in this repository) and a
// GitRoll secrets gateway (a separate service, not in this repository; see
// docs/SECRETS-GATEWAY.md). Pure: types, response checks, and the reference
// rules a gateway applies to a workload's identity claims.
//
// The gateway's trust boundary is not the personal vault's. It holds deployment
// secrets in plaintext inside its runtime (OpenBao behind it), and it never
// holds a personal vault key. Values reach it only by an explicit publication
// of an approved SOPS document.
//
// What this file does NOT do: verify a JWT. A gateway must check the token's
// signature, algorithm, issuer, audience and times with a maintained JWT
// library against the issuer's published keys, before these claim rules run.

export const SECRETS_API_VERSION = "v1";
/** The audience a GitHub Actions job requests its OIDC token for, unless configured otherwise. */
export const DEFAULT_AUDIENCE = "gitroll-secrets";
export const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";

export type SecretsErrorCode =
  | "invalid_request"
  | "invalid_token"
  | "token_expired"
  | "audience_mismatch"
  | "policy_denied"
  | "replay"
  | "environment_unknown"
  | "bundle_unavailable"
  | "conflict"
  | "unavailable";

/** POST /v1/exchange — a workload trades its OIDC token for a short session. */
export interface ExchangeRequest {
  token: string;
  environment: string;
}
export interface ExchangeResponse {
  session: string;
  /** ISO 8601; never more than the bundle's policy allows (minutes, not hours). */
  expiresAt: string;
  bundle: { id: string; version: number; sourceRevision: string };
}

/** GET /v1/bundles/{id}/versions/{version} with Authorization: Bearer <session>. */
export interface BundleResponse {
  id: string;
  version: number;
  sourceRevision: string;
  values: Record<string, string>;
}

/** POST /v1/publications — an authorized publisher asks for an approved revision to become active. */
export interface PublicationRequest {
  token: string;
  environment: string;
  /** A full Git commit SHA the publisher has verified is approved. */
  sourceRevision: string;
  /** Path of the SOPS document within that revision. */
  source: string;
}
export interface PublicationResponse {
  id: string;
  environment: string;
  bundle: string;
  version: number;
  sourceRevision: string;
  /** active only after every value was written and the activation compare-and-swap succeeded. */
  status: "active" | "pending" | "failed";
  /** True when this exact revision was already published: publication is idempotent. */
  replayed: boolean;
}

export interface ErrorResponse {
  error: { code: SecretsErrorCode; message: string };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export const ENVIRONMENT = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export class SecretsProtocolError extends Error {}
const bad = (what: string): never => {
  throw new SecretsProtocolError(`The gateway sent a malformed ${what}.`);
};

export function checkExchange(v: unknown): ExchangeResponse {
  if (!isObj(v) || typeof v.session !== "string" || !v.session || v.session.length > 4096 || typeof v.expiresAt !== "string" || !isObj(v.bundle)) bad("exchange response");
  const o = v as Record<string, any>;
  if (typeof o.bundle.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(o.bundle.id) || !Number.isSafeInteger(o.bundle.version) || o.bundle.version < 1 || typeof o.bundle.sourceRevision !== "string" || !SHA.test(o.bundle.sourceRevision)) bad("exchange response");
  if (Number.isNaN(Date.parse(o.expiresAt))) bad("exchange response");
  return o as ExchangeResponse;
}

export function checkBundle(v: unknown, expect: ExchangeResponse["bundle"]): BundleResponse {
  if (!isObj(v) || !isObj(v.values)) bad("bundle");
  const o = v as Record<string, any>;
  // A job resolves exactly the version it was given, never "latest".
  if (o.id !== expect.id || o.version !== expect.version || o.sourceRevision !== expect.sourceRevision) bad("bundle (not the version the session was issued for)");
  for (const [k, val] of Object.entries(o.values)) if (!ENV_NAME.test(k) || typeof val !== "string") bad("bundle value");
  return o as BundleResponse;
}

export function checkPublication(v: unknown): PublicationResponse {
  if (!isObj(v) || typeof v.id !== "string" || typeof v.bundle !== "string" || !Number.isSafeInteger(v.version) || !["active", "pending", "failed"].includes(String(v.status)) || typeof v.replayed !== "boolean") bad("publication");
  return v as unknown as PublicationResponse;
}

// ── Workload claim rules ───────────────────────────────────────────────────

/**
 * What one environment's bundle allows: exact, immutable identities where
 * GitHub provides them (numeric repository and owner ids rather than names that
 * can be transferred), the reviewed reusable workflow pinned to a commit, and
 * the protected environment.
 */
export interface WorkloadPolicy {
  issuer: string;
  audience: string;
  repositoryId: string;
  repositoryOwnerId: string;
  environment: string;
  /** Allowed refs, e.g. refs/heads/main. */
  refs: string[];
  /** Allowed events. pull_request and pull_request_target are refused regardless. */
  events: string[];
  /** The reusable deployment workflow, owner/repo/path@<40-hex commit>. Matched against job_workflow_ref. */
  jobWorkflowRef: string;
  /** Seconds of clock skew tolerated on iat and nbf. */
  skewSeconds: number;
  /** The longest token lifetime accepted (exp - iat). */
  maxLifetimeSeconds: number;
}

export type ClaimDecision = { allow: true } | { allow: false; code: SecretsErrorCode; reason: string };

const REQUIRED = ["iss", "aud", "sub", "exp", "iat", "jti", "repository_id", "repository_owner_id", "environment", "ref", "event_name", "job_workflow_ref"] as const;

/**
 * Decides whether already signature-verified claims may receive this
 * environment's bundle. Fails closed: a missing claim is a denial, never a
 * default. `seen` reports whether this token id was already exchanged (replay).
 */
export function checkClaims(policy: WorkloadPolicy, claims: Record<string, unknown>, nowSeconds: number, seen: (jti: string) => boolean): ClaimDecision {
  const deny = (code: SecretsErrorCode, reason: string): ClaimDecision => ({ allow: false, code, reason });
  for (const k of REQUIRED) if (claims[k] === undefined || claims[k] === null || claims[k] === "") return deny("invalid_token", `missing claim ${k}`);
  if (claims.iss !== policy.issuer) return deny("invalid_token", "issuer");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (aud.length !== 1 || aud[0] !== policy.audience) return deny("audience_mismatch", "audience");
  const [exp, iat, nbf] = [claims.exp, claims.iat, claims.nbf ?? claims.iat].map(Number);
  if (![exp, iat, nbf].every(Number.isSafeInteger)) return deny("invalid_token", "times");
  if (exp <= nowSeconds) return deny("token_expired", "expired");
  if (iat > nowSeconds + policy.skewSeconds || nbf > nowSeconds + policy.skewSeconds) return deny("invalid_token", "issued in the future");
  if (exp - iat > policy.maxLifetimeSeconds) return deny("invalid_token", "lifetime");
  if (String(claims.repository_id) !== policy.repositoryId) return deny("policy_denied", "repository");
  if (String(claims.repository_owner_id) !== policy.repositoryOwnerId) return deny("policy_denied", "owner");
  if (["pull_request", "pull_request_target"].includes(String(claims.event_name))) return deny("policy_denied", "pull request");
  if (!policy.events.includes(String(claims.event_name))) return deny("policy_denied", "event");
  if (claims.environment !== policy.environment) return deny("policy_denied", "environment");
  if (!policy.refs.includes(String(claims.ref))) return deny("policy_denied", "ref");
  if (!/@[0-9a-f]{40}$/.test(policy.jobWorkflowRef)) return deny("policy_denied", "policy's workflow isn't pinned to a commit");
  if (claims.job_workflow_ref !== policy.jobWorkflowRef) return deny("policy_denied", "workflow");
  if (seen(String(claims.jti))) return deny("replay", "token already used");
  return { allow: true };
}
