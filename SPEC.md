# GitRoll format, template version 1

A log lives in an ordinary Git repository, in a folder called `.gitroll/`. It must stay readable and useful without GitRoll: every file is Markdown, YAML, or an unmodified original attachment, and the format is small enough to hold in your head.

The only thing you must do to log an event is create a Markdown file in `.gitroll/events/`.

## Layout

```
.gitroll/config.yaml                     required: template_version
.gitroll/README.md                       optional: how to log, for whoever opens the folder
.gitroll/events/2026-09-15-ac-serviced.md  one event per file
.gitroll/files/ac-receipt.pdf            files kept with events, created when first needed
```

`.gitroll/` sits at the root of the repository, whether the repository exists only for the log or already holds a project. It is committed like any other source file.

**`.gitroll/` is a namespace, not a privacy boundary.** A log is exactly as visible as the repository it lives in: in a public repository, every event and every attachment in it is public.

Anything else in the repository belongs to whoever put it there. GitRoll reads and writes only `.gitroll/`, and commits only the files it wrote.

### Events

Any `.md` file anywhere under `.gitroll/events/` is an event. Subfolders are allowed and mean nothing to GitRoll: they are for people who like to organize.

An event's **identity is its path**. There is no id field, and nothing is required inside the file. Renaming an event is an ordinary `git mv`; Git history follows the rename.

### Files

Files kept with an event are ordinary files with readable names, linked from the event's Markdown with ordinary relative links:

```markdown
[Receipt](../files/ac-receipt.pdf)

![The leak](../files/leak.jpg)
```

There are no content hashes, no manifest, and no list of attachments in the front matter: what an event links to is what it has. A link is resolved relative to the event's own file, and only inside the repository — a link that climbs out of the root (`../../../etc/passwd`) or starts at `/` is not an attachment, and `gitroll check` reports it.

Writers must not overwrite a file that is already there: an app storing a second `ac-receipt.pdf` writes `ac-receipt-2.pdf`.

## The minimum event

`.gitroll/events/2026-09-15-ac-serviced.md`:

```markdown
# AC serviced

Replaced the capacitor. Paid $325.
One-year warranty on the repair.

[Receipt](../files/ac-receipt.pdf)
```

That is a complete, valid event. No front matter, no id, no author, no timestamps.

- **Title**: the first heading; failing that, the first line of text; failing that, the file name.
- **Date**: the `YYYY-MM-DD` at the start of the file name.
- **Tags**: any `#hashtag` in the text (not in code spans or fences).
- **Attachments**: the files it links to.

### Grouped logs

A Roll may keep one file per event (above) or group entries into shared monthly
or daily files. Both are the same format: an entry is Markdown with optional
YAML front matter, and only the file around it differs.

```
.gitroll/logs/2026/09.md          September 2026, first segment
.gitroll/logs/2026/09-002.md      …and the next one, once the first filled up
.gitroll/logs/2026/09/16.md       a daily Roll: 16 September 2026
.gitroll/logs/2026/09.md.gz       archived and compressed (optional)
```

The unnumbered file is segment one. Overflow numbering starts at `002`, is at
least three digits wide, and only ever increases; numbers are compared as
numbers. Nothing is renamed or renumbered when a segment is added or removed.

Inside a segment, each entry starts with an HTML comment carrying its permanent
id and runs until the next one:

```markdown
<!-- gitroll:entry 01K5F8ZC7M4Q0X2R9T6V3B1DHE -->
---
date: 2026-09-16T14:30:00-05:00
filed: 2026-09-16
created: 2026-09-16T14:31:02-05:00
---

# AC serviced

Replaced the capacitor.

[Receipt](../../files/ac-receipt.pdf)
```

- The marker is recognized only at the start of a line and only outside fenced
  code, so an entry body may contain headings, checklists, thematic breaks and
  code fences showing GitRoll markers. A writer that needs a literal marker at
  column 0 outside a fence indents it by one space; a reader removes that space.
- **`id`** is permanent and independent of the file name, title, date and
  position. It is a ULID: 26 characters of Crockford base32.
- **`filed`** is the calendar day the entry is filed under, decided in the
  Roll's time zone when the entry was created. It is a fact about the entry and
  does not change when the Roll's zone changes. **It is written only when the
  file name doesn't already say it**: a daily segment (`logs/2026/09/16.md`) is
  named for its filing day, so its entries omit the key and readers take the
  day from the path; a monthly segment knows only the month, so the day is
  written down. An entry that states `filed:` anyway is believed over its path.
