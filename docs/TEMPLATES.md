# Templates and themes

## Starting points for an event

There are no event *types* — an event is a Markdown file, and what kind of thing it is, is whatever you wrote in it. What GitRoll has instead is a handful of starting points: headings worth answering for the kinds of event people write often.

```bash
gitroll log --template incident --editor "Checkout timeouts"
gitroll templates          # what there is
```

**For work in a repository:**

| Template | For |
| --- | --- |
| `debugging` | What broke, what you tried, and what it turned out to be |
| `incident` | What happened, how long it lasted, what fixed it, and what to change |
| `deployment` | What went out, where, and how it went |
| `experiment` | The question, what you did, and what it showed |
| `decision` (or `adr`) | The decision, the alternatives, and why |

**For everything else** — a Roll is a logbook before it is a developer tool:

| Template | For |
| --- | --- |
| `progress` (or `project`) | What moved, what's next, and what's in the way |
| `learning` (or `study`, `notes`) | What you were learning, what clicked, and what to come back to |
| `journal` (or `diary`) | What happened today. No shape to fill in — the heading is the day |
| `maintenance` (or `repair`, `service`) | What was done, to what, by whom, and when it's due again |
| `purchase` (or `bought`, `expense`) | What you bought, what it cost, and where the receipt is |

Nothing stops you using either list for anything: the grouping decides what is listed first, not what you're allowed to write. The app has the same two lists under **Template** in the composer. What comes out is ordinary Markdown: change the headings, delete the ones that don't apply, and nothing reads them back or expects them to be there.

`maintenance` and `purchase` both ask for a cost. Written into the composer — in the browser or the terminal — a sum like `$184.50` is offered as the event's **amount**, which is what makes it count in a total and answer `amount:>100`. A one-shot `gitroll log --template purchase` doesn't infer it, so pass `--amount '$184.50'` there if you want it counted. Either way the line stays in the text as you wrote it.

## Your own templates

The ten above are a starting point, not a fixture. A Roll's own templates are Markdown files in `.gitroll/templates/`, and they need nothing else to exist:

```markdown
---
label: Rental inspection          # optional; defaults to the file name, made readable
description: What you checked.    # optional; the line under the label in the menus
tags: [inspection, rental]        # optional; goes into the front matter of events you start from it
aliases: [inspect]                # optional; other names for --template
---

# {{title}}

## Checked

## Needs fixing
```

Save that as `.gitroll/templates/rental-inspection.md` and it appears at the top of `gitroll templates` and of the composer's **Template** menu, under **From this Roll**. The file name is its name (`rental inspection.md` works too — it becomes `rental-inspection`), `{{title}}` is replaced by whatever you typed, and everything else is copied as written. They are committed with the Roll, so everyone who clones it gets them.

**They are yours, so they win.** Name one after a template GitRoll ships — `incident.md` — and yours is what `--template incident` opens in that Roll. Nothing else changes: every other built-in is still there, other Rolls are unaffected, and renaming your file gives GitRoll's back. `gitroll templates` marks the ones standing in for a built-in so it is never a surprise.

**And you can keep as few of GitRoll's as you like:**

```yaml
# .gitroll/config.yaml
templates:
  built_in: none          # nothing but this Roll's own
  # built_in: [everyday]  # or one group
  # built_in: [decision]  # or one of them, by name
```

A Roll that says nothing gets all ten, as before. `gitroll check` reports a template file it can't read, and two files that would be the same template — the list itself never breaks: an unreadable file is left out and the rest still work.

## Your own kinds of event

Use tags for the ones you want to filter on:

```markdown
---
tags: [vehicle-service]
odometer: 42000
---

# Oil change at Jiffy

Changed the oil and the filter.
```

`odometer` is a key GitRoll knows nothing about, and that is fine: it is kept as written, shown on the event, and searchable as `odometer:42000`. Nothing has to be defined anywhere first, and no definition file has to exist for the event to make sense in five years.

## Roll templates

A template is a starting point for new Rolls: a README, a theme and the template marker. It never contains events or files.

Create a Roll from one, using a folder or a GitHub repository:

```bash
gitroll new "Maple Street rental" --template ~/Templates/rental-property
```

```bash
gitroll new "Maple Street rental" --template your-name/rental-template
```

For safety, only these files are copied from a template: `.gitroll/config.yaml`, `.gitroll/README.md`, `.gitroll/theme.css`, `.gitroll/.gitattributes` and `README.md`. Scripts, workflows and anything else are ignored.

Every release also publishes the starter files to [jimhoyd-com/gitroll-template](https://github.com/jimhoyd-com/gitroll-template), for starting a Roll from GitHub's **Use this template** without installing anything.

## Themes

Put a `.gitroll/theme.css` file in a Roll to change how GitRoll looks for that Roll. Override any of these variables:

```css
:root {
  --bg: #fafafa;          /* page background */
  --surface: #ffffff;     /* cards and inputs */
  --text: #18181b;
  --muted: #52525b;       /* secondary text */
  --line: #e4e4e7;        /* borders */
  --hover: #f4f4f5;
  --accent: #18181b;      /* main buttons and selected chips */
  --accent-text: #ffffff;
  --link: #2563eb;
  --radius: 10px;
  --font: ui-sans-serif, system-ui, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #09090b; --surface: #18181b; --text: #fafafa; --accent: #fafafa; --accent-text: #18181b; }
}
```

The theme can only change styles. GitRoll's security policy blocks scripts and anything loaded from other websites.
