# Roadmap

GitRoll is structured memory in a Git repository you own, for people and their AI agents: a small set of constructs (events, notes, to-dos, records and files) kept as plain Markdown, with views over them that use existing standards rather than new formats. It answers: What happened, and when? What do I know? What's left to do? What do I have, and where is the evidence? Can I find it again? People read it in a browser or a text editor; agents read and change it through the command line or MCP.

## Built

Open a log → write an event → attach a photo or receipt → commit locally → view the timeline → search → sync to a private GitHub repository. A log is a `.gitroll/` folder in a repository of its own or in a project you already have.

An event is a Markdown file, front matter optional, so Git and a text editor are enough. Includes projects, tags, dates, amounts, ordinary files with readable names, edit history, local validation, and a documented format ([SPEC.md](../SPEC.md)).

**For everyone:**

- **One interface, and a command line for scripts.** The browser app, served from your own computer, is where you use GitRoll; `gitroll` on its own opens it. The command line is for scripts and agents: every command works in one line with no questions asked.
- **Recovery.** The browser app's Deleted page and `gitroll deleted` list what has been deleted from this Roll, read back out of Git history, and put any of it back with the text as it was written — a new commit, so the history shows the deletion and the recovery both. An event that only moved isn't offered back. Undo, right after a delete, puts it straight back.
- **An event's files** are copied into the Roll and linked from the event. A file an event links to that isn't in the Roll is marked and explained rather than failing quietly.
- **Editing by hand is first-class.** Changes made in your editor or another window turn up in the browser app by themselves, a file GitRoll can't read is named rather than dropped, and a save stops and asks rather than overwriting a file that changed underneath it.
- **Saved, committed and backed up are three different things**, kept apart in the header, and backing up happens when you ask in every interface — uploading a private logbook is a decision, not housekeeping. The Git states that stop a sync each say what still works and what to do.
- **Search says what it looks at:** what you wrote, and not what is inside your files, not other Rolls unless `--all` asks, not deleted events, not older versions. A search that finds nothing says so there, where the assumption is being made.

**Constructs and views:**

- **Notes and to-dos.** A note is a page kept up to date in `.gitroll/notes/`, off the timeline. A to-do is a task-list line, `- [ ] …`, in any event or note, dated and repeated the way Obsidian Tasks writes it (`📅`, `🔁`).
- **Records and fields.** Any folder under `.gitroll/notes/` is a collection, each note in it a record, and any front matter key a field to search, sort and set (`rating>=4`, `has:isbn`, `--sort=-rating`), with no schema to declare. `gitroll add`, `gitroll records`, `gitroll set`, and CSV both ways.
- **Calendar.** `start`, `end`, `location` and `rrule`, iCalendar's own names, make an event or note an appointment; `gitroll upcoming` lists what's due and `gitroll calendar --ics` exports it.
- **Ledger.** Totals of `amount` and `price` per currency, never converted, and an hledger journal export. A view, not an accounting system.
- **Series.** One number field over time (odometer, weight, a meter), with change and rate, grouped by keeping the last reading per period; `gitroll series` and a chart in the browser app.
- **Inventory.** Records with schema.org's names for things (`brand`, `serialNumber`, `warranty`, `location`), places that nest, restock to-dos, and QR labels.
- **Contacts.** People as records with vCard's names (`email`, `tel`, `org`, `bday`), their history from the events that link to them, birthdays and anniversaries every year on the calendar, and vCard files out and in.
- **The same views in the browser app:** Notes and collection tables, Upcoming with to-dos you can tick off and an `.ics` download, Ledger, Series, Inventory, Contacts and Files.
- **Files on their own**, with Dublin Core fields in a sidecar, EXIF dates for photos, and large files kept in numbered parts under GitHub's limit.

**For agents:**

- **An MCP server** (`gitroll mcp`) with one tool per JSON command, made from the same catalog as `gitroll schema`.
- **Provenance.** A `Gitroll-Agent:` trailer on every commit an agent makes, and Git's own SSH signing so it is proof rather than a claim: `gitroll agent-key`, `.gitroll/allowed_signers`, `gitroll verify`.
- **`.gitroll/AGENTS.md`** in every new Roll, for an agent that has only Git.

**Security:** sealed lines, fields and files in the [age](https://age-encryption.org) format, readable only by the Roll's recipients and openable with the standard `age` tool.

**For developers:**

- **Code references.** `#412`, `owner/repo#412`, a commit SHA and GitHub URLs are recognized in an event's text and linked when the event says which repository it is about. `gitroll log --code` records the repository, branch and commit you're on.
- **Branch visibility.** The Roll's own branch, head and repository in the browser header and `gitroll status` (including `--json`), with detached HEAD and a repository with no commits named rather than guessed at. An event's `source:` branch is shown separately, on the event, because where the work happened and where the log lives are different facts.
- **Templates** for debugging sessions, incidents, deployments, experiments and architecture decisions — in `gitroll log --template` and in the app's composer.
- **`--editor`**, using `$VISUAL` or `$EDITOR`, for logging and editing; **shell completion** for bash, zsh and fish, completing commands, Rolls, templates, tags, projects and saved searches.
- **Restore** an earlier version of an event as a new commit, from `gitroll restore` or from History in the app.
- **Conflicts** from a sync, side by side: `gitroll conflicts`, `gitroll resolve --mine|--theirs|--editor`, and a screen in the app. Both versions stay in history whichever is kept.
- **Related events and backlinks**, from ordinary Markdown links between events (`gitroll related`, and on every event in the app).
- **Saved searches** (`gitroll find … --save <name>`, then `gitroll find @name`) and **cross-Roll search** (`gitroll find … --all`).
- **Imports from GitHub and CI.** `gitroll import github` logs merged pull requests and releases; `gitroll import ci` logs builds that failed, because a log of every green build is noise. Both take `--since`, `--until`, `--branch`, `--author`, `--label`, `--status`, `--limit` and `--dry-run`, read GitHub through the GitHub CLI or a token or neither, and also read JSON piped in from `gh api` or a webhook. `source: { adapter, id }` means importing the same range twice logs nothing the second time, and an event you edited after importing stays edited. See [IMPORT.md](IMPORT.md).

**GitRoll.com** (separate and optional) reads and writes the same events in the same repositories.

## Next

- **Saved searches in the app**, and searching every Roll from the browser. Both exist in the CLI only.
- **Pins, resolving issues, and entities other than people** (organizations and places as views of their own).

## Deliberately deferred

- Git LFS, S3, R2 or other attachment stores
- **PWA or mobile capture.** GitRoll runs on a computer somebody owns and serves its browser app to that same computer; there is no server and nothing to log in to. Capturing from a phone needs somewhere for events to pass through, which is a decision about a private logbook rather than a feature to add, so this release says desktop and local plainly instead (see the README's Privacy section). The responsive layout is for a narrow window on a laptop and is not phone access; exposing the local server to a network to reach it from a phone is not a supported way round it.
- Collaboration features beyond ordinary Git sharing
- An index or embeddings for search. Search is rebuilt from the repository each time; nothing is cached, and it stays fast enough that nothing has to be.

## Not planned

Kanban boards, sprints, Gantt charts, task management, accounting, blockchain. To-dos stay lines of Markdown and the ledger stays a view; anything more belongs in a tool built for it, fed by GitRoll's exports.
