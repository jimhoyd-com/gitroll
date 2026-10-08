# GitRoll format, template version 1

A Roll lives in an ordinary Git repository, in a folder called `.gitroll/`: events (what happened), notes (pages kept up to date), to-dos (task-list lines in either), records (notes in a collection, with fields) and files. Everything else, the calendar, the ledger, inventory, contacts, organizations, places, pins and issues included, is read from those. It must stay readable and useful without GitRoll: every file is Markdown, YAML, or an unmodified original attachment, and the format is small enough to hold in your head.

The only thing you must do to log an event is create a Markdown file in `.gitroll/events/`.

## Layout

```
.gitroll/config.yaml                     required: template_version
.gitroll/README.md                       optional: how to log, for whoever opens the folder
.gitroll/AGENTS.md                       optional: the same, for an AI agent that opens the folder
.gitroll/events/2026-09-15-ac-serviced.md  one event per file
.gitroll/files/ac-receipt.pdf            files kept with events, created when first needed
.gitroll/files/passport.pdf.md           optional: a file's sidecar, its fields
.gitroll/files/walkthrough.mp4.001       a large file, kept in numbered parts
.gitroll/files/passport.pdf.age          optional: a sealed (age-encrypted) file
.gitroll/notes/wi-fi.md                  optional: pages kept up to date, one per file
.gitroll/templates/rental-inspection.md  optional: starting points this Roll offers
.gitroll/allowed_signers                 optional: who may sign this Roll's commits (ssh-keygen's format)
```

`.gitroll/` sits at the root of the repository, whether the repository exists only for the log or already holds a project. It is committed like any other source file.

**`.gitroll/` is a namespace, not a privacy boundary.** A log is exactly as visible as the repository it lives in: in a public repository, every event and every attachment in it is public, except what is sealed (see **Sealed content**).

Anything else in the repository belongs to whoever put it there. GitRoll reads and writes only `.gitroll/`, and commits only the files it wrote.

### Events

Any `.md` file anywhere under `.gitroll/events/` is an event. Subfolders are allowed and mean nothing to GitRoll: they are for people who like to organize.

An event's **identity is its path**. There is no id field, and nothing is required inside the file. Renaming an event is an ordinary `git mv`; Git history follows the rename.

### Notes

Any `.md` file anywhere under `.gitroll/notes/` is a note: a page that is kept up to date rather than a record of a moment — the Wi-Fi details, the paint colours, a runbook, a list of things to do. A note is read exactly as an event is (title, tags, projects, links, attachments, front matter) and its identity is likewise its path. The only differences are that a note's name carries no date and it isn't on the timeline. Git history is its record of what changed when.

Most Rolls start with no `notes/` folder; it is created when the first note is written.

### Records and collections

Any folder under `.gitroll/notes/` is a **collection**, and each `.md` file in it is a **record**: an ordinary note whose front matter holds its fields.

```
.gitroll/notes/books/README.md             optional: what the collection is for; not a record
.gitroll/notes/books/the-dispossessed.md   a record
```

```markdown
---
rating: 5
status: read
authors: [Ursula K. Le Guin]
finished: 2026-08-30
---

# The Dispossessed
```

- **Nothing declares a collection or its fields.** The folder is the collection; the keys its records happen to use are its columns. A record without a key has no value for it, which is not an error.
- A collection's name is its folder's path under `notes/` (`books`, `books/sci-fi`). Its `README.md` (in any case) describes it and is not one of its records.
- **A collection holds the folders under it.** `books` is the records in `notes/books/` and in every folder below it, so `books/sci-fi/dune.md` is a record of `books` and of `books/sci-fi`. A reader that reads one collection — a table of its records, the inventory, contacts, organizations, places — reads it this way, so moving a record into a sub-folder keeps it in every view it was in.
- A record is a note in every other way: same format, same identity (its path), searched by `find`, and edited like any other file.
- A writer that creates a record names the file after its title, as for any note, and heads it `# Title`.

### Files

Files kept with an event are ordinary files with readable names, linked from the event's Markdown with ordinary relative links:

```markdown
[Receipt](../files/ac-receipt.pdf)

![The leak](../files/leak.jpg)
```

There are no content hashes, no manifest, and no list of attachments in the front matter: what an event links to is what it has. A link is resolved relative to the event's own file, and only inside the repository — a link that climbs out of the root (`../../../etc/passwd`) or starts at `/` is not an attachment, and `gitroll check` reports it.

Writers must not overwrite a file that is already there: an app storing a second `ac-receipt.pdf` writes `ac-receipt-2.pdf`.

Every file under `.gitroll/files/` (subfolders included, and meaning nothing) is a file in the Roll whether or not anything links to it. A file that no event or note links to is **unfiled**: waiting to be described or linked, not an error.

#### Sidecars

A file's fields live beside it, in a Markdown file named after it with `.md` added: the **sidecar**.

```
.gitroll/files/passport.pdf
.gitroll/files/passport.pdf.md
```

```markdown
---
title: Passport
creator: U.S. Department of State
date: 2020-05-01
subject: [travel, id]
expires: 2030-05-01
---

Renewed at the post office. The old one is in the drawer.
```

