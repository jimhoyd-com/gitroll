# Gitroll Vault architecture and implementation plan

Status: implementation proposal, 11 October 2026. The user selected a CLI-first release covering both personal passwords and developer secrets. Browser autofill, mobile apps, a vault GUI, and public multi-tenant hosting are outside the first release. OpenBao is the recommended hosted backend; it is not an existing Gitroll dependency or deployed service.

Build one product with two explicit trust boundaries: a local personal vault whose keys remain with the user, and an optional hosted service trusted to release selected deployment secrets. Never give the hosted service a personal vault key. Publishing selected values is an explicit transfer between these domains.

## Repository fit

Baseline reviewed: Gitroll 0.8.0, commit aa29ecc43bcea4557b3dd81c6bc8289ee34dd5d7. Recheck current code before implementation.

Existing foundations include records, fields, events, files, Git synchronization, conflict handling, age encryption, import deduplication, and agent commit signing. Relevant modules are `src/core/age/`, `src/core/sealed.ts`, `src/core/adapter.ts`, `src/node/sealing.ts`, `src/node/fs-safe.ts`, `src/node/repo.ts`, `src/node/mcp.ts`, and the CLI command contract. Existing tests cover age, sealing, MCP, and security.

Current sealing uses Roll-wide recipients and local identity files. A vault needs separate keys, protected unlocking, authenticated state, and access enforcement. Existing sealed content and its compatibility must remain intact.

Keep the vault's portable model in platform-free core modules. Put filesystem, OS key storage, process execution, and broker transport in Node modules. A login remains a record, a secure note remains Markdown, an attachment remains a file, and a rotation can create a redacted event. The security envelope is a deliberate exception to optional schemas: version, IDs, revisions, and authenticated state are mandatory.

CONTRIBUTING.md excludes hosted services from this repository. Implement the local vault, client integration, protocol contracts, and fixtures here. Implement the gateway as a separate service; resolve its repository before writing hosted production code. Do not quietly introduce a production server into the core package. The combined product release still requires the hosted milestones below.

## Formats and compatibility

| Format or service | Decision | Reason |
| --- | --- | --- |
| age | Personal item encryption and an optional SOPS recipient backend | Existing interoperable foundation; does not itself provide authorization or sender identity |
| SOPS | Git-managed static developer-secret bundles | Established encrypted structured documents; key names and structure may remain visible |
| KDBX4 | First-release password import and export | Portable rich password database; whole-database encryption is awkward for Git concurrency |
| 1PUX | First-release import | Current 1Password export path; source archives contain plaintext |
| OPVault | Deferred legacy import | Compatibility demand only; no native storage or export investment |
| pass | Deferred import and export | Useful per-entry Git precedent; GPG and loose field conventions need explicit mapping |
| OpenBao | Recommended separate hosted execution backend | JWT authentication, policies, versioned storage, audit facilities, and dynamic credentials |

Use maintained implementations and compatibility fixtures. Follow repository dependency and licensing rules. Review any new runtime dependency before adoption; do not assume an external service's license permits bundling its code. Do not implement a new cipher, JWT verifier, KDBX parser, or SOPS implementation to avoid dependency review.

## Personal storage and synchronization

Default to a separate private Roll with a dedicated vault subtree. Use opaque random filenames, one age-encrypted complete item per file. Its plaintext is a versioned Markdown/front-matter record with stable ID, kind, title, fields, notes, revision, and attachment references. Encrypt titles, URLs, usernames, custom fields, import metadata, and attachment names as well as values.

Maintain an encrypted catalog and an authenticated inventory of ciphertext hashes. Define canonical serialization and signing rules in the format specification before implementation. Authenticate vault ID, item ID, revision, key epoch, parent snapshot, and ciphertext membership. Bind attachment references to their encrypted objects. Reject substitutions, missing objects, duplicate IDs, unsupported critical versions, and tampered inventories.

Encryption does not authenticate an author: anyone possessing a public recipient key can encrypt. Use a reviewed signature mechanism for snapshots and enroll its trust root outside the repository. A new clone cannot authorize its own recipients or signers. Persist the last accepted snapshot outside Git to detect rollback; new devices obtain a trusted checkpoint during enrollment. Document that full rollback of both local state and Git cannot be detected without an external checkpoint.

