# Roadmap

GitRoll answers four questions: What happened? When did it happen? What evidence do I have? Can I find it again?

## Built

Open a log → write an event → attach a photo or receipt → commit locally → view the timeline → search → sync to a private GitHub repository. A log is a `.gitroll/` folder in a repository of its own or in a project you already have.

Entries are Markdown, front matter optional, so Git and a text editor are enough. Tags, dates, amounts, ordinary files with readable names, edit history, local validation, and a documented format ([SPEC.md](../SPEC.md)).

**For everyone:**

- **A workspace in the terminal.** A persistent prompt with recent events above it, a `/` command menu, a full composer, drafts that survive quitting, and search as you type. `gitroll` on its own opens it; every command still works in one line for scripts.
- **Recovery is History.** Getting something back is one idea, whether it was edited or deleted: `gitroll history` lists what has been removed from this Roll and `gitroll history <entry>` what an entry used to say; `gitroll restore <entry>` puts back either one, always as a new commit, so the history shows the loss and the recovery both. The terminal app's `/history` is the same list (`/deleted` still finds it) and `Ctrl+Z` undoes the last deletion; the browser lists the same removals under the timeline, and offers the way back in the message that follows a delete. An event that only moved isn't offered back.
- **An event's files open** in whatever application normally opens them (`o`, `Tab` to pick another). A file an event links to that isn't in the Roll is marked and explained rather than failing quietly.
- **Editing by hand is first-class.** Changes made in your editor or another window turn up in the workspace by themselves, a file GitRoll can't read is named rather than dropped, and a save stops and asks rather than overwriting a file that changed underneath it.
- **Capture starts with text.** `gitroll log "…"` works before you have a Roll, and `gitroll log` on its own asks one question. Tags are the `#words` you already write and amounts the `$numbers`; a date, an amount or a template is there when an entry needs one and out of the way when it doesn't.
- **One answer to "is my entry safe?"** Saving and committing happen together and never come apart, so the terminal, the browser and `gitroll status` say the same thing in the same words: saved here only, saved with changes to back up, or saved and backed up — and what to do about it. Backing up happens when you ask, in every interface: uploading a private logbook is a decision, not housekeeping. The Git states that stop a sync each say what still works and what to do.
- **Storage that holds up.** One Markdown file per month by default (daily for high-volume Rolls), rolling over rather than growing without limit; permanent entry ids that survive rollover, migration, archiving and compression; one time zone per Roll; archiving with optional gzip, from `gitroll archive` or from Filing periods in the browser; and syncing that merges entry by entry instead of line by line. See [STORAGE.md](STORAGE.md).
- **Search says what it looks at:** what you wrote, and not what is inside your files, not other Rolls unless `--all` asks, not deleted events, not older versions. A search that finds nothing says so there, where the assumption is being made.

**For developers:**

- **Code references.** `#412`, `owner/repo#412`, a commit SHA and GitHub URLs are recognized in an event's text and linked when the event says which repository it is about. `gitroll log --code` records the repository, branch and commit you're on.
- **Branch visibility.** The Roll's own branch, head and repository in the browser header, the terminal header and `gitroll status` (including `--json`), with detached HEAD and a repository with no commits named rather than guessed at. An event's `source:` branch is shown separately, on the event, because where the work happened and where the log lives are different facts.
- **Templates** for debugging sessions, incidents, deployments, experiments and architecture decisions — in `gitroll log --template` and in the app's composer.
- **`--editor`**, using `$VISUAL` or `$EDITOR`, for logging and editing; **shell completion** for bash, zsh and fish, completing commands, Rolls, templates, tags and saved searches.
- **Conflicts** from a sync, side by side: `gitroll conflicts`, `gitroll resolve --mine|--theirs|--editor`, and a screen in the app. Both versions stay in history whichever is kept.
- **Related events and backlinks**, from ordinary Markdown links between events (`gitroll related`, and on every event in the app).
- **Saved searches** (`gitroll find … --save <name>`, then `gitroll find @name`) and **cross-Roll search** (`gitroll find … --all`).

**GitRoll.com** (separate, paid, optional) reads and writes the same files in the same repositories.

## Next

The three things that decide whether somebody keeps a logbook: how little it costs to write something down, how sure they are it's safe, and how quickly they get from installing to their first entry.

- **Faster capture.** Two of the four things that used to stand in front of the text box are gone (topics, and the tag and attachment questions). What's left: making the browser's composer as quick to reach from a cold start as `gitroll log` is, and logging from wherever you already are.
- **Clearer save and backup status.** One answer, computed in one place; a folder is a backup that needs no account; and a failed sync says what to do rather than what Git said. Backing up for the first time and archiving a period both work in the browser now. What's left is the first run itself: naming a Roll, and getting one onto a second computer.
- **Easier first run.** `gitroll log "…"` makes a Roll when there isn't one, `gitroll rename` names it everywhere, and `gitroll join` picks it up on a second computer under its own name — from a folder backup as readily as from GitHub. The browser names a Roll, backs it up, and says so when a new Roll has neither. Starting a Roll from nothing, and joining one from another computer, stay terminal steps: both happen before there is an app to open.

**Only if people repeatedly need them:** pins, and importing from GitHub or CI. Imports were built and removed: a GitHub API client, auth detection and a filter language, for something a shell pipeline and `gitroll log` already do. If people keep asking, the way back is an adapter that reads JSON, not a second GitHub client.

## Deliberately deferred

- Git LFS, S3, R2 or other attachment stores
- PWA or mobile capture
- Collaboration features beyond ordinary Git sharing
- Embeddings or a server-side search index. There is a local index, rebuildable from the repository and kept outside version control, and it is an optimization rather than a source of truth: delete it and nothing is lost.

## Not planned

Kanban boards, sprints, Gantt charts, task management, accounting, blockchain.

Built-in AI, too. Asking questions of a logbook is a good idea and a bad fit for a tool whose job is to write files somebody else's tool can read: a Roll is Markdown in a Git repository, so any agent you already trust can read it directly. GitRoll keeps the files honest and stays out of the way.
