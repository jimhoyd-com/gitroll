# Storage, archiving and sync

A Roll is Markdown in a Git repository, and that does not change here. What
changes is how many entries share a file, what happens when a file gets big,
what "archived" means, and how two devices combine changes to a file they both
wrote in.

Everything below is decided by one set of rules in `src/core/` — the app, the
CLI, imports, sync and archival all call into it, so none of them can drift.

## How entries are stored

| Mode | Where an entry goes | Good for |
| --- | --- | --- |
| `event` | `.gitroll/events/2026-09-15-ac-serviced.md` | what every Roll did before this release; still fully supported |
| `monthly` | `.gitroll/logs/2026/09.md` | the default for new Rolls |
| `daily` | `.gitroll/logs/2026/09/16.md` | Rolls that fill a month in a day |

```sh
gitroll storage                       # what this Roll does now
gitroll storage --mode monthly --timezone America/Chicago
gitroll migrate --to monthly --dry-run   # move what's already here (preview first)
```

Existing Rolls keep their current mode. A configuration change decides where
*new* entries go; moving what is already stored is an explicit migration, and
readers handle a Roll that is half-migrated.

### Segments and rollover

One period can span several files:

```
.gitroll/logs/2026/09.md        segment one, always unnumbered
.gitroll/logs/2026/09-002.md
.gitroll/logs/2026/09-003.md
```

- A new segment starts when adding an entry would push the current one past
  **1 MiB of uncompressed content** or **1,000 entries**. Both are configurable
  (`--max-bytes`, `--max-entries`).
- These are rollover targets, not limits on what you may write. An entry larger
  than the whole target is written anyway, in a segment of its own.
- New entries always append to the **highest-numbered** segment of their period.
  Gaps are not filled and existing entries are never redistributed or repacked.
- An edit can leave a segment over target. The entry stays where it is; the next
  addition opens the next segment.
- Numbers are compared as numbers: `009`, `010`, `1000`.

Monthly grouping stays monthly however much arrives: a high-volume import
rotates into `09-002.md`, `09-003.md` and so on rather than switching to a
different scheme.

### Entries and ids

Inside a shared file each entry begins with a marker holding a permanent id, and
runs until the next marker. The exact syntax is in [SPEC.md](../SPEC.md). What
matters in practice:

- The id doesn't depend on the file name, the title, the date or the position,
  so rollover, migration, archival and compression never break a link.
- Links use the id as a fragment: `logs/2026/09.md#gr-<id>`. Readers resolve the
  id first and the path second. Links written before a migration resolve through
  `.gitroll/moved.yaml`.
- Two entries claiming one id are reported, never combined.

## Dates, time zones and filing

A Roll has **one** IANA time zone (`storage.timezone`). Every part of GitRoll
uses it, and none of them reads the device's zone.

- A **timed** entry keeps the moment it happened, offset and all. Its **filing
  date** is the day that moment falls on in the Roll's zone, written into the
  entry when it is created. `2026-10-01T02:00:00Z` is 30 September in
  `America/Chicago`, so it belongs in `logs/2026/09.md`.
- A **date-only** entry is a day somebody typed. No midnight is invented for it
  and no conversion may move it.
- **Ingestion time is recorded separately** (`created:`) and is never used as an
  occurrence. An import with no usable timestamp produces an undated entry and
  says so.
- **Backdating** files by occurrence, not by when you wrote it down.
- The filing date is **written into the entry only when the path can't state
  it**. `logs/2026/09/16.md` already names its day, so daily entries carry no
  `filed:` line; `logs/2026/09.md` names only the month, so monthly entries do.
  An entry that carries one is believed over its path, which is what keeps a
  file that was moved or renamed from silently re-filing what's inside it.
- **Changing the Roll's zone** affects new entries. Filing dates already written
  stay as they are unless you migrate them deliberately.
- **Editing an entry's date** recalculates its filing date in the current zone
  and moves the entry if the period changed — keeping its id, and its links.
- **Daylight saving** is answered explicitly. A local time that happened twice,
  or never happened, is reported rather than resolved in silence; GitRoll
  records which it chose.
- A date more than a year ahead is questioned rather than filed (`--allow-future`
  overrides), and an unparseable one is refused, never guessed at.

**Ordering in the interface** follows occurrence, not file order: newest first
by day; within a day, timed entries before date-only ones (a day without a time
cannot claim a position inside it); ties broken by id, which is stable
everywhere.

## Archiving

Archival status and compression are separate settings.

```sh
gitroll archive 2026-09 --compress
gitroll unarchive 2026-09          # also restores plain Markdown
gitroll unarchive 2026-09 --auto   # …and lets automatic archiving consider it again
gitroll storage --archive-after 365 --compress
```

- Archiving applies to a **whole filing period**, every segment together.
- Eligibility for automatic archiving is measured from the **end of the period**
  in the Roll's zone, not from any entry's age.
- Files stay where they are. Archived periods are left out of the timeline and
  out of search unless asked for (`gitroll find … --include-archive`), and the
  omission is stated rather than implied.
- Direct links to archived entries keep working.
- **Archiving never deletes anything** — not an entry, not an attachment.
- A period you unarchived by hand is left alone by automatic archiving until you
  restore that with `--auto`.