Encrypt before any working-tree write, use atomic replacement, and require expected revisions for edits. Different-item changes can merge; same-item changes require explicit resolution after unlock. Never line-merge ciphertext. Define crash recovery for multi-file updates and reject incomplete snapshots.

Search only in the unlocked broker's memory. Do not feed decrypted records into ordinary search, caches, event adapters, telemetry, Git diffs, or saved previews. Git still reveals counts, sizes, and activity timing. Do not claim metadata-free storage.

## Keys and recovery

Use an independent random age identity per vault. Encrypt its key bundle to enrolled device recipients and an offline recovery recipient. Protect device private keys using OS secure storage. Where unavailable, support a clearly documented passphrase-encrypted identity using age's standard scrypt mode; never silently fall back to an unencrypted key file.

Keep passphrase wrapping separate from multi-recipient wrapping: standard age scrypt files cannot combine a passphrase recipient with other recipients. Use fresh file-key material for every encryption through the existing age interface, subject to interoperability and independent security review.

Separate unlock-password changes, device removal, and external credential rotation. Removing a device requires rotating the vault identity and re-encrypting current items. Previously copied keys and historical ciphertext remain readable. Rotate affected external passwords or tokens after compromise. Rewrapping the same vault key is not device revocation.

Enrollment requires a trusted device or recovery key. Recovery must work on a clean device using documented encrypted backup and offline recovery material. A service account reset cannot recover a personal vault. Explain this during initialization and verify the recovery kit before considering setup complete.

Lock on explicit request and idle timeout; handle broker crashes and OS sleep according to a documented policy. Minimize secret copies and clear buffers where practical, without promising complete erasure in JavaScript memory.

## CLI and broker

Proposed commands, subject to consistency with the existing command catalog:

```sh
gitroll vault init personal
gitroll vault unlock personal
gitroll vault add personal --kind login
gitroll vault list personal
gitroll vault edit personal <item-id>
gitroll vault reveal personal <item-id> --field password
gitroll vault run --grant <grant-id> -- <command>
gitroll vault lock personal
gitroll vault import personal --format kdbx <file>
gitroll vault export personal --format kdbx <destination>
gitroll secrets publish --environment staging
gitroll secrets run --environment staging -- <deploy-command>
```

Accept secret values through hidden prompts or standard input, never command-line arguments. List and JSON outputs omit values by default. Reveal and plaintext export are explicit operations. Noninteractive calls return structured errors instead of unexpectedly prompting. Do not put secrets in exception messages or subprocess diagnostics.

A local broker owns unlocked keys across CLI invocations. Use a protected local socket or equivalent platform transport, authenticated sessions, restrictive permissions, and bounded idle lifetime. Keys never pass to CLI clients. Protocol requests carry an authenticated principal, operation, resource scope, and expected revision where applicable. Define maximum message sizes and rate limits.

`run` passes values only to the selected child via a pipe or scoped environment, avoids shell interpolation, propagates signals and exit status, and cleans up. Environment injection is not protection against the child or a compromised same-user process. Do not promise general stdout redaction; a child can encode and print secrets.

## Agent access

Grants specify principal, vault and item scope, allowed fields, operation, expiry, use count, and approved destination. Offer opaque handles and use operations before raw reveal. Authentication must not rely on an agent-supplied name or commit trailer.

A request broker restricts destinations, redirects, methods, and relevant request fields. A process grant to an arbitrary executable is effectively secret disclosure; stronger use-only guarantees require a controlled executable and sandbox or a narrowly defined remote operation. A same-user agent with unrestricted shell access can bypass local controls. Document this boundary and use OS isolation for strong enforcement.

MCP tools are generated from the CLI catalog. Default every vault command to excluded and explicitly expose only approved broker-backed operations. Test catalog changes so a new command cannot accidentally expose values or keys. Agent signatures prove provenance, not permission.

Grant expiry revokes future broker access. It cannot expire a static value already revealed; only provider rotation or temporary credentials can do that.

## Hosted publication and execution

Start single-tenant with OpenBao behind a thin Gitroll control layer. Operate OpenBao independently, with TLS, protected administration, tested backups, documented unseal or auto-unseal recovery, audit storage, monitoring, and upgrade procedures. Separate publisher permissions from runtime read permissions. No root token in GitHub Actions.

