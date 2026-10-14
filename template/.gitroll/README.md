# My Roll

A [GitRoll](https://github.com/jimhoyd-com/gitroll) Roll: a structured memory of what happened
(events), what you know (notes), what's left to do (to-dos) and what you keep (records and files),
kept as ordinary Markdown files in this repository. Git and a text editor are all you need.

## Log something

1. Create a Markdown file in `.gitroll/events/`, named with the date and what happened:

   ```
   .gitroll/events/2026-09-15-ac-serviced.md
   ```

2. Write what happened, and link any file you want to keep with it:

   ```markdown
   # AC serviced

   Replaced the capacitor. Paid $325.
   One-year warranty on the repair.

   [Receipt](../files/ac-receipt.pdf)
   ```

   Put the receipt itself in `.gitroll/files/` (create that folder the first time you need it).

3. Commit and push:

   ```sh
   git add .gitroll
   git commit -m "AC serviced"
   git push
   ```

That is the whole format. No front matter, no ids, no timestamps.

## Optional metadata

Add YAML front matter when you want totals, filters, or a date that differs from the file name:

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

Projects and tags are just words; nothing has to be defined anywhere first. `amount` and
`currency` are what totals add up, so an amount you want counted goes there. An amount written
only in prose stays prose.

The date comes from the file name unless the front matter says otherwise. If neither gives a
date, the event shows as undated. Subfolders under `.gitroll/events/` are fine: organize
whenever you feel like it.

Every front matter key is a field you can search and sort by (`rating>=4`, `expires<2027`). A
number kept over time, such as `odometer: 48210` or `weight: 72.4`, is a series you can chart.

## Notes, to-dos and records

Not everything is about a moment. A **note** is a page you keep up to date, a Markdown file in
`.gitroll/notes/` (`wi-fi.md`, `paint-colours.md`), with no date in its name.

A **to-do** is a task-list line in any event or note, written the way GitHub writes one. A date,
a repeat and a reminder are written the way Obsidian's Tasks and Reminder plugins write them:

```markdown
- [ ] Call the plumber
- [ ] Renew passport 📅 2026-11-01
- [ ] Replace the HVAC filter 📅 2026-10-01 🔁 every 3 months
- [ ] Call the dentist ⏰ 2026-11-01 09:00
```

A folder of notes is a **collection** and each note in it a **record**: `.gitroll/notes/books/dune.md`
with `rating: 5` in its front matter. Use whatever fields you like; nothing has to be declared.

## Calendar and reminders

An event or note with `start` (and optionally `end`, `location`, a repeating `rrule` and `remind`)
is on the calendar, using the names calendar apps already use:

```markdown
---
start: 2026-11-04T09:30:00-05:00
remind: [-P1D, -PT1H]
---

# Dentist
```

Dated to-dos, events dated ahead, and any `warranty`, `expires`, `due` or `renewal` date are on it
too, as are birthdays (`bday`). Nothing runs in the background: GitRoll lists what is coming up,
and exports the calendar, reminders included, for your calendar app to tell you.

## People, organizations, places and things

These are records in collections GitRoll knows the fields of, using names other apps already use.
Any fields you add are yours too.

| Folder | What | Fields from | Example fields |
| --- | --- | --- | --- |
| `notes/people/` | contacts | vCard | `email`, `tel`, `org`, `bday` |
| `notes/organizations/` | companies, clubs, shops | schema.org | `url`, `telephone`, `address` |
| `notes/places/` | places, nested with `within:` | schema.org | `address`, `latitude`, `longitude` |
| `notes/inventory/` | things you own | schema.org | `brand`, `model`, `price`, `warranty`, `location`, `quantity` |

Connect them with ordinary Markdown links, in the text or as a field:

```markdown
---
brand: Trane
location: "[Garage](../places/garage.md)"
vendor: "[Cool Air Co](../organizations/cool-air-co.md)"
warranty: 2031-06-01
---

# Furnace
```

Events that link to a record are its history: when you last saw someone, what was done to the
furnace, what happened at a place. Events' `amount` and things' `price` add up to a ledger.

## Pins and issues

`pinned: true` in an event's or note's front matter keeps it at the top of lists.

`issue: open` marks something that went wrong: the car making a noise, a leak. It stays open
until a later event says what fixed it with `resolves: "[Clunk from the front wheel](2026-09-20-clunk.md)"`,
or the issue itself gets `resolved: 2026-10-07`.

`archived: 2026-10-14` keeps something but out of the way: a contact you've lost touch with, a
thing you sold, a page that no longer applies. It drops off the timeline, searches, tables, to-dos
and the calendar until you take the key out; `is:archived` in a search finds it.

## Decisions

`decision: accepted` marks what was decided (or `proposed`, `rejected`, `deprecated`). A newer
decision that replaces it says so with `supersedes: "[Back up to the NAS](2025-03-01-back-up-to-the-nas.md)"`,
and the old one then reads as superseded. `gitroll decisions` lists what still stands.

## Time

`duration: PT1H30M` (or `1h30m`, `90m`) on an event is how long it took. `gitroll time --by project`
adds it up.

## Bookmarks

A web page worth coming back to is a record in `.gitroll/notes/bookmarks/`, titled with the
page's title:

```markdown
---
url: https://www.rfc-editor.org/rfc/rfc6350
tags: [contacts, standards]
description: vCard 4.0, the format contacts use
added: 2026-10-12
---

# vCard Format Specification
```

Events and notes that link to it are where it came up. A browser's bookmarks export comes in
with `gitroll import bookmarks`, and `gitroll bookmarks --html` writes one back.

## Files

Anything in `.gitroll/files/` is kept as it is, linked from an event or note or on its own. A
file's own fields go in a note beside it named after the file (`passport.pdf.md`, with
`title`, `expires` and so on). A file too large for GitHub is kept in numbered parts
(`walkthrough.mp4.001`, `.002`, …); `cat walkthrough.mp4.0* > walkthrough.mp4` joins them.

## Using GitRoll (optional)

GitRoll is a reader and writer for this folder. It writes exactly the format above, and touches
nothing outside `.gitroll/`.

```sh
gitroll                                  # open the Roll in your browser
gitroll log "AC serviced" ac-receipt.pdf # log an event, attaching a file
gitroll find "capacitor"                 # search
gitroll upcoming                         # what's coming up: dates, to-dos and reminders
gitroll mcp                              # let an AI agent use this Roll as tools
```

`.gitroll/AGENTS.md` tells an AI agent that opens this folder how the files work; `gitroll
agents-md --write` brings it up to date.

`.gitroll/config.yaml` records which template revision this log follows:

```yaml
template_version: 1
```

GitRoll reads it to know how to treat the repository, and never changes it while logging or
editing. Template upgrades are a separate, reviewable step.

## Who can read this

`.gitroll/` is committed like the rest of the repository, and it is a namespace, not a privacy
boundary. **This log is as visible as the repository it lives in:** in a public repository, every
event and every file here is public. Keep the repository private if what you log is private.

What must stay private even from people who can read the repository can be **sealed**: encrypted
with [age](https://age-encryption.org) to the public keys listed under `recipients:` in
`.gitroll/config.yaml` (`gitroll seal`). A sealed part shows as sealed to everyone without a key,
and the rest of the file reads normally. Passwords and developer secrets go in a **vault** under
`.gitroll/vault/` (`gitroll vault`), which is encrypted before anything is written. Secret keys
never go in the repository, and anything committed before it was sealed stays in Git history.