- There is no `created` key. When an entry was written down is a question Git
  already answers, and the permanent id makes it answerable per entry:
  `git log -S<id>` finds the commit that added it, in whichever file it was in
  at the time. A `created:` written by an older GitRoll, or by hand, is read and
  preserved.
- Attachments stay in `.gitroll/files/`, linked relatively as always.
- An internal link to a grouped entry is an ordinary relative link with the
  entry's id as the fragment: `[the incident](09.md#gr-01k5f8zc7m4q0x2r9t6v3b1dhe)`.
  Readers resolve the id first and the path second, so a link survives rollover,
  migration, archival and compression. Links written before a Roll was grouped
  resolve through `.gitroll/moved.yaml`, which maps old event paths to ids.

Everything above `<!-- gitroll:entry … -->` in a segment is the file's header
and belongs to no entry.

`.gitroll/archive.yaml` records which filing periods are archived and whether
their files are compressed. `.gitroll/moved.yaml` records where migrated events
went. Both are versioned, small and hand-readable. Caches, indexes, locks and
temporaries are never committed: the local index lives in `.git/gitroll/`.

Which layout a Roll uses is `storage.mode` in `.gitroll/config.yaml`. A Roll
without that key stores one event per file, and stays that way until somebody
migrates it. See [docs/STORAGE.md](docs/STORAGE.md).

## Optional metadata

Front matter is optional. When it is there, it is YAML, and it may hold anything; these keys have meaning:

| Key | Meaning |
| --- | --- |
| `date` | When it happened. Overrides the date in the file name. |
| `projects` | List of project slugs (`projects: [house]`). Nothing declares a project: naming it is all there is to it. |
| `tags` | List of tags. Merged with any `#hashtags` in the text. |
| `amount` | A number. What totals add up. |
| `currency` | ISO 4217 code for `amount`, default `USD`. |
| `title` | Overrides the heading as the event's title. Rarely needed. |
| `source` | Where the event came from. An importer writes `{ adapter, id, url? }`, and `adapter` + `id` is unique within a log, so importing the same thing twice creates one event. An event about code writes `{ repo, branch, commit }`; see below. |

```markdown
---
date: 2026-09-15
projects: [house]
tags: [maintenance, warranty]
amount: 325
currency: USD
---

# AC serviced

Replaced the capacitor.

[Receipt](../files/ac-receipt.pdf)
```

Every other key is yours. **Writers must preserve keys they don't know**, along with the comments and formatting of the YAML they didn't change.

The CLI's optional `log --idempotency-key <key>` uses the existing source mapping:
`adapter: gitroll-cli`, `id: <key>`, and `request_hash: <SHA-256 of the creation request>`.
It may also include the code reference fields below. The same key and request
return the existing event, while a different request with that key is rejected.
This identity is scoped to events present on the current branch: moving or editing
an event preserves it; deleting the event or its source mapping releases it.
`request_hash` is an opaque implementation detail; readers can ignore it and
writers must preserve it. No format version change is required.

An amount written only in prose ("Paid $325") stays prose: GitRoll never extracts it, and no total counts it. If you want it counted, put it in `amount`.

## Code references

An event may say which repository, branch and commit it is about:

```markdown
---
source:
  repo: acme/app
  branch: fix/checkout
  commit: 9f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f60718293
---

# Checkout times out

Caused by the index dropped in 9f1c2d3, fixed in #412. Related: other/lib#88.
```

`repo` is `owner/repo` or any address Git understands (`git@github.com:acme/app.git`, `https://github.com/acme/app`). **This is the source repository — where the work happened.** It is not the repository the log lives in, and it is not the branch the log is on, even when they happen to be the same.

References in the text are ordinary text, and readers recognize them:

| Written | Means |
| --- | --- |
| `#412` | Pull request or issue 412 **in the event's own `source.repo`**. With no `source.repo`, it is shown as text and never linked to a guess. |
| `owner/repo#412` | 412 in that repository |
| `9f1c2d3` … `9f1c2d3e4a5b…` | A commit, 7 to 40 hex characters |
| `https://github.com/owner/repo/pull/412` | Whatever the URL says |

Code spans, fenced code and HTML comments are not prose, so a `#412` inside one is an example, not a reference.

## Links between events

An event links to another with an ordinary relative Markdown link:

```markdown
Follows [the incident on the 14th](2026-09-14-checkout-timeouts.md).
```

That link is the relationship, and the backlink is the same link read the other way round — worked out when it is needed, never stored. Nothing declares a relationship, and the link still resolves on GitHub and in a text editor.

## Dates