- The file itself is never changed. Its sidecar is its record: front matter fields, and optional text under them.
- Field names are [Dublin Core](https://www.dublincore.org/specifications/dublin-core/dcmi-terms/)'s where one fits — `title`, `creator`, `date`, `subject`, `description` — and any other key is a field like any other (`expires`). `subject` is read as tags, alongside `tags`.
- A reader shows the sidecar's `title` (else its first heading, else the file's name) in place of the file name.
- `name.md` beside a file called `name`, or beside parts of it, is that file's sidecar; so is any `name.ext.md`, even before `name.ext` itself has arrived. A Markdown file kept as a file (`files/minutes.md`) is just a file, and its sidecar would be `minutes.md.md`.
- **A sidecar is not an event or a note.** It isn't on the timeline. It is a record a search can find, as `is:file`, with the same field queries as any other.
- It is read as a record wherever records are read for their dates and links: its dated fields are on the calendar (`expires` above is, as it would be on a note; see **Calendar fields** and **Reminders**), and its links count as a note's do, in what links back to a document and in what is at a place.
- A writer that creates a sidecar for a JPEG with no `date` may take the date from the photo's own EXIF `DateTimeOriginal`, as an ISO 8601 timestamp (with the camera's UTC offset when it recorded one).

#### Large files in parts

GitHub warns about a file over 50 MB and refuses one over 100 MB. A writer keeps a file larger than the Roll's part size (`part_size`, 45 MB by default) as numbered parts, using the volume naming of `split`, 7-Zip and HJSplit, and records the whole file in its sidecar:

```
.gitroll/files/walkthrough.mp4.001
.gitroll/files/walkthrough.mp4.002
.gitroll/files/walkthrough.mp4.003
.gitroll/files/walkthrough.mp4.md
```

```yaml
---
parts: 3
size: 132710400        # bytes, of the whole file
sha256: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
---
```

- Parts are numbered from `001`, three digits, in order; every part but the last is exactly the part size. There are at most 999.
- `sha256` is the hex digest of the whole file, as `sha256sum` prints it.
- **Links name the whole file** (`walkthrough.mp4`). A reader resolving a link to a file that isn't there, but whose `.001` is, reads the parts in order as that file. Only files under `.gitroll/files/` are read this way.
- Putting it back together needs nothing but a shell (`gitroll reassemble <file> --out <path>` does the same and checks the hash): `cat walkthrough.mp4.0* > walkthrough.mp4`, then `sha256sum walkthrough.mp4` to compare with the sidecar.
- `gitroll check` reports a missing part, parts whose sizes don't add up to `size`, and a `sha256` the joined parts don't match.
- Every part, like every file, stays in Git history for good. Splitting keeps each file under GitHub's limits; it doesn't make the repository smaller.

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

## Field queries

Every front matter key is a **field** that can be searched, compared and sorted. A field's type is read from its YAML value — there are no type definitions:

| Type | Written as |
| --- | --- |
| number | `rating: 5`, `weight: 2.5` |
| date | `expires: 2026-11-01`, or a full ISO 8601 timestamp |
| amount | `amount: 325` (with `currency`), or a currency sign and a number: `price: $12.50` |
| boolean | `read: true` |
| list | `authors: [Le Guin, Delany]`, or a block list; each element has its own type |
| text | anything else, and anything quoted (`rating: "5"` is text) |

A reader that supports searching should understand:

- `key:value` — text containing the value, ignoring case; a number, amount or boolean equal to it; a date starting with it (`finished:2026-08`). A list matches when any element does.
- `key>value`, `key>=value`, `key<value`, `key<=value` (also written `key:>=value`) — compares numbers and amounts numerically, dates by day (a partial date such as `2026-11` covers the whole period), and text alphabetically. A value of a different type never matches.
- `has:key` — the field has something in it: present, and not empty, an empty list or `false`.
- Keys match in any case. A few names keep the meaning they have always had in a search: `project`/`topic`, `tag`, `after`, `before`, `on`/`date`, `amount`, `has` and `is`; `title`, `date`, `amount`, `tags` and `projects` mean what a reader computes for the document (so `date` falls back to the file name).

A writer that sets a field edits the YAML in place: other keys, their order, comments and formatting, and the body are left as they were. That includes the spacing of flow lists: a file that writes `[bike]` keeps `[bike]`, one that writes `[ bike ]` keeps `[ bike ]`, and a list the writer adds is written the way the file's existing flow lists are. A value typed as text is parsed as a YAML scalar, so its type is the one YAML gives it — except a Markdown link (`[House](house.md)`, or one with more after it, as `org` has), which is written as the text it is: as YAML it would be a list followed by something else.

### Series

A number field kept over time (`odometer: 48210`, `weight: 72.4`, a meter reading) is a **series**: each dated event or note with a number in the field is a reading, on the day the document is dated. A document with the field but no number in it, or no date, isn't a reading and should be reported as left out rather than dropped silently. Grouped by day, week (ISO 8601), month or year, a series keeps the **last** reading in each period, since readings are levels, not quantities to add up. Amounts are compared only with amounts in the same currency, and never converted.

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

## To-dos

A to-do is a Markdown task-list item, the way GitHub writes one, in any event or note:

```markdown
- [ ] Call the plumber about the shutoff valve
- [x] Book the AC service
```

