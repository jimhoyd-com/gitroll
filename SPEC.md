# GitRoll format, template version 1

A log lives in an ordinary Git repository, in a folder called `.gitroll/`. It must stay readable and useful without GitRoll: every file is Markdown, YAML, or an unmodified original attachment, and the format is small enough to hold in your head.

The only thing you must do to log an event is create a Markdown file in `.gitroll/events/`.

## Layout

```
.gitroll/config.yaml                     required: template_version
.gitroll/README.md                       optional: how to log, for whoever opens the folder
.gitroll/events/2026-09-15-ac-serviced.md  one event per file
.gitroll/files/ac-receipt.pdf            files kept with events, created when first needed
.gitroll/templates/rental-inspection.md  optional: starting points this Roll offers
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
attachments:
  max_mb: 25              # optional per-file limit for new attachments
  remove_location: true   # optional; remove GPS data from photos (default true)
ai: true                  # optional; false turns off "Ask your Roll" for everyone
commit: auto              # optional; "manual" writes events without committing them
commit_prefix: ""         # optional; goes in front of every commit message GitRoll writes
```

`commit` says whether writing an event also commits it. `auto`, the default, commits each event as it is written. `manual` writes the file and stops: nothing is at risk, because the file is on disk before Git is asked anything, and a later `gitroll save` commits whatever is waiting. A log that shares a repository with a project is the case it exists for — there, a commit per event lands in the middle of somebody's branch and runs their hooks.

`commit_prefix` is used exactly as written, spaces included, in front of the message GitRoll writes for its own commits: `commit_prefix: "chore(gitroll): "` produces `chore(gitroll): log: replaced the tap`. GitRoll's own word (`log:`, `edit:`, `delete:`, `move:`) still follows it, so which kind of change it was is not lost.

`templates.built_in` says which of the writer's own built-in templates a Roll keeps: `all` (the default), `none`, or a list of their names and group names. It is about what a writer offers, not about what is in the repository.

These keys describe how a writer behaves rather than what a file contains, so a reader that doesn't know them still reads every event correctly.

## `.gitroll/templates/` (optional)

Starting points for new events, as ordinary Markdown files. Most Rolls have no such folder.

```markdown
---
label: Rental inspection      # optional; defaults to the file name, made readable
description: What you checked # optional; the line shown under the label
tags: [inspection, rental]    # optional; written into the front matter of events started from it
aliases: [inspect]            # optional; other names a writer may accept for it
---

# {{title}}

## Checked
```

- **A template's identity is its file name**, slugified: `rental inspection.md` is `rental-inspection`. There is no id field, as there is none for an event.
- **Front matter is optional.** A file with a heading and some prose is a valid template.
- **`{{title}}` is the only substitution.** A writer replaces it with whatever the person typed; everything else is copied as written.
- **A template is never read back.** An event started from one is an ordinary event, with no record of where it came from, and its headings are the author's to delete.
- **A Roll's own template replaces a built-in of the same name**, for that Roll. Writers that ship built-in templates offer the Roll's own first.
- Templates are not events: they live outside `.gitroll/events/`, so a reader that knows nothing about them ignores the folder entirely.

`.gitroll/theme.css` (optional) overrides the app's style variables. See docs/TEMPLATES.md.

### Template versions

`template_version` says which revision of the template a repository follows. It describes the repository, not the app, so a new GitRoll release never changes it.

- **Version 1** is this document.
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