- A date is `2026-09-15`, or a full ISO 8601 timestamp when the time of day matters (`2026-09-15T14:30:00-07:00`).
- The date comes from the front matter if it has one, else from the `YYYY-MM-DD` prefix of the file name.
- **GitRoll writes the moment** into the front matter when it logs something, so that two events written on the same day can be told apart: the file name only carries a day, and without a time nothing records which came first. A date given by hand is kept exactly as given — no time is invented for it, and it is not repeated in the front matter when the file name already says it.
- **If neither supplies one, the event is undated.** That is a normal state, not an error: it shows as undated and is left out of date searches.
- Filters and grouping compare **calendar days as written**, so an event stays on the day its author put it on wherever the log is opened.
- Anything a reader can't parse as a date (`Sept 15`, `15/09/2026`) is reported by `gitroll check` rather than guessed at.

## `.gitroll/config.yaml`

```yaml
template_version: 1       # required: which template revision this repository follows
name: My Roll             # optional: the name shown in GitRoll
storage:                  # optional; absent means one file per event
  mode: monthly           # event | monthly | daily
  timezone: America/Chicago   # the one zone this Roll files entries in
  limits:
    max_bytes: 1048576    # rollover target, not a limit on what you may write
    max_entries: 1000
  archive:
    after_days: 0         # 0 = archive only when asked
    compress: false       # gzip archived segments
attachments:
  max_mb: 25              # optional per-file limit for new attachments
  remove_location: true   # optional; remove GPS data from photos (default true)
ai: true                  # optional; false turns off "Ask your Roll" for everyone
```

`.gitroll/theme.css` (optional) overrides the app's style variables. See docs/TEMPLATES.md.

### Template versions

`template_version` says which revision of the template a repository follows. It describes the repository, not the app, so a new GitRoll release never changes it.

- **Version 1** is this document. Grouped storage, archival and compression are
  *optional keys and optional files*: a reader of version 1 reads a per-event
  Roll exactly as before, and a Roll that has never been migrated is unchanged
  by this release. The version is therefore not incremented.
- It is **incremented only for published changes to the template's structure or conventions.** New *optional* keys (`source`, and anything else a writer preserves rather than requires) don't change it: a reader of version 1 still reads every file correctly, and bumping the version would stop older versions of GitRoll writing to a repository they understand perfectly well.
- Readers read it when they open a repository, and **preserve it** during ordinary logging and editing.
- **A missing marker means the version is unknown, not current.** Tools say so, explain how to record one (`gitroll template --set 1`), and must not write one on their own: a version an app only guessed at is not a fact about the repository.
- **A version newer than the reader understands blocks writes.** Nothing is changed, and the reader says the app needs updating.
- **Future upgrades are explicit and reviewable**, and the marker is updated only after the upgrade succeeds.

There is no per-event version field. An event is Markdown; it does not need one.

## Identity, history and simultaneous edits

- **Identity** is the file's path. It is readable, typeable, and needs nothing generated.
- **Renames and moves** are ordinary Git renames. A writer that moves an event rewrites the relative links in its body so they still resolve, and Git history follows the file.
- **Filename collisions**: a writer appends `-2`, `-3`, … before the extension. Two events logged the same day about the same thing become `2026-09-15-ac-serviced.md` and `2026-09-15-ac-serviced-2.md`. Nothing is overwritten, ever.
- **Edits** rewrite the file in place, each in its own commit. Git history is the audit trail: previous versions are never rewritten or force-pushed away by GitRoll.
- **Simultaneous edits** are merged as Markdown, line by line, the way Git merges any text file. That succeeds whenever two people touched different parts of the file. When the same lines changed on both sides, this device's version is kept as it is and the other version is appended in a note tagged `#conflict`, so nothing is lost and the conflict is easy to find.
- **Authors** come from Git: `git log` and `git blame` know who wrote what. Events carry no author field, so nobody can sign as someone else by editing a file.

## Reading a log

A reader:

1. Looks for `.gitroll/config.yaml` at the root of the Git repository (searching upwards from the current folder, so it works from a subfolder).
2. Checks `template_version` before writing anything.
3. Reads every `*.md` under `.gitroll/events/`, recursively.
4. Resolves each event's links relative to the event's own path.

Files it cannot parse are reported, not skipped silently, and never stop the rest of the log from loading.

## What is deliberately absent

No ids, no per-event version, no required timestamps, no author fields, no attachment manifests, no content-hash file names, no project definition files, no event type definitions, no mandatory folder structure. Every one of those was something a person would have had to produce before they could write down what happened.