| Data | Authority |
| --- | --- |
| Personal passwords | Encrypted personal Git vault |
| Static deployment secrets | Approved SOPS document in Git |
| Active deployment bundle | Gateway activation record |
| Dynamic credentials | Issuing backend |
| Authorization policy | Separately approved control configuration |
| Security audit | Restricted external audit store |

An authorized publisher verifies an approved source revision, decrypts SOPS in its trusted runtime, writes a complete immutable bundle to OpenBao, and atomically activates it only after all writes succeed. Use compare-and-swap for activation. Publication is idempotent by source revision and bundle identity. Specify rollback approval and prevent old application commits from silently restoring old secrets.

Treat a bundle as the minimal runtime access unit; split it when consumers require different scopes. Do not put unrelated consumers' values in one KV object then rely only on client filtering. A running job resolves one bundle version consistently. Dynamic credentials bypass Git value storage; Git holds references and approved role configuration only.

Runtime jobs cannot request arbitrary branch ciphertext or activate policy. Policy updates require a separately protected administration path. Initially integrate one provider for static secrets; add a dynamic provider only after the static path passes acceptance.

Hosted secrets are accessible to the trusted execution service. KMS and encrypted storage do not make this zero-knowledge. Gateway compromise does not expose personal vaults because it never holds their keys.

## GitHub Actions OIDC

A deployment job requests `id-token: write`, obtains a GitHub OIDC token for the configured Gitroll audience, and exchanges it with the gateway for a narrowly scoped session or direct bundle delivery. No long-lived Gitroll bootstrap secret is stored in GitHub.

Use a maintained JWT implementation and validate the exact issuer, audience, signing algorithm, signature through trusted discovery/JWKS, expiry, issued-at and not-before with bounded skew. Enforce immutable repository and owner IDs, environment, ref, event type, and approved workflow identity. Missing required claims fail closed. Establish actual claim fixtures from the supported GitHub environment; do not assume all token configurations use the same subject layout.

Prefer a reviewed reusable deployment workflow pinned to an immutable commit. Validate caller context and `job_workflow_ref`/appropriate workflow claims. Deny pull-request jobs by default and never run untrusted checkout content after acquiring deployment credentials. OIDC establishes job identity, not code safety; protected environments and workflow review remain necessary.

Choose a short session lifetime, bounded by deployment needs; use exchange replay tracking through token expiry and define safe retry semantics. Pin action versions. Avoid credentials in outputs, logs, arguments, caches, and artifacts. Masking is secondary defense. Gateway or validation failure stops deployment; no automatic fallback to broad cached credentials.

Inventory existing GitHub secret names and recreate or rotate values at their sources: the Secrets API does not recover their plaintext. Migrate staging first, verify success and denial cases, then migrate production. Remove obsolete GitHub Secrets only after verification and explicit cutover. GitHub's built-in GITHUB_TOKEN and credentials required before job execution are separate concerns.

## Import and export

Ship native encrypted backup/restore, KDBX4 import/export, 1PUX import, and SOPS interoperability. Explicit plaintext JSON/CSV export is allowed with clear destination handling and restrictive permissions. Defer pass and OPVault until after the initial release unless migration demand changes priority.

Provide dry-run counts, duplicate decisions, attachment handling, unsupported-field reports, and explicit loss reports. Preserve unmapped fields inside encrypted extensions. Do not claim round-trip support for unsupported passkeys or proprietary fields. Use resource limits for archives, reject path traversal and symlinks, and never execute OPVault JavaScript. Transform in memory where practical and write ciphertext directly. Do not promise secure deletion of temporary data on SSDs.

## Threat model

| Threat | Mitigation | Remaining limit |
| --- | --- | --- |
| Git or backup theft | Client encryption and separate keys | Metadata and offline password guessing |
| Malicious repository writer | Authenticated inventory and enrolled trust | Freshness needs trusted checkpoints |
| Device compromise | Secure storage, locking, rotation | Unlocked endpoints expose accessible secrets |
| Compromised CI job | Minimal bundles and exact workload policies | Released static secrets can be copied |
| Hosted service compromise | Least privilege, isolation, auditing | Hosted plaintext is in its trust boundary |
| Agent prompt injection | Broker restrictions and OS isolation | Unrestricted same-user shell can bypass policy |
| Plaintext persistence | Encrypt before writes and safe output defaults | Historical exposure requires credential rotation |
| Service outage or data loss | Recovery drills and fail-closed execution | Deployments depend on availability |