- A **late entry** for an archived period belongs to that period, inherits its
  policy (including compression), stays reachable immediately, and is shown as
  archived.

## Compression (optional)

```
.gitroll/logs/2026/09.md.gz
```

- Only archived periods are compressed, and only if you ask.
- Reading, searching and editing are transparent: a compressed segment is
  decompressed, changed and recompressed as one recoverable operation.
- Rollover targets are measured against **uncompressed** content.
- Output is deterministic (no timestamp, no OS byte), so re-archiving is not a
  spurious diff.
- There is never a moment where a compressed and an uncompressed copy both look
  authoritative; an interrupted run leaves exactly one readable file plus, at
  worst, a temporary that the next command sweeps.

**What gzip does and does not do.** It reduces what a checkout costs on disk. It
removes the Markdown preview and the readable diff on GitHub. It does **not**
erase history: every earlier, uncompressed version is still in the repository,
so compressing does not make the repository smaller. Separate archive
repositories, history rewriting and destructive retention are deliberately out
of scope.

## Sync

Sync understands entries, not lines. A shared monthly file that two people both
appended to has no real disagreement in it, and a line-based merge would say
otherwise.

Automatically merged:

- independent additions on both sides, each kept exactly once;
- changes to different entries;
- non-overlapping changes within one entry (front matter key by key, body only
  when at most one side touched it);
- moves, archival and compression, treated as storage changes rather than a
  deletion and a creation;
- the same overflow filename created on both sides — both sets of entries
  survive, filenames are preserved where possible, and unaffected historical
  segments are never repacked.

Reported as conflicts, never resolved silently:

- the same entry edited on both sides — both texts are kept, the other quoted
  under a `#conflict` note, exactly as a conflicted event has always been;
- edit versus delete;
- two sides filing one entry under different periods;
- two different decisions about archiving or compressing a period.

Conflicts appear in `gitroll conflicts` and in the app, sync does not report
success while any remain, and attachments are never deleted because one side
stopped linking to them. Compressed segments are decompressed and merged as
entries — a gzip stream is never merged as bytes — and recompressed only once
the content and the archival policy are settled.

Two-clone tests cover concurrent appends, overflow collisions, independent
edits, conflicting edits, edit-versus-delete, moves, archive-versus-edit,
compressed files and retried syncs (`test/sync-entries.test.ts`). **Automatic
compression is off by default**: it is enabled per Roll, deliberately, once you
want it.

## The index

`.git/gitroll/index.json` is a cache: ids, locations, dates, metadata, archival
state and enough text to list and filter.

- It is never committed, and can be deleted at any time — the next command
  rebuilds it from the repository.
- It is incremental: a segment is re-read only when its size or modification
  time changed, so an edit, an import or a sync costs the segments it touched.
- It notices external edits, moves, deletions, compression changes and changes
  that arrived through Git.
- Anything it cannot account for (an unreadable file, a duplicate id) is
  recorded, and the index reports itself as **incomplete** so no interface
  presents a partial result as a complete one.
- Storage does not depend on it: every write works with no index at all.

## Reliability

- **One local writer at a time.** Every write takes a lock in `.git/`
  (Git protects you from another *device*, not from another process here). A
  stale lock — a crashed process — is broken rather than inherited.
- **Whole-file, atomic writes.** Content is written to a temporary, made
  durable, and renamed into place. An interrupted write leaves the previous file
  intact.
- **Idempotent imports.** A record may carry a key; a key already in the Roll is
  skipped, so a retried batch adds nothing. Identical *content* is not a
  duplicate — two identical entries are two things that happened. Importers can
  record a checkpoint to resume from.
- **Batched writes.** A batch of backdated entries is grouped by destination, so
  each file is read and written once and an archived period is decompressed and
  recompressed once for the whole batch.
- **Corruption is isolated.** A segment that will not read is reported with its
  path, its bytes are left exactly as they are, and every other entry in the
  Roll still opens.
- **Saved, committed, synced are different states.** `gitroll status` shows
  uncommitted changes, commits not yet uploaded, and what has arrived.

## Reporting what things cost

```sh
gitroll usage
```

Entries and log files are counted apart from attachments, because attachments
dominate a Roll with photos in it and rollover has nothing to do with them. The
numbers describe the working copy. Git history keeps every earlier version, so
neither archiving nor gzip shrinks the repository.

## Scope, and what has not been proven

This is a logbook. Monthly grouping, rollover, ids, indexing and entry-aware
sync are designed so a machine-written feed *could* be stored the same way, and
the storage interface leaves room for an append-only JSONL profile
(`logs/2026/09.jsonl`, `09-002.jsonl`) sharing entry identity, filing dates,
monthly grouping, rollover, indexing and archival semantics — with batched
writes, per-writer segments for concurrent importers, and idempotent import
keys. Their naming and reconciliation rules will be defined before that profile
is implemented.

**Markdown is implemented; JSONL is not.** GitRoll does not claim to be suitable
for high-volume access logs: ingestion, search, sync and repository growth have
not been benchmarked at that scale. Raw-feed retention is a policy question of
its own — archival hides a period and compression makes a checkout smaller, and
neither bounds what a repository stores over time.
