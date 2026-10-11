# GitRoll secrets gateway

Deployment secrets for CI/CD jobs live behind a **separate trust boundary** from the personal vault ([VAULT-FORMAT.md](VAULT-FORMAT.md)). The personal vault is zero-knowledge to whoever stores it. The gateway is not: it holds deployment values in plaintext inside its own runtime, so a CI job can receive them without any long-lived secret stored in GitHub. It never holds a personal vault key, and nothing moves from a personal vault to it except by an explicit publication of an approved SOPS document.

This repository contains:

- the **protocol contract** (`src/core/secrets/protocol.ts`): request and response shapes, response checks, and the reference rules a gateway applies to a workload's identity claims;
- the **client**, `gitroll secrets run` and `gitroll secrets publish`;
- **fixtures and tests** (`test/fixtures/secrets/`, `test/secrets.test.ts`) that run the client against a **mock** gateway on 127.0.0.1.

The gateway service itself, its OpenBao deployment and its GitHub configuration are **not** here and **not deployed**. Nothing in this repository has exchanged a real GitHub OIDC token or read a real bundle. See [Remaining dependency](#remaining-dependency).

## API v1

All bodies are JSON. Errors are `{"error": {"code": "<code>", "message": "<text>"}}` with one of `invalid_request`, `invalid_token`, `token_expired`, `audience_mismatch`, `policy_denied`, `replay`, `environment_unknown`, `bundle_unavailable`, `conflict`, `unavailable`. Messages never contain values, tokens or claim contents beyond the name of the rule that failed.

### `POST /v1/exchange`

```json
{ "token": "<GitHub Actions OIDC JWT>", "environment": "staging" }
```

The gateway:

1. verifies the JWT with a maintained JWT library: signature against GitHub's published JWKS (fetched over TLS from the issuer's discovery document, cached, refreshed on unknown `kid`), algorithm `RS256` only, issuer exactly `https://token.actions.githubusercontent.com`, audience exactly the configured one (default `gitroll-secrets`), `exp`, `iat`, `nbf` with bounded skew;
2. applies the environment's workload policy with the same rules as `checkClaims` in the contract: every required claim present (missing is a denial, never a default), numeric `repository_id` and `repository_owner_id`, `environment`, an allowed `ref` and `event_name`, `pull_request` and `pull_request_target` always refused, `job_workflow_ref` exactly the policy's reusable workflow pinned to a 40-hex commit, and a bounded token lifetime;
3. records `jti` until the token's `exp` and refuses a second exchange (`replay`);
4. returns a short session bound to the **active bundle version at that moment**:

```json
{ "session": "<opaque>", "expiresAt": "2026-10-11T12:05:00Z",
  "bundle": { "id": "app", "version": 3, "sourceRevision": "<40-hex>" } }
```

Sessions last minutes, never hours, and are bound to that one bundle version.

### `GET /v1/bundles/{id}/versions/{version}`

With `Authorization: Bearer <session>`. Returns exactly the version the session was issued for, never "latest":

```json
{ "id": "app", "version": 3, "sourceRevision": "<40-hex>", "values": { "DEPLOY_KEY": "…" } }
```

Value names match `^[A-Za-z_][A-Za-z0-9_]{0,127}$`. The client refuses a response whose id, version or revision differs from the exchange's, and runs nothing.

### `POST /v1/publications`

From an authorized **publisher** job (a different workload policy from runtime jobs):

```json
{ "token": "<OIDC JWT>", "environment": "staging", "sourceRevision": "<40-hex>", "source": "secrets/staging.sops.yaml" }
```

The gateway verifies the token against the publisher policy, verifies that `sourceRevision` is an approved commit on the protected branch (via the GitHub API with its own read-only credential), fetches `source` at that commit, decrypts it with SOPS in its own runtime, writes a complete **immutable** bundle version, then activates it with a compare-and-swap on the activation record only after every write succeeded. Publishing the same `(environment, sourceRevision, source)` again returns the existing publication with `"replayed": true`. A revision older than the active one is refused unless a separate rollback approval exists, so an old application commit can't silently restore old secrets.

```json
{ "id": "pub_…", "environment": "staging", "bundle": "app", "version": 4,
  "sourceRevision": "<40-hex>", "status": "active", "replayed": false }
```

## Client

```sh
gitroll secrets run --environment staging --gateway https://secrets.example.com -- ./deploy.sh
gitroll secrets publish --environment staging --from secrets/staging.sops.yaml
```

