# My Roll

A [GitRoll](https://github.com/jimhoyd-com/gitroll) log: a chronological record of what
happened, kept as ordinary Markdown files in this repository. Git and a text editor are all
you need.

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
tags: [house, maintenance, warranty]
amount: 325
currency: USD
---

# AC serviced

Replaced the capacitor.

[Receipt](../files/ac-receipt.pdf)
```

Tags are just words; nothing has to be defined anywhere first. `amount` and
`currency` are what totals add up, so an amount you want counted goes there. An amount written
only in prose stays prose.

The date comes from the file name unless the front matter says otherwise. If neither gives a
date, the event shows as undated. Subfolders under `.gitroll/events/` are fine: organize
whenever you feel like it.

## Using GitRoll (optional)

GitRoll is a reader and writer for this folder. It writes exactly the format above, and touches
nothing outside `.gitroll/`.

```sh
gitroll                                  # open the log for the repository you're in
gitroll log "AC serviced" ac-receipt.pdf # log an event, attaching a file
gitroll find "capacitor"                 # search
```

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