Security audit events record principal, decision, policy version, source revision, bundle version, and run identity without values or raw identity tokens. Ordinary Roll events contain only redacted references. Keep audit storage access-controlled and independent of application Git write access.

## Implementation milestones

One product release includes both domains. Milestone completion is incremental and must not be described as full product completion.

1. **Contracts and fixtures.** Specify the vault envelope, signing and enrollment, key lifecycle, snapshot updates, broker protocol, hosted API, and errors. Add synthetic compatibility and adversarial fixtures. Reconcile the roadmap with this approved local vault expansion while preserving the separate hosted-service boundary.
2. **Personal vertical slice.** Implement init, protected unlock, add, list, edit, explicit reveal, run, lock, encrypted backup, and clean-device recovery. Default secret handling stays outside MCP. Prove no plaintext in Git or ordinary outputs.
3. **Synchronization.** Add authenticated inventory, expected revisions, atomic snapshot recovery, conflict resolution, device enrollment/removal, key epochs, and rollback detection. Test two-device workflows and interrupted writes.
4. **Hosted service.** Implement approved SOPS publication, immutable OpenBao bundles, atomic activation, authorization, audit, backup/restore, and a separately deployable staging service. Client and protocol integration live here; service code lives in its designated repository.
5. **GitHub Actions.** Implement OIDC exchange and process injection. Demonstrate a real staging deployment with no GitHub-stored Gitroll bootstrap secret; verify wrong-repository, wrong-workflow, expired-token, replay, PR, and cross-scope denials.
6. **Interoperability and agents.** Complete KDBX4, 1PUX, and SOPS paths, dry-run and loss reports, scoped grants, broker restrictions, and explicit MCP exposure. Add an OpenBao-backed temporary credential provider if within release scope; do not imply static KV values expire with sessions.
7. **Release hardening.** Complete independent security review, fix critical findings, exercise recovery and rotation, document operations and known limits, and pass both personal and deployment journeys. Do not call an unaudited prototype production-ready.

Target meaningful tests: reference age interoperability, malformed ciphertext, resource exhaustion, recipient substitution, forged snapshots, cross-item swaps, stale snapshots, deletion, path traversal, crash recovery, concurrent edits, lock expiry, leakage through errors, MCP exposure, JWT claim validation, policy changes, cross-tenant denial, and publication retries. Use only synthetic secrets in fixtures.

Run the repository-required `make check` for implementation PRs, plus focused tests for changed behavior. Do not substitute mocked OIDC or a local KV fixture for the final live staging acceptance. Record unavailable external checks as remaining work rather than claiming they passed.

Planning estimate: 12–20 weeks for two experienced engineers plus external review scheduling; revise after the first vertical slice. Browser autofill, mobile, passkey storage, enterprise sharing, and multi-tenant SaaS are not included.

## Builder handoff

Start with milestones 1 and 2 in a feature branch, preserving unrelated work and existing sealed-content compatibility. Read repository instructions, SPEC.md, SECURITY.md, CONTRIBUTING.md, the command catalog, and relevant tests. Select narrowly scoped interfaces from actual code rather than implementing a generic plugin framework.

Commit coherent, reviewable changes and update this checklist as evidence is obtained. Continue to subsequent milestones when dependencies are available. If the separate hosted repository or real deployment credentials are unavailable, finish the local vault, contracts, integration client, fixtures, and deployment instructions; explicitly identify the external blocker. Never invent deployed services, OIDC results, or completed security review. No production deployment, secret migration, destructive history rewrite, or credential revocation without specific authorization.

## References

- [age format](https://age-encryption.org/v1)
- [SOPS documentation](https://getsops.io/docs/)
- [KDBX format](https://keepass.info/help/kb/kdbx.html)
- [pass](https://www.passwordstore.org/)
- [1Password export](https://support.1password.com/export/)
- [OPVault design](https://support.1password.com/opvault-design/)
- [OpenBao JWT authentication](https://openbao.org/docs/auth/jwt/)
- [OpenBao KV v2](https://openbao.org/docs/secrets/kv/kv-v2/)
- [GitHub OIDC reference](https://docs.github.com/en/actions/reference/security/oidc)
- [GitHub reusable workflows and OIDC](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-with-reusable-workflows)
- [GitHub Secrets API](https://docs.github.com/en/rest/actions/secrets)