- `--gateway` (or `GITROLL_SECRETS_GATEWAY`) must be `https://`; plain `http://` is accepted only to 127.0.0.1, `[::1]` or `localhost`, for a local test gateway. Credentials in the URL are refused. Redirects are refused.
- The OIDC token comes from `ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN`, which GitHub sets only when the job has `permissions: id-token: write`. Outside such a job the command stops before any request.
- `run` starts the command with no shell, adds the bundle's values to its environment, removes the two `ACTIONS_ID_TOKEN_*` variables from it so the child can't mint more tokens, forwards signals and exits with the child's status.
- Any failure (no token, gateway unreachable, refusal, malformed or mismatched response) stops with "Nothing was run". There is no fallback to other credentials.
- Tokens, sessions and values never appear in output, errors or arguments.

## Deployment (single tenant, OpenBao)

These are instructions for the separate gateway repository and its operator. None of it has been carried out.

### OpenBao

- Run OpenBao on its own host or cluster with TLS on every listener, administration reachable only from an operator network, and no root token kept after initial setup (generate one temporarily for break-glass, then revoke it).
- Storage: integrated Raft. Seal: auto-unseal through a cloud KMS, or Shamir with keys held by at least three separate people; document and rehearse the unseal procedure.
- Enable a file or socket **audit device** shipping to storage the gateway can't write or delete; audit logs contain HMACed values, never plaintext.
- Snapshots (`bao operator raft snapshot save`) on a schedule to separate storage, with a restore rehearsed into a scratch cluster before go-live and after every upgrade.
- KV v2 mount `gitroll/` with `cas_required=true`. Layout:
  - `gitroll/bundles/<environment>/<bundle>/v<version>`: written once, never updated;
  - `gitroll/active/<environment>`: `{bundle, version, sourceRevision}`, written only with CAS on its current version.
- Policies:
  - **publisher**: create on `gitroll/data/bundles/<env>/*`, CAS update on `gitroll/data/active/<env>`; no read of other environments, no delete, no policy or auth changes;
  - **runtime**: read on `gitroll/data/active/<env>` and `gitroll/data/bundles/<env>/*`; nothing else;
  - the gateway authenticates to OpenBao with AppRole or Kubernetes auth per role, never with a root token, and never passes an OpenBao token to a CI job.
- Policy changes go through a separately protected administration path (a reviewed configuration repository applied by operators), not through the gateway or any CI job.

### Gateway

- Implements the API above in front of OpenBao, using a maintained JWT library and the reference claim rules from `src/core/secrets/protocol.ts` (port or vendor that file; keep the fixture cases passing).
- One workload policy per environment and role, keyed by numeric repository and owner ids, environment, refs, events, and the reusable workflow pinned to a commit.
- Replay store for `jti` with expiry at the token's `exp`; sessions stored server-side with expiry of a few minutes.
- Security audit events, written to the restricted audit store: principal (repository id, workflow ref, run id, run attempt), decision and rule, policy version, environment, bundle id and version, source revision. Never values, sessions or raw tokens.
- Fail closed: an OpenBao, JWKS or audit-store failure is `unavailable`, never a partial bundle.

### GitHub Actions

A reviewed reusable workflow in a separate repository, referenced by commit SHA:

```yaml
# caller: .github/workflows/deploy.yml
jobs:
  deploy:
    uses: example-org/deploy-workflows/.github/workflows/deploy.yml@<40-hex commit>
    permissions:
      id-token: write
      contents: read

# example-org/deploy-workflows/.github/workflows/deploy.yml
on: workflow_call
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: staging          # a protected environment with required reviewers
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/checkout@<40-hex commit>
      - uses: actions/setup-node@<40-hex commit>
        with: { node-version: 22 }
      - run: npm install -g gitroll@<exact version>
      - run: gitroll secrets run --environment staging --gateway https://secrets.example.com -- ./deploy.sh
```

Never run on `pull_request` or `pull_request_target`, and never run checked-out untrusted code after the exchange. OIDC proves which job is asking, not that its code is safe: protected environments and workflow review stay necessary.

### Migration (staging first)

1. Inventory the GitHub Secrets each workflow uses (names only; the Secrets API can't return values).
2. Recreate or rotate each value at its source and put it in the environment's SOPS document; publish to staging.
3. Switch the staging workflow to `gitroll secrets run`; confirm a deployment succeeds.
4. Run the denial checks against staging: wrong repository, wrong workflow or unpinned workflow, wrong ref, `pull_request` event, expired token, replayed token, another environment's bundle, a session used for a different version. Each must be refused and audited.
5. Repeat for production, then remove the obsolete GitHub Secrets only after an explicit cutover decision.

## Remaining dependency

To finish milestones 4 and 5 someone with the access needs to provide:

1. a repository for the gateway service (the API above, OpenBao client, JWT verification, audit writer);
2. a staging OpenBao deployment and a host for the gateway, with TLS, audit storage and snapshots;
3. a GitHub repository and protected `staging` environment, plus the reusable workflow repository, to run the live exchange.

Live staging acceptance (a real deployment with no GitHub-stored GitRoll secret, and the denial checks above against real tokens) has **not** been done. The tests in this repository use a mock gateway and synthetic claims only.
