# Roadmap

GitRoll answers four questions: What happened? When did it happen? What evidence do I have? Can I find it again?

## Built

Open a log → write an event → attach a photo or receipt → commit locally → view the timeline → search → sync to a private GitHub repository. A log is a `.gitroll/` folder in a repository of its own or in a project you already have.

An event is a Markdown file, front matter optional, so Git and a text editor are enough. Includes projects, tags, dates, amounts, ordinary files with readable names, edit history, local validation, and a documented format ([SPEC.md](../SPEC.md)).

**For developers:**

- **Code references.** `#412`, `owner/repo#412`, a commit SHA and GitHub URLs are recognized in an event's text and linked when the event says which repository it is about. `gitroll log --code` records the repository, branch and commit you're on.
- **Branch visibility.** The Roll's own branch, head and repository in the browser header, the terminal header and `gitroll status` (including `--json`), with detached HEAD and a repository with no commits named rather than guessed at. An event's `source:` branch is shown separately, on the event, because where the work happened and where the log lives are different facts.
- **Templates** for debugging sessions, incidents, deployments, experiments and architecture decisions — in `gitroll log --template` and in the app's composer.
- **`--editor`**, using `$VISUAL` or `$EDITOR`, for logging and editing; **shell completion** for bash, zsh and fish, completing commands, Rolls, templates, tags, projects and saved searches.
- **Restore** an earlier version of an event as a new commit, from `gitroll restore` or from History in the app.
- **Conflicts** from a sync, side by side: `gitroll conflicts`, `gitroll resolve --mine|--theirs|--editor`, and a screen in the app. Both versions stay in history whichever is kept.
- **Related events and backlinks**, from ordinary Markdown links between events (`gitroll related`, and on every event in the app).
- **Saved searches** (`gitroll find … --save <name>`, then `gitroll find @name`) and **cross-Roll search** (`gitroll find … --all`).
- **Imports from GitHub and CI.** `gitroll import github` logs merged pull requests and releases; `gitroll import ci` logs builds that failed, because a log of every green build is noise. Both take `--since`, `--until`, `--branch`, `--author`, `--label`, `--status`, `--limit` and `--dry-run`, read GitHub through the GitHub CLI or a token or neither, and also read JSON piped in from `gh api` or a webhook. `source: { adapter, id }` means importing the same range twice logs nothing the second time, and an event you edited after importing stays edited. See [IMPORT.md](IMPORT.md).

**Ask your Roll** answers questions from your own events with a model you choose — on your computer by default, so nothing leaves it. Provider and model configuration, a connection test that says which thing is wrong, an on/off switch, and a Roll-level `ai: false` that turns it off for everyone. Answers cite the events they came from; AI drafts events but never saves one. See [AI.md](AI.md).

**GitRoll.com** (separate, paid, optional) reads and writes the same files in the same repositories.

## Next

- **AI-written weekly updates and release notes as a repeatable thing.** `gitroll summary` drafts one from a date range today; what's missing is choosing what goes in it (a project, a tag, a milestone) and a shape worth pasting into a release.
- **Saved searches in the app**, and searching every Roll from the browser. Both exist in the CLI only.
- **Pins, resolving issues, people and entities, QR codes for assets.**

## Deliberately deferred

- Git LFS, S3, R2 or other attachment stores
- PWA or mobile capture
- Collaboration features beyond ordinary Git sharing
- An index or embeddings for search. Search is rebuilt from the repository each time; nothing is cached, and it stays fast enough that nothing has to be.

## Not planned

Kanban boards, sprints, Gantt charts, task management, accounting, blockchain.
