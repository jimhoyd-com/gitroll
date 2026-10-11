# GitRoll Vault format and protocols, version 1

This is the contract for GitRoll Vault: what a vault's files contain, how they are signed and checked, how keys live and change, how devices join and leave, how two devices' changes merge, how the local broker is spoken to, and what errors mean. The code that implements it is `src/core/vault/` (platform-free) and `src/node/vault/` (disk, Git, keys, broker). The two change together. The plan behind it is [plans/VAULT.md](plans/VAULT.md); the security boundaries are in [SECURITY.md](../SECURITY.md#vault). The hosted gateway for deployment secrets is a separate service with a separate trust boundary: its contract is [SECRETS-GATEWAY.md](SECRETS-GATEWAY.md).

Nothing here is a new cryptographic primitive. Encryption is [age v1](https://age-encryption.org/v1) (X25519, ChaCha20-Poly1305, HMAC-SHA-256, scrypt for passphrases), using GitRoll's existing age implementation, which interoperates with the reference `age` tool. Signatures are Ed25519 (RFC 8032) and hashes SHA-256, both from the platform (Node's OpenSSL). What is GitRoll's own is the layout, the canonical encoding, and the rules below.

## Layout

A vault lives in a Roll, under `.gitroll/vault/<name>/`. The name is not secret: keep it generic (`personal`, `work`). A separate private Roll for a vault is recommended.

```
.gitroll/vault/personal/
├── state.json                 the signed trust chain and the signed snapshot (public data)
└── objects/
    ├── <sha256>.age           the key bundle (age, to every member)
    └── <sha256>.age           one item per file (age, to the vault key)
```

- `state.json` is the only file ever replaced. Every object is named by the SHA-256 (lowercase hex) of its exact bytes and never changes.
- Nothing else belongs in the folder. `gitroll vault check` reports anything else, and every reader refuses symbolic links.
- Titles, usernames, URLs, field names, notes and all values are inside item objects. What Git still shows: the vault's name, how many items and members it has, each object's size, and when things change. That is metadata, not nothing.

## Canonical encoding

Signed and hashed values are encoded as canonical JSON: [RFC 8785 (JCS)](https://www.rfc-editor.org/rfc/rfc8785) restricted to objects, arrays, strings, safe integers, booleans and null. Keys are sorted by UTF-16 code units, there is no whitespace, strings are escaped as JSON.stringify escapes them. A non-integer number is not encodable.

- The **hash** of a record is SHA-256 of its canonical JSON, signature included, as lowercase hex.
- A **signature** is Ed25519 over the UTF-8 bytes of a context line followed by the canonical JSON of the record without its `sig`:
  - trust records: `gitroll-vault/v1 trust\n`
  - snapshots: `gitroll-vault/v1 snapshot\n`
- `sig` is the 64-byte signature in standard padded base64.

`state.json` itself is pretty-printed JSON; only the records inside it are canonicalized for hashing and signing. A reader interprets the parsed values the signature covers, so formatting, key order and duplicate keys in the file can't smuggle in unsigned meaning.

## Identifiers

- **Item and member ids**: 128 random bits as 26 characters of lowercase RFC 4648 base32 (`[a-z2-7]{26}`).
- **Vault id**: the hash of the vault's first trust record (64 hex characters). It can't be chosen, and anyone holding it can check the whole trust chain from the start.

## state.json

```json
{
  "gitroll_vault": 1,
  "vault": "<vault id>",
  "trust": [ <trust record>, … ],
  "snapshot": <snapshot>
}
```

`gitroll_vault` other than 1, or any key not listed here or below, is **unsupported** (`VAULT_UNSUPPORTED`): a reader refuses rather than guess. The format has no optional unsigned fields.

### Trust records

```json
{
  "v": 1, "type": "trust", "seq": 0, "prev": null,
  "epoch": 1, "recipient": "age1…",
  "members": [
    { "id": "…", "role": "device",   "age": "age1…", "sign": "<base64 Ed25519 public key>" },
    { "id": "…", "role": "recovery", "age": "age1…", "sign": "…" }
  ],
  "created": "2026-10-11T15:00:00Z", "signer": "<member id>", "sig": "…"
}
```

- `recipient` is the vault key's age recipient for this `epoch`. Every item is encrypted to it.
- A member's `age` recipient is what the key bundle is encrypted to; its `sign` key is what it signs with. `role` is `device` (a computer that uses the vault) or `recovery` (the offline recovery kit).

A reader checks the chain from record 0:

1. Record *i* has `seq` *i* and `prev` equal to the hash of record *i*−1 (`null` for record 0).
2. Record 0 is signed by one of its own members; record *i* by a member of record *i*−1. The signer must also be a member of record *i* (a device can't remove itself).
3. Members are unique by id, age recipient and signing key; there is at least one device and at least one recovery member; at most 64 members.
4. A member's keys never change: a new key is a new member.
5. `epoch` starts at 1 and either stays the same or increases by exactly one. It increases exactly when `recipient` changes.
6. **Removing any member requires a new epoch.** Re-wrapping the same vault key to fewer members is not revocation: the removed member already has it.

### Snapshot

```json
{
  "v": 1, "type": "snapshot", "vault": "<vault id>", "seq": 4, "parent": "<hash of previous snapshot>",
  "trust": "<hash of the last trust record>", "epoch": 1,
  "keys": "<object hash of the key bundle>",
  "items": [ { "id": "…", "rev": 2, "object": "<object hash>" }, … ],
  "created": "…", "signer": "<member id>", "sig": "…"
}
```

A reader checks that:

- `vault` is the chain's vault id; `trust` is the hash of the **last** trust record; `epoch` is its epoch.
- The signer is a member of the last trust record, and the signature verifies.
- `seq` 0 has `parent: null`, and only `seq` 0 does.
- `items` is sorted by id with no duplicates (at most 20 000), each `rev` ≥ 1, no two items share an object, and no item points at the key bundle.

`parent` records lineage for people and tools; freshness is decided by pins (below), not by walking parents.

### Objects

An object's bytes must hash to its name and to the hash the snapshot lists; otherwise it was changed, replaced or truncated (`VAULT_TAMPERED`). Objects larger than 8 MiB are refused before hashing.

**Key bundle** — an age file encrypted to every member's `age` recipient, whose plaintext is the canonical JSON of:

```json
{ "v": 1, "type": "keys", "vault": "<vault id>", "epoch": 1, "identity": "AGE-SECRET-KEY-1…" }
```

A reader checks `vault` and `epoch` against the chain, and that `identity`'s recipient is the last trust record's `recipient`. Because members' recipients are public, anyone can wrap a key of their own choosing to them; this check is what refuses that.

**Item** — an age file encrypted to the vault recipient, whose plaintext is Markdown with YAML front matter:

```markdown
---
gitroll_vault: 1
type: item
vault: <vault id>
id: <item id>
rev: 2
kind: login
title: Bank
created: 2026-10-11T15:00:00Z
updated: 2026-10-11T15:20:00Z
fields:
  - name: username
    value: jim
  - name: password
    value: correct horse battery staple
    secret: true
---
Free-text notes.
```

- After decrypting, a reader checks `vault`, `id` and `rev` against the snapshot entry that pointed to it. The object hash already binds the bytes; these bind the meaning, so an object moved to another item, presented as another revision, or copied from another vault is refused even under a valid signature.
- `kind` is a label (`login`, `note`, `secret`, `card`, …), not a schema. Field names match `[A-Za-z_][A-Za-z0-9_.-]{0,63}`, are unique, and values are strings of at most 64 KiB. `secret: true` fields are omitted from listings.
- Front matter keys GitRoll doesn't know are kept as they are on every rewrite (an importer's extra fields). YAML aliases are refused.
- Importers keep what a vault item has no place for under one key per source, encrypted with the item: `keepass` (`uuid`, `group`, `tags`, `expires`), `onepassword` (`uuid`, `vault`, `category`, `tags`, and `unmapped` fields of types GitRoll doesn't read) and `sops` (`source`). A KeePass export uses `keepass` to restore groups, tags and entry ids.
- Anyone holding a vault key can open an item with `age -d -i <vault key file>`.

Attachments are not part of version 1. When added, an attachment will be its own object, referenced from the item by object hash and listed in the snapshot, so that it is bound to its item the same way.

## Freshness: pins and rollback

Encryption and signatures can't show that a copy is the latest one. Each device remembers, outside the repository, the last trust record and snapshot it accepted (its **pin**: `seq` and hash of each). Every read checks the state against the pin:

- The chain must contain the pinned trust record, at the pinned `seq`, with the pinned hash (a shorter chain, or a different record there, is a rollback or a fork).
- The snapshot's `seq` must be at least the pinned one; at the same `seq`, its hash must be the pinned hash.

Failures are `VAULT_ROLLBACK`, and nothing is written. A pin only moves forward.

A device with no pin (a clean device recovering) can't detect a rollback of both the repository and its backups. Enrollment hands the new device a checkpoint from a device that has one (below). A full rollback of every copy, including every device's local state, is not detectable without an external checkpoint; this is a documented limit.

## Writing

Every change is a new snapshot signed by a member, and, for membership changes, a new trust record:

1. Encrypt in memory. Nothing plaintext touches the disk.
2. Write each new object to a temporary name in `objects/` and rename it into place. An existing object is never overwritten (a damaged one, whose bytes don't match its name, is replaced).
3. Check `state.json` is still exactly the bytes the change was made from (otherwise refuse: something changed underneath), then write the new one to a temporary name, fsync, and rename it over the old.
4. Remove objects the new state doesn't refer to, and leftover temporary files.
5. Commit the vault's folder, and nothing else, with a message naming only the vault (`vault: update personal`), never an item.

An interruption leaves either the old state or the new one, plus at worst unreferenced objects and `.tmp-<16 hex>` files, which `vault check` reports and the next write removes before it commits. A new state that was written but not committed is the vault until then, and the next write commits it. There is no state in which `state.json` refers to an object that was not yet written.

**Expected revisions.** `edit` and `remove` carry the item revision they were made from (`--rev`); a different current revision is refused (`CONFLICT`). Each successful edit increments `rev` by one.

**Rotation.** `vault rotate` and every device removal make a new random vault key, a new trust record with `epoch + 1` and the new recipient, a key bundle for the remaining members, and re-encrypt every item to the new key (same `rev`), in one write.

## Two devices, one vault: merging

Objects never conflict in Git: they are named by content. Only `state.json` does, and it can't be line-merged. When `gitroll sync` meets a conflict in `.gitroll/vault/<name>/state.json`, it takes the other side's state and saves the common ancestor and this device's state (both public, signed) to `.git/gitroll-vault/<name>.merge.json`, outside the working tree. The next time the vault is unlocked, before anything else, the device merges:

- Both sides' states are authenticated, each against the ancestor's pin.
- If one side's trust chain extends the other's, the longer one is used. If both changed membership, the merge stops (`VAULT_INVALID`) and the person undoes one change.
- Items are merged three ways, by comparing decrypted content: changed on one side only → that side; changed identically → either; changed differently → the other device's version stays and this device's is kept beside it as a new item titled "… (conflict)" with `conflict_of: <id>` — never silently dropped; edited on one side and removed on the other → the edit.
- Items from an older epoch are re-encrypted to the current key.
- The result is a new snapshot with `seq` greater than both sides', `parent` = the other side's snapshot hash, signed by this device, checked against both sides' pins before it is written and committed.

## Keys and recovery

**Device key.** Each computer has one device identity, shared by every vault it belongs to: an age X25519 identity and an Ed25519 signing key. They are kept in GitRoll's settings folder, never in a Roll (writing them inside a Git repository is refused):

- `vault/device.json` — the public half and how the secret is protected (re-derived from the secret on unlock; never trusted on its own).
- `vault/device.age` — the secret, encrypted with age's passphrase (scrypt) mode at work factor 2^18; or, with `--protect keychain`, nothing on disk and the secret in the system credential store (macOS Keychain through `security`, the Secret Service through `secret-tool`, Windows DPAPI through PowerShell; the secret is passed on standard input, never as an argument). A missing or unreadable secret is an error, never a fallback to a plaintext key.
- `vault/vaults.json` — per vault: its name, its Roll's folder, this device's member id, the pin, and whether the recovery kit was checked. Nothing secret.

Changing the unlock passphrase (`vault passphrase`) re-protects the device key only. Removing a device is a membership change with rotation. Rotating a credential that a vault holds is done where it is used. These are three different operations.

**Recovery kit.** `vault init` makes a recovery member and writes its keys to a text file (mode 0600, refused inside a Git repository, never overwriting), meant to be printed or kept offline:

```
GitRoll Vault recovery kit, version 1
…
vault-name: personal
vault-id: <vault id>
member-id: <recovery member id>
age-identity: AGE-SECRET-KEY-1…
signing-key: <base64 Ed25519 seed>
…
```

Setup is not complete until `vault recovery-check` has opened the vault with the kit; `unlock` and `status` say so until then. `vault recover` uses the kit on a clean device: it authenticates the vault (from the Roll, or from a backup) against the kit's vault id, checks the kit is still a recovery member, opens the key bundle with it, makes this computer's device key, and adds it as a member in a trust record signed by the recovery key. A GitRoll account or service can't do this: nothing outside the kit and the members can open the vault.

**Backups.** `vault backup --out <file>` writes one age file encrypted to every member, holding `state.json` and every referenced object, base64-encoded in the canonical JSON of `{format: "gitroll-vault-backup", v: 1, name, vault, created, files}`. It adds no trust: restoring authenticates it like any other copy, and accepts only `state.json` and `objects/<sha256>.age` paths.

## Adding a device

1. On the new device, `vault device-request` prints a request — `gitroll-vault-device:` and the base64url canonical JSON of `{v: 1, id, age, sign}` — and a short code (the first 64 bits of the request's SHA-256, as four groups).
2. On a member device, `vault device-add <name> <request>` shows the same code for the person to compare, then adds the member in a new signed trust record, re-wraps the vault key to it, and prints a checkpoint — `gitroll-vault-checkpoint:` and the base64url canonical JSON of `{v: 1, name, vault, trust: {seq, hash}, snapshot: {seq, hash}}`.
3. After syncing, on the new device, `vault device-join <name> <checkpoint>` authenticates the vault against the checkpoint as its first pin, and checks it is a member.

A new clone can't authorize itself: the request only becomes membership when a member signs it, and the new device trusts what it receives only as far as the checkpoint a member printed.

## The local broker

`vault unlock` starts one background process per user (`gitroll vault __broker`) that holds unlocked keys in memory; every other vault command talks to it. Keys never leave it; values leave it only for `reveal` and `run`, by name.

**Transport.** A Unix socket at `<runtime>/broker.sock`, where `<runtime>` is `$GITROLL_VAULT_RUNTIME`, else `$XDG_RUNTIME_DIR/gitroll-vault`, else `<tmp>/gitroll-vault-<uid>`; the folder must be a real folder owned by this user with no group or other access (the socket is created with umask 0177). On Windows, a named pipe whose name derives from the settings folder. The broker writes a 256-bit random session token to `<runtime>/session` (mode 0600) after it listens.

**Messages.** One request per connection: a single line of JSON, at most 1 MiB, answered by a single line:

```json
{ "v": 1, "token": "<session token>", "op": "list", "vault": "<vault id>", … }
{ "ok": true, "result": … }
{ "ok": false, "error": { "code": "VAULT_LOCKED", "message": "…" } }
```

The token is compared in constant time. The principal is "the local user who can read the token file"; the protocol carries no agent-supplied identity. Operations: `ping`, `unlock {vault, passphrase?, timeout}`, `lock {vault?}`, `list {vault, query?}`, `get {vault, item, reveal?: [field], notes?}`, `resolve {vault, refs: [{item, field?}]}`, `add {vault, item}`, `edit {vault, item, rev, patch}`, `remove {vault, item, rev}`, `members {vault}`, `add-member {vault, member}`, `remove-member {vault, member}`, `rotate {vault}`. Requests for one vault run one at a time. A future grant-scoped principal (agents) adds a field; version 1 brokers refuse unknown protocol versions.

**Limits and locking.** At most 300 requests per 10 seconds and 32 connections. A wrong passphrase delays the next unlock attempt by 1, 2, 4… up to 30 seconds. Each vault locks after its idle timeout (default 15 minutes, at most 12 hours, reset by each request), on `vault lock`, and at once when the broker's 5-second timer finds a gap of more than a minute (the computer slept or the process was stopped). With nothing unlocked, the broker removes its socket and token and exits. If it crashes, its keys are gone with it: the vault is locked.

**Errors.** Messages never contain secret values. Unexpected failures are reported as `INTERNAL_ERROR` with a fixed message.

JavaScript can't guarantee erasure of memory: copies of keys and values may remain in the broker's heap until it exits and the operating system reuses the pages.

## `vault run`

`vault run <name> --env VAR=<item>[:<field>] … -- <command> [args]` resolves the values through the broker, starts the command directly (no shell, so nothing in its arguments is interpolated), with the values only in the child's environment, forwards SIGINT, SIGTERM and SIGHUP, and exits with the child's status (or re-raises its signal). The field defaults to the item's first secret field.

The child can read, copy and print what it is given; output is not redacted. Environment injection keeps values out of arguments and shell history, not away from the process that receives them.

## Agents and MCP

Vault and hosted-secret commands are never MCP tools: the catalog marks them `mcp: false`, and `mcp.ts` refuses any command named `vault…` or `secrets…` that isn't listed in `MCP_VAULT_ALLOWED`, which is empty in this version. A test fails if any such tool appears. Exposing one later requires a broker-side grant (principal, vault and item scope, fields, operation, expiry, use count, destination) and an operation that returns no secret value; until then, agents get no vault access through GitRoll. A same-user process with unrestricted shell access can still run `gitroll vault reveal` while a vault is unlocked: see SECURITY.md.

## Errors

| Code | Meaning |
| --- | --- |
| `VAULT_LOCKED` | Not unlocked, wrong passphrase, or too many attempts |
| `VAULT_TAMPERED` | A file failed authentication or is malformed: changed, replaced, truncated, missing |
| `VAULT_ROLLBACK` | Older than, or forked from, what this device last accepted |
| `VAULT_FORBIDDEN` | Not a member (or no longer), or signed by a non-member |
| `VAULT_UNSUPPORTED` | A version or field this GitRoll doesn't know |
| `VAULT_INVALID` | A request this vault can't carry out (unknown item, ambiguous title, bad input) |
| `CONFLICT` | The item changed since the given `--rev` |
| `NOT_FOUND` | No such vault on this device or in this Roll |

## Limits

| What | Limit |
| --- | --- |
| `state.json` | 4 MiB |
| One object | 8 MiB |
| Trust records | 4 096 |
| Members | 64 |
| Items | 20 000 |
| Fields per item | 200 |
| Field value | 64 KiB |
| Title | 1 024 characters, one line |
| Notes | 1 MiB |
| scrypt work factor read | 2^20 |
| Broker message | 1 MiB |

## Fixtures

`test/fixtures/vault/` is a synthetic version-1 vault with its recovery kit, made by `scripts/vault-fixture.ts`. Every key and value in it is public on purpose. `test/vault.test.ts` checks it still opens, alongside adversarial cases: forged and stranger-signed snapshots, recipient and key-bundle substitution, cross-item, cross-revision and cross-vault swaps, missing and truncated objects, duplicate and unsorted items, unknown versions and fields, YAML aliases, oversized input, trust-chain tampering, removal without rotation, epoch skips, rollback and forks, and interoperability with the reference `age` tool.