- Any list marker works (`-`, `*`, `+`, `1.`), indented or not. `[x]` and `[X]` are done; `[ ]` is still to do.
- Front matter, fenced code and HTML comments are not prose, so a `- [ ]` inside one is an example, not a to-do.
- **Ticking one off is an ordinary edit** that changes the one character between the brackets. Nothing else records it: when it was done, and by whom, is in Git history.
- A writer that adds a to-do without being told where puts it at the end of `.gitroll/notes/todo.md`, creating that note (headed `# To do`) the first time.

### Dated and recurring to-dos

A to-do is dated, and repeats, the way the [Obsidian Tasks](https://publish.obsidian.md/tasks/) plugin writes it, so the same line works in Obsidian as it is:

```markdown
- [ ] Renew passport 📅 2026-11-01
- [ ] Replace the HVAC filter 📅 2026-10-01 🔁 every 3 months
```

- `📅 YYYY-MM-DD` is when it is due. The words before the first Tasks emoji are what it says.
- `🔁 every <n> <day|week|month|year>(s)` repeats it (`every day`, `every 2 weeks`, `every month`); `when done` at the end counts from the day it is ticked off instead of from the due date. Tags after the rule are not part of it. Other Tasks phrasings (`every week on Monday`) are kept as written and not repeated by GitRoll.
- **Ticking off a repeating to-do** marks it `[x]` as usual and adds the next one on the line below: the same line, still to do, with its `📅` date moved on by the rule (and any `✅` done date left off). A month or a year on from a day the next month or year hasn't got (the 31st, 29 February) is that month's last day, as Obsidian Tasks does it. Both changes are one commit. Ticking it back on adds nothing.
- `⏰ YYYY-MM-DD HH:MM` is a reminder: see [Reminders](#reminders).
- A record (a note, in any collection) whose `quantity` has fallen to its `reorderAt` or below is listed as a **restock** to-do. That to-do is derived when the list is read, never written to a file, and goes away when `quantity` goes up.

## Calendar fields

An event or a note goes on a calendar with iCalendar's (RFC 5545) names for things:

| Key | Meaning |
| --- | --- |
| `start` | When it begins: an ISO 8601 date, or a timestamp (`2026-11-04T09:30:00-05:00`). A timestamp without an offset is local time wherever it is read. |
| `end` | When it ends, written the same way. A date `end` is the last day it covers. |
| `location` | Where: text, or a Markdown link to a place record. |
| `rrule` | How it repeats: an RFC 5545 RRULE, e.g. `FREQ=MONTHLY;INTERVAL=3`. |
| `remind` | When to be told about it: an RFC 5545 duration from `start`, or an ISO 8601 date-time; a list for several. See [Reminders](#reminders). |

```markdown
---
rrule: FREQ=MONTHLY;INTERVAL=3
start: 2026-10-01
---

# Replace HVAC filter
```

A reader that expands `rrule` should understand at least this subset: `FREQ` (`DAILY`, `WEEKLY`, `MONTHLY`, `YEARLY`), `INTERVAL`, `COUNT`, `UNTIL` (`20261231` or `20261231T235959Z`), and `BYDAY` with weekday names (`MO,WE,FR`) for `WEEKLY`; `WKST=MO` is the default and may be written. `COUNT` and `UNTIL` are not given together. As RFC 5545 says, a monthly rule on the 31st skips months without a 31st, and a yearly rule on 29 February happens in leap years only; `start` should be an occurrence of its own rule. A rule outside the subset is reported, not guessed at, and its `start` is still on the calendar.

What's on a Roll's calendar is derived, never stored, from events, notes and files' sidecars: every `start` and its repeats, every event dated ahead of today (an event with no `start` dated today is ahead only at a time still to come: one with no time, or a time already past, as a writer records the moment it logs, is a record of what happened, not something coming), every open to-do with a `📅` date, any date in a field named `warranty`, `expires`, `due` or `renewal`, and every year's `bday` and `anniversary` (see **Contact vocabulary**). A resolved issue's open to-dos, reminders and repeats are not on it (see **Issues**). An iCalendar export writes each `rrule` as an RRULE rather than a list of dates, gives each item a UID made from its file's path and which item of the file it is, and writes each reminder as a VALARM (see [Reminders](#reminders)).

## Reminders

A reminder is a time to be told about something. It is written with conventions that already exist, never a new one.

On a to-do line, it is the [Obsidian Reminder](https://uphy.github.io/obsidian-reminder/) plugin's, in the Tasks-style form that sits beside `📅` and `🔁`:

```markdown
- [ ] Call the dentist ⏰ 2026-11-01 09:00
- [ ] Pay the water bill 📅 2026-11-20 ⏰ 2026-11-19 18:00 🔁 every month
```

- `⏰ YYYY-MM-DD HH:MM` is the time, in local time. A day alone (`⏰ 2026-11-01`) is at 09:00, the plugin's default.
- The plugin's own form, `(@2026-11-01 09:00)` anywhere in the line, is read too. A writer writes `⏰`.
- `⏰` ends the words the way the Tasks emojis do.
- Ticking off a repeating to-do moves the copy's `⏰` by as many days as its `📅` moves, so it stays as far ahead of the due date.

On an event or a note, `remind` holds one value or a list of them, each either:

- an **RFC 5545 duration** (§3.3.6) counted from `start`: `-PT1H` is an hour before, `-P1D` a day before, `PT0S` at the start, `PT30M` half an hour after. A `start` that is a day counts from the beginning of that day. With an `rrule`, every occurrence has the reminder.
- an **ISO 8601 date-time**, `2026-11-01T08:00` (or with a space for the `T`), or a day alone, which is at 09:00.

```markdown
---
start: 2026-11-04T09:30:00-05:00
remind: [-P1D, -PT1H]
---

# Dentist
```

A duration with no `start` to count from, or a value that is neither, is reported rather than guessed at.

**Times.** A time without an offset is local time wherever it is read, as `start` is; one with an offset (`2026-11-01T08:00:00-05:00`) is that moment everywhere.

**Due.** A reminder is due from its time until what it is about is dealt with: the to-do is ticked off; the day of the event (or occurrence) is over, or its `end` has passed if that is later; or, for a `remind` on something with no `start`, the field is taken out. Nothing else is stored: there is no "dismissed" state in the files.

**Delivery.** GitRoll runs only when it is run, and nothing in a Roll can make a sound by itself. Reminders are delivered three ways, none of them a background process:

1. They are listed, due ones first, by `gitroll upcoming`, `gitroll reminders` and the browser app's **Upcoming** page, which can also show a browser notification for one that comes due while it is open, once the person has turned that on.
2. An iCalendar export writes each reminder as an RFC 5545 **VALARM** (`ACTION:DISPLAY`, a `TRIGGER` and a `DESCRIPTION`) inside its VEVENT or VTODO, so the calendar app that imports or subscribes to the file does the telling. A duration, and a local time beside a local or all-day `start` or `📅` date, is written as a relative `TRIGGER` (relative to the due date, `RELATED=END`, for a to-do), so it repeats with the RRULE and holds in any time zone. Any other time is an absolute `TRIGGER` in UTC; a local time is read in the time zone of the computer writing the file. A to-do with `⏰` but no `📅` is a VTODO with no `DUE` and an absolute alarm, and a note with a `remind` but no `start` is a VTODO with its alarms.
3. `gitroll reminders --due --json` lists what is due with a stable `id` for each, so a person's own scheduler or agent can run it and tell them, remembering which ids it has told.

Why these: `⏰` is what an Obsidian user already writes next to the Tasks plugin's `📅`, so the same line keeps working there; RFC 5545 durations and VALARM are what every calendar app already understands as a reminder, and `remind` names the field in the same plain way as `start` and `end`.

## Inventory vocabulary

Things are records with [schema.org](https://schema.org/Product) names for their fields. `.gitroll/notes/inventory/` is where a writer puts them by default, but any collection whose records use these keys reads the same way.

| Key | Meaning |
| --- | --- |
| `brand`, `model` | What it is |
| `serialNumber`, `gtin`, `sku` | Its numbers |
| `purchaseDate` | When it was bought (a date) |
| `price`, `priceCurrency` | What it cost each: a number and an ISO 4217 code, or money text like `$1,899` |
| `warranty` | The day its warranty ends (a date) |
| `location` | Where it is: text, or a link to a place record, `"[Garage](../places/garage.md)"` |
| `vendor` | Who it was bought from: text, or a link to an organization record, `"[Bolt Cycles](../organizations/bolt-cycles.md)"` |
| `quantity`, `reorderAt` | How many are left, and the number at which to buy more |

A place is a record too (`.gitroll/notes/places/garage.md`, see **Place vocabulary**), and its own `within:` link (or schema.org's `containedInPlace`) puts it inside another, so places nest: Shelf 2 within Garage within House. The value of a thing is `price` × `quantity` (a missing quantity counts as one), totalled per currency and never converted. Events that link to a thing are its history, read as backlinks.

A ledger view totals events' `amount` and records' `price` per currency in the same way; it is a source of transactions for an accounting tool (hledger, Ledger), not one itself. A record's `price` is left out of it when its purchase is an event that links to the record, in its text or a front matter field, and has an `amount`: that event is the transaction, and counting the price too would count it twice. The purchase is the event dated on the record's `purchaseDate` (whatever it cost: a deposit, a discount), or, when the record has no `purchaseDate`, the event whose `amount` is its price exactly, in the same currency. Any other event that links to it with an amount (a service, a repair) is a transaction of its own and leaves the price counted. A thing with a price and no purchase event is counted by its price, and its value in the inventory is its price either way.

## Contact vocabulary

People are records with [vCard](https://www.rfc-editor.org/rfc/rfc6350) (RFC 6350) property names for their fields, written lower-case as front matter keys are. `.gitroll/notes/people/` is where a writer puts them by default, but any collection whose records use these keys reads the same way.

| Key | vCard | Meaning |
| --- | --- | --- |
| *(the title)* | `FN` | The person's name, as they'd want it written. `fn` overrides it when the file's title is something else. |
| `n` | `N` | The name in parts, split by `;`: family; given; additional; prefixes; suffixes (`Lovelace;Ada`) |
| `nickname` | `NICKNAME` | What they're called; a list for more than one |
| `email`, `tel` | `EMAIL`, `TEL` | How to reach them: one value, or a list |
| `adr` | `ADR` | An address in vCard's seven parts, split by `;`: PO box; extended; street; locality; region; postal code; country (`;;1 Main St;Springfield;IL;62701;USA`). A list for more than one |
| `org` | `ORG` | Where they work, then its units, split by `;` (`Acme;Research`). The name may be a link to an organization record, `"[Acme](../organizations/acme.md);Research"`, which is a link like any other front matter link (see **Links between events**); vCard gets its text |
| `jobTitle` | `TITLE` | Their job title. schema.org's name, because `title` already means the record's own title |
| `role` | `ROLE` | What they do there |
| `bday`, `anniversary` | `BDAY`, `ANNIVERSARY` | A date (`1815-12-10`), or the month and day alone, as vCard writes them: `--1210` |
| `url`, `impp` | `URL`, `IMPP` | Web pages and messaging addresses: one, or a list |
| `categories`, `gender`, `note`, `uid` | the same | As vCard means them |

Every other key is yours. Events that link to a person, in their text or in a front matter field (`with: "[Ada](../../notes/people/ada.md)"`), are their history, read as backlinks, and the newest one is when they were last contacted. A `bday` or an `anniversary` is on the calendar every year, in any record: on 28 February in a year without a 29th when it is 29 February, and written to an iCalendar file as a yearly RRULE (`BYMONTH=2;BYMONTHDAY=-1` for 29 February).

A collection of people goes out as a vCard 4.0 file and comes in from a vCard 3.0 or 4.0 one:

- **Out**: a card per record: `VERSION:4.0`, `FN`, then a property per key above, in that order. A sealed value is never written as ciphertext: a writer holding a key that opens it writes it opened (the person with the key is exporting their own address book), and otherwise leaves the property out and says so. Lines end in CRLF and are folded at 75 octets (never inside a character), continuing with a space. Text escapes `\`, `,`, `;` and line breaks (`\n`), and a structured value (`n`, `adr`, `org`) escapes each part and joins them with `;`. Dates use vCard's basic form, `18151210` or `--1210`; a `bday` that isn't a date is written `BDAY;VALUE=text:`.
- **In**: a record per card, titled by its `FN` (else its `N`, its `ORG` or its `EMAIL`), with a field for each property above; a property given more than once is a list, except the ones vCard allows only once (`N`, `BDAY`, `ANNIVERSARY`, `GENDER`, `UID`). Parameters (`TYPE=work`) are not kept, and properties without a key here (`PHOTO`, `X-…`) are left out. A date comes in as `1815-12-10` or `--1210` (Apple's `X-APPLE-OMIT-YEAR` is read as no year).
- **Once only**: each record written by an import has `source: {adapter: vcf, id: <the card's UID, else its name as a slug>}`, and a card whose id is already in the collection is skipped, so importing the same file twice creates each person once.

## Organization vocabulary

Organizations are records with [schema.org](https://schema.org/Organization) Organization names for their fields. `.gitroll/notes/organizations/` is where a writer puts them by default, but any collection whose records use these keys reads the same way.

| Key | Meaning |
| --- | --- |
| *(the title)* | Its name (schema.org's `name`) |
| `legalName`, `alternateName` | Its registered name, and what else it is called (one, or a list) |
| `url`, `email`, `telephone` | How to reach it: one value, or a list |
| `address` | Where it is: text, or a mapping with schema.org's PostalAddress names (`streetAddress`, `addressLocality`, `addressRegion`, `postalCode`, `addressCountry`). A list for more than one |
| `foundingDate` | When it began (a date) |
| `sameAs` | Pages that say which organization this is: its Wikipedia or Wikidata page, a registry entry. One, or a list |
| `parentOrganization` | A link to the organization it is part of: `"[Acme](acme.md)"` |
| `location` | A link to a place record, as for a thing |

Every other key is yours. An organization's people are not listed in it: they are the records whose `org` (see **Contact vocabulary**) is a link to it, or whose `org` names it — its title, `legalName` or an `alternateName`, ignoring case — so a person's employer is written once, on the person, where vCard already puts it. A person whose `org` names exactly one organization in `.gitroll/notes/organizations/` is read as linked to that record; one it names twice is linked to neither. Its sub-organizations are the records whose `parentOrganization` links to it, and what it supplied the notes (things, usually) whose `vendor` links to it. Events that link to it, in their text or in a front matter field (`vendor: "[Acme](../../notes/organizations/acme.md)"`), are its history, read as backlinks, and the newest one is when it was last contacted.

Why these: schema.org is what the inventory already uses for things, and its Organization names are the ones search engines and the JSON-LD on organizations' own websites use. vCard can describe an organization (`KIND:org`), but has no names for what it is part of, when it began or where else it is described, which schema.org has. Reading a person's existing `org` rather than adding a list of members keeps a contact's vCard exactly what it was, and the membership in one place.

## Place vocabulary

Places are records with [schema.org](https://schema.org/Place) Place names for their fields. `.gitroll/notes/places/` is where a writer puts them by default, but any collection whose records use these keys reads the same way.

| Key | Meaning |
| --- | --- |
| *(the title)* | Its name (schema.org's `name`) |
| `address` | Text, or a PostalAddress mapping, as for an organization |
| `latitude`, `longitude` | Where it is on a map: WGS 84 decimal degrees, as numbers (`51.5014`, `-0.1419`) |
| `telephone`, `url` | How to reach it |
| `within` | A link to the place it is in: `"[House](house.md)"`. schema.org's `containedInPlace` is read when there is no `within` |

Every other key is yours. `within` nests places into a tree, and a chain that loops is cut where it would repeat. What is at a place is what links to it: a thing whose `location` links to it, a person, an organization or any other note that links to it in its text or a front matter field, and a file whose sidecar does. Events that link to it are what happened there, newest first; an event's `location` (see **Calendar fields**) may be such a link.

Why these: `latitude` and `longitude` are schema.org Place's own properties, and two plain numbers are what field queries (`latitude>51`) and sorting already understand, with nothing to parse; a writer shows them as an [RFC 5870](https://www.rfc-editor.org/rfc/rfc5870) `geo:` URI, `geo:51.5014,-0.1419`, which phones and map apps open. A `geo` key is read too, when there is no `latitude` or `longitude`, as schema.org's GeoCoordinates mapping (`{latitude, longitude}`) or a `geo:` URI as text, so either can be pasted in. `within` is the name the inventory already used before places had a view of their own, and stays the one a writer uses.

## CSV

A collection goes out to, and comes in from, a spreadsheet as CSV (RFC 4180): comma-separated, CRLF between rows, and a field holding a comma, a double quote or a line break in double quotes, each quote inside doubled.

- **Out**: a header row of `title` and then every field in use, one row per record. A list is written `[a, b]` (YAML's flow style), a mapping as JSON, anything else as written. A sealed field is written as its armored ciphertext, exactly as it is in the file: an export opens nothing, so the file is no more readable than the Roll, and an import brings it back sealed. A writer says when an export holds sealed fields.
- **In**: one record per row. The `title` column, else a `name` column, else the first, is the record's title; every other column whose header is a field name is a field. A cell that is a number (with no leading zero), `true` or `false`, or a `[list]` becomes one; anything else, dates included, is text. Empty cells write nothing.
- **Once only**: each record written by an import has `source: {adapter: csv, id: <its title as a slug>}`, the same mapping importers of events use, and a row whose id is already in the collection is skipped, so importing the same file twice creates each record once.

## Links between events

An event links to another with an ordinary relative Markdown link:

```markdown
Follows [the incident on the 14th](2026-09-14-checkout-timeouts.md).
```

That link is the relationship, and the backlink is the same link read the other way round — worked out when it is needed, never stored. Nothing declares a relationship, and the link still resolves on GitHub and in a text editor.

A front matter value that is exactly a Markdown link (`with: "[Ada](../notes/people/ada.md)"`, `location:`, `resolves:`) is a link in the same way, resolved against the document it is in; so is the link at the start of a value that goes on with `;` and more parts, as `org: "[Acme](../organizations/acme.md);Research"` does: what a document links to, and what links back to it, are read from its text and its front matter alike. `gitroll check` reports a link in either that leads to an event or a note that isn't there.

## Pins

An event or a note with `pinned: true` in its front matter is **pinned**: somebody wants it kept in view.

```markdown
---
pinned: true
---

# Where the stopcock is
```

- Only the boolean `true` pins, with the key in any case. Anything else, `pinned: false` and `pinned: "yes"` included, doesn't.
- A reader that lists events or notes in an order of its own (a timeline, newest first; the results of a search) lists the pinned ones first, under a heading that says so, each part in the order it would otherwise have, and doesn't repeat a pinned one in its usual place. An order the person asked for (`--sort`) is kept as asked.
- A writer pins by setting `pinned: true` and unpins by taking the key out, editing the YAML in place as for any field (see **Field queries**). Pinning never moves or renames a file.
- `is:pinned` in a search matches pinned documents.

## Issues

An **issue** is something that went wrong and stays open until it is dealt with: the car making a noise, a leak, a bug. It is an event or a note marked in its front matter:

| Key | Meaning |
| --- | --- |
| `issue` | `open` (in any case) or `true`: this is an issue. Any other value, `false` included, isn't read as one. |
| `resolved` | On the issue: it is resolved. A date (`2026-10-07`) says when; `true` says only that it is. |
| `resolves` | On a later event: a Markdown link to the issue it resolves, or a list of them. |

```markdown
---
issue: open
---

# Clunk from the front wheel
```

```markdown
---
resolves: "[Clunk from the front wheel](2026-09-20-clunk.md)"
---

# New sway bar link

The garage replaced the front left link. Quiet since.
```

An issue is **open** until either its own `resolved` has a value (anything but `false` or empty), or an event's `resolves` links to it. A link is read as front matter links always are: a value that is exactly `[text](target)`, resolved against the document it is in. Only an event resolves an issue: resolving is something that happened. A note's `resolves` is kept, and read as nothing.

What a reader works out, never stored:

- **Resolved by**: the events whose `resolves` links to it — the same link read the other way round, as a backlink is. A writer resolving an issue this way writes a new event and leaves the issue's own file as it was, so what fixed it is told once, in the event that fixed it.
- **Resolved on**: the earliest of its `resolved` date and the dates of the events that resolve it, when any of them has one.
- **Opened**: the issue's own date (see **Dates**). A note has none.
- **Age**: whole days from the day it was opened to today, or to the day it was resolved; unknown when either day is.
- **Activity**: every event that links to it, in its text or in a front matter field (`resolves` included), newest first; its last activity is the newest of those dates and its own.

A reader that lists issues shows open ones, newest activity first, unless asked for resolved ones too. `is:issue` in a search matches documents marked as issues, open or resolved.

**A resolved issue is dealt with.** A reader leaves its open to-dos, its reminders (`⏰` and `remind`) and the repeats of its `rrule` off the calendar, upcoming, reminders and an iCalendar export, and off a list of to-dos unless asked for everything. They stay in its file as written, and come back if it is reopened. A reader that shows an issue shows whether it is open or resolved, worked out as above, rather than its `issue` field, which says only that it is one.

Why these: an issue is a property of something already in the log, so it is a field on it rather than a new kind of file; `open` reads as what it means and `true` is what a person types when a flag is all they want. `resolves` is the word GitHub already reads in a pull request (`Resolves #12`) for the same relationship, and making it a link means it still resolves on GitHub and in a text editor.

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
part_size: 45MB           # optional; files larger than this are kept in numbered parts (at most 95MB)
commit: auto              # optional; "manual" writes events without committing them
commit_prefix: ""         # optional; goes in front of every commit message GitRoll writes
templates:
  built_in: all           # optional; "none", or a list of the writer's own templates to keep
filters:                  # optional; the searches this Roll wants a button for
  - today
  - label: Unpaid
    query: tag:unpaid
recipients:               # optional; who sealed content is encrypted to (see Sealed content)
  - age1609sgjxkf7z5uzak4ysaxrske8d759g6unmut6edp69gfrusgqtspkr7sf # laptop
```

`commit` says whether writing an event also commits it. `auto`, the default, commits each event as it is written. `manual` writes the file and stops: nothing is at risk, because the file is on disk before Git is asked anything, and a later `gitroll save` commits whatever is waiting. A log that shares a repository with a project is the case it exists for — there, a commit per event lands in the middle of somebody's branch and runs their hooks.

`commit_prefix` is used exactly as written, spaces included, in front of the message GitRoll writes for its own commits: `commit_prefix: "chore(gitroll): "` produces `chore(gitroll): log: replaced the tap`. GitRoll's own word (`log:`, `edit:`, `delete:`, `move:`) still follows it, so which kind of change it was is not lost.

`templates.built_in` says which of the writer's own built-in templates a Roll keeps: `all` (the default), `none`, or a list of their names and group names. It is about what a writer offers, not about what is in the repository.

`filters` lists the searches a Roll wants a one-click button for, in the order it wants them. An entry is either a name a writer knows (`today`, `this-month`, `this-year`, `has:photo`) or a `label` and a `query` of the Roll's own. An empty list means no buttons; leaving the key out means the writer's defaults.

`recipients` lists the public keys sealed content is encrypted to, one `age1…` X25519 recipient per item, with an optional label in a YAML comment. They are public: a recipient can only be encrypted to, never decrypt with. A Roll never contains a secret key.

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

## Sealed content

Part of a Roll can be **sealed**: encrypted so that only the Roll's recipients can read it. The format is [age v1](https://age-encryption.org/v1) (the C2SP age specification), unchanged, so a sealed part can be opened with the reference `age` tool and nothing from GitRoll. A writer must produce files any age v1 reader accepts; a reader must accept X25519 recipients and passphrase (scrypt) files.

There are three kinds, and everything that isn't sealed stays as readable as it always was.

**A sealed block** is a fenced code block with the info string `sealed`, holding an ASCII-armored age file:

````markdown
# Bank

Account 4417, First National.

```sealed
-----BEGIN AGE ENCRYPTED FILE-----
YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOSBrVTZpK0ErR3pnczZPaWx4
…
-----END AGE ENCRYPTED FILE-----
```
````

Its plaintext is Markdown: the lines it replaced, ending in a newline. Like any fenced code, a sealed block is not prose: nothing in it is a title, a tag, a to-do, a link or an attachment.

**A sealed field** is a front matter value that is an armored age file. It is written as a YAML literal block scalar, so the front matter stays valid YAML:

```yaml
pin: |
  -----BEGIN AGE ENCRYPTED FILE-----
  YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOSB1dTNXUFEvbkc0bnd1ZXdk
  …
  -----END AGE ENCRYPTED FILE-----
```

Its plaintext is the value written as YAML (`1234`, `"0042"`, `[a, b]`), so unsealing gives back the same type. `date` and `source` are never sealed: a reader needs them to know what the file is.

**A sealed file** is a file under `.gitroll/files/` whose name ends in `.age`: a binary age file whose plaintext is the file named without that suffix. `passport.pdf.age` is a sealed `passport.pdf`, and events link to it by that name. Its sidecar is named after it too, `passport.pdf.age.md`: a writer that seals or unseals a file renames its sidecar with it, and rewrites the links to either, in text and in front matter.

Armor is strict: 64-column lines of padded base64 between `-----BEGIN AGE ENCRYPTED FILE-----` and `-----END AGE ENCRYPTED FILE-----`, as `age --armor` writes it.

Who can read it:

- Sealed content is encrypted to every `recipients` entry in `config.yaml` at the moment it is sealed. Adding or removing a recipient later doesn't change what is already sealed until it is sealed again (`gitroll reseal`), and never changes earlier commits.
- Secret keys (age identities, `AGE-SECRET-KEY-1…`) are never in a Roll. They belong to the person, outside every repository.

What a reader does with it:

- **Without a key that opens it, a sealed part is shown as sealed** (`[sealed]`, or `{"sealed": true}` in JSON). It is never an error, and the rest of the file reads normally.
- A reader with a key may show it opened, but **never writes the plaintext back** unless the person explicitly asks to unseal it.
- **Search never indexes sealed content**, neither its ciphertext nor its plaintext.
- A writer keeps a sealed block or field byte for byte when it edits anything else in the file, so sealed parts survive ordinary edits, and merge line by line like any text.
- A writer that reports what it wrote reports it as a reader does: a sealed field is `{"sealed": true}` there too, never its ciphertext.

Sealing changes the current file only. **Text committed in plain before it was sealed is still in Git history**: a writer that seals something must say so, naming the commits, and must not rewrite history on its own.

## Identity, history and simultaneous edits

- **Identity** is the file's path. It is readable, typeable, and needs nothing generated.
- **Renames and moves** are ordinary Git renames. A writer that moves an event or a note rewrites the relative links in it, in its body and its front matter, so they still resolve, and the links to it in every other event, note and sidecar, in their text or their front matter (a `resolves:`, a `location:`, an `org:`), so they still lead to it. Git history follows the file.
- **Filename collisions**: a writer appends `-2`, `-3`, … before the extension. Two events logged the same day about the same thing become `2026-09-15-ac-serviced.md` and `2026-09-15-ac-serviced-2.md`. Nothing is overwritten, ever.
- **Edits** rewrite the file in place, each in its own commit. A writer that replaces a document's text keeps the `# Title` heading it starts with, unless the new text starts with a `# ` heading of its own, so new words don't rename it by accident. Git history is the audit trail: previous versions are never rewritten or force-pushed away by GitRoll.
- **Simultaneous edits** are merged as Markdown, line by line, the way Git merges any text file. That succeeds whenever two people touched different parts of the file. When the same lines changed on both sides, this device's version is kept as it is and the other version is appended in a note tagged `#conflict`, so nothing is lost and the conflict is easy to find.
- **Authors** come from Git: `git log` and `git blame` know who wrote what. Events carry no author field, so nobody can sign as someone else by editing a file.
- **Agents** are recorded the same way. A writer acting for an AI agent ends the commit message with a Git trailer, `Gitroll-Agent: <name>` (one line), and writes nothing about it into the file. Readers that show history may show it; nothing else depends on it.
- **A trailer is a claim; a signature is the proof.** Anyone can type a trailer. A commit signed with Git's own commit signing, by a key the Roll lists as `agent:<name>`, proves the agent made it. A commit whose trailer names one agent and whose good signature is a different agent's (`agent:<other>`) is a mismatch, and checkers flag it. A good signature by a listed person, not an agent, vouches for the agent's change: the person stands behind it, and it passes. When the Roll has `allowed_signers`, a commit signed by a key it doesn't list fails. A trailer on an unsigned commit is only a claim, not an error.

## `.gitroll/allowed_signers` (optional)

Who may sign this Roll's commits, in the ALLOWED SIGNERS format of `ssh-keygen(1)`, the same file Git reads as `gpg.ssh.allowedSignersFile`. Each line is a principal (or a comma-separated list), optional options, and a public key:

```
# Who may sign this Roll's commits.
you@example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI…
"agent:Claude Code" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI…
```

- **People** are listed by email, **agents** as `agent:<name>`, where `<name>` is exactly the name in their `Gitroll-Agent:` trailer. A principal containing a space is quoted.
- It is committed with the Roll, so anyone with a copy can check who signed what with Git alone: `git -c gpg.ssh.allowedSignersFile=.gitroll/allowed_signers log --show-signature`.
- It holds **public keys only**. A private key never belongs in a Roll.
- It is only as trustworthy as whoever can commit to the Roll: someone who can push can add their own key. Review changes to it as you would any change to who has access.
- No hashes are added beyond Git's own: every file and commit is already named by its hash, and each commit names the one before it.

## Reading a log

A reader:

1. Looks for `.gitroll/config.yaml` at the root of the Git repository (searching upwards from the current folder, so it works from a subfolder).
2. Checks `template_version` before writing anything.
3. Reads every `*.md` under `.gitroll/events/`, recursively.
4. Resolves each event's links relative to the event's own path.

Files it cannot parse are reported, not skipped silently, and never stop the rest of the log from loading.

## What is deliberately absent

No ids, no per-event version, no required timestamps, no author fields, no attachment manifests, no content-hash file names, no project definition files, no event type definitions, no collection schemas or field type definitions, no mandatory folder structure. Every one of those was something a person would have had to produce before they could write down what happened.

The sidecar of a file kept in parts is the one narrow exception: its `parts`, `size` and `sha256` are a manifest of sorts. They are there because a file in parts is the one place where Git's own hashing doesn't vouch for what a person gets back — Git checks each part, but nothing else says how many parts there should be or that joining them gives the file that went in. The writer produces them; a person never has to, and a file small enough to keep whole has none.
