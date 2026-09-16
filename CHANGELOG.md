# Changelog

All notable changes to GitRoll are documented here. GitRoll follows [semantic versioning](https://semver.org). The Roll file format has its own version, documented in [SPEC.md](SPEC.md).

## Unreleased

### Removed

- **Imports from GitHub and CI.** `gitroll import` and its adapters are gone,
  along with the GitHub API client, auth detection and the `--since/--until/
  --branch/--author/--label/--status/--include/--only` filter language. A Roll
  is Markdown in a Git repository, so anything that can write a file can put
  history into one; GitRoll's job is the file format, not a second GitHub
  client. `source: { adapter, id }` stays in the format and still makes writes
  idempotent — `gitroll log --idempotency-key` uses it, and so can any tool.
- **Self-upgrade and self-uninstall.** `gitroll upgrade` and `gitroll uninstall`
  now print the one command for the way GitRoll was installed — and, when
  removing it, every Roll it is leaving alone — instead of downloading releases,
  verifying checksums and running Homebrew, Scoop or npm themselves. The package
  manager you used already does that job. `--dry-run`, `--yes` and
  `--remove-settings` are gone with the doing.
- **The `@gitroll/core` package.** The format still lives in `src/core` and is
  still platform-free (enforced by `test/core-boundary.test.ts`), shared by the
  terminal app, the browser app and GitRoll.com. What is gone is publishing it
  separately, with its own version, licence files and release step.

### Changed

- **Today, recent and find are one list.** They were three implementations, and
  only `find` said what it had left out or could be asked to include the
  archive. All three now say the same things, take `--include-archive`, and page
  the same way. `today` is today in the Roll's own time zone rather than the
  one this computer happens to be set to.
- **Recovery is History.** Putting something back is one idea whether it was
  edited or deleted. `gitroll history` lists everything removed from the Roll
  (it used to exist only as `/deleted` in the terminal app), `gitroll history
  <entry>` lists an entry's versions, and `gitroll restore <entry>` puts back
  either one — always as a new commit, so the loss and the recovery are both in
  the history. The terminal app's screen is `/history`; `/deleted` still finds
  it.

### Added

- **One answer to "is my entry safe?"** The terminal app, the browser and
  `gitroll status` used to describe saving, committing and backing up in three
  different ways. They now say the same thing, computed in one place: *Saved on
  this computer only*, *Saved here. 3 changes not backed up yet*, *Saved and
  backed up*, or *Backing up needs a hand* — and what to do about it, in each
  interface's own terms.
- **Capture starts with text.** `gitroll log "..."` works before you have a
  Roll: GitRoll makes one in `~/GitRoll` and puts the entry in it. (Inside a Git
  repository with no Roll, it still asks, because that choice affects who can
  read what you write.) `gitroll log` with nothing after it asks one question
  instead of three — tags come from the `#words` you write and an amount from
  the `$number`, and files are an argument away.
- **Grouped storage.** New Rolls keep one Markdown file per month
  (`.gitroll/logs/2026/09.md`), rolling over into `09-002.md` when a file passes
  1 MiB or 1,000 entries. Daily grouping is available for high-volume Rolls.
  Existing Rolls keep one file per event until `gitroll migrate` is run.
- **Permanent entry ids.** An entry in a shared file carries an id that survives
  rollover, migration, archiving and compression, so links keep resolving.
  Links written before a migration resolve through `.gitroll/moved.yaml`.
- **One time zone per Roll.** Entries are filed by the day they happened in the
  Roll's zone, recorded when the entry is created. Daylight-saving ambiguity is
  reported rather than resolved silently, and ingestion time is never used as an
  occurrence.
- **Archiving and optional gzip.** `gitroll archive` / `gitroll unarchive` put a
  whole filing period out of the timeline and search without deleting anything;
  compression is a separate, optional setting with deterministic output.
- **Entry-aware sync.** Shared files are merged entry by entry against the common
  ancestor: independent additions both survive, different entries merge, and
  conflicting edits keep both texts instead of last-writer-wins.
- **A local index** in `.git/gitroll/`, rebuildable and incremental, so opening a
  Roll doesn't mean reading every file. It reports itself as incomplete rather
  than presenting partial results as complete.
- `gitroll usage`, `gitroll storage`, and `--include-archive` on `gitroll find`.

### Removed

- **Topics.** A Roll had topics *and* tags, and deciding which one a repair
  belonged to was a decision nobody should have to make to write down that the
  boiler was serviced. Tags do the job. `gitroll projects`, the `-p/--project`
  flag, the Topics page in the browser, the `/topics` screen in the terminal
  and the Topics field in both composers are gone.

  Nothing filed is lost: a `projects:` already in an entry is **kept exactly as
  written and read as tags**, so those entries stay findable, and searches that
  say `topic:house` or `project:house` still work — both mean `tag:house`.
  Writers use `tags:` from now on.

- **Ask, summaries and model settings.** GitRoll no longer talks to an AI
  provider: `gitroll ask`, `gitroll summary`, `gitroll ai`, the browser app's
  Ask panel and settings dialog, and the `/api/ask` and `/api/ai` routes are
  gone, along with `docs/AI.md`. A Roll is Markdown in a folder, so an agent
  that can read files and run `gitroll find --json` can do this from outside.
  The `ai:` key in `.gitroll/config.yaml` is no longer read; it is left alone
  where it exists, and the `ai` settings in `~/.config/gitroll/config.json` are
  ignored.

### Changed
- Adding a Roll to a repository that already holds a project explains what that
  means for who can read it — once, at setup, not on every save.
- The browser and accessibility checks are required in CI rather than skipped,
  and the accessibility claim is stated as what an automated scan covers.


## Unreleased

- Added offline agent guidance, `schema [command]`, and command-specific help with accepted flags, aliases, effects and output contracts.
- Unsupported flags now fail before execution, including `log --dry-run`. JSON output implies noninteractive mode; interactive commands reject JSON instead of printing prose or launching a workspace.
- Completed JSON output for one-shot Roll management and event commands, including empty summaries, conflict resolution and diagnostic reports. JSON errors include stable codes; `check --json` and `ai test --json` now fail with the same exit status as their text equivalents.
- Added `--limit`, `--offset`, and JSON `--fields` to event search/list commands, retryable `log --idempotency-key`, and `show --json` revisions for `edit --expect` stale-edit protection.
- Explicit `--roll` now overrides `GITROLL_REPO`; combining it with `-C` is rejected. Explicit logging options no longer get discarded by the guided composer.

## 0.4.0 (2026-09-16)

### Licensing
- **GitRoll is now source available, not open source, starting with 0.4.0.** The license changes from the MIT License to the [PolyForm Shield License 1.0.0](LICENSE). GitRoll stays free for personal use and for internal business use, including paid client work; what it no longer permits is using GitRoll to provide a product that competes with GitRoll or with GitRoll.com. `@gitroll/core` changes on the same terms, at its version 0.2.0, shipped with GitRoll 0.4.0.
- **Releases through 0.3.0 remain under the MIT License, permanently.** The change is not retroactive: anyone who obtained 0.1.0, 0.1.1, 0.1.2, 0.2.0 or 0.3.0 keeps every permission MIT gave them, for those versions, forever. The tags and release packages stay published, and the full record is in [LICENSE-MIT-HISTORICAL](LICENSE-MIT-HISTORICAL).
- **Contribution terms changed** so that contributed code can ship in both GitRoll and GitRoll.com and be covered by a commercial license. See [Contribution terms](CONTRIBUTING.md#contribution-terms) before sending a pull request. Contributions made before 0.4.0 were submitted under MIT and are unaffected.
- **Bundled third-party components are unaffected** and keep their own licenses. `dist/THIRD_PARTY_NOTICES.txt` is unchanged in substance and no notice has been removed. `dompurify`, which is dual licensed, is taken under Apache-2.0.
- **Plain-language answers** to what the new terms allow are in [docs/LICENSE-FAQ.md](docs/LICENSE-FAQ.md).
- Commercial licenses for competing use are available: jimhoyd@gmail.com.

### Fixed
- **Saving from the composer comes back to the prompt.** The selection marker stayed on whichever entry was picked before the composer opened — not the entry just written — so the next Enter opened that one instead of logging what had just been typed. It now lands on the prompt, the way logging from the prompt does.
- **An amount reads as money.** `$41.90` came back as `41.9` on the timeline, in search and on the event itself — which reads as a typo rather than a sum. Amounts are now shown with the decimal places the currency actually has, so yen keeps none and dollars keep two, and the currency's code stays beside the number because a Roll can hold more than one. What is stored is unchanged.
- **Things logged on the same day read in the order they happened.** An event's file name carries a day and nothing more, so two entries written on the same day had nothing to sort by and came back in alphabetical order — the one written first could appear last. GitRoll now records the moment, not just the day, in the front matter it writes (`date: 2026-09-16T14:30:00-05:00`, which the format has always allowed). A date you give yourself is kept exactly as you wrote it, with no time invented for it. Nothing already in a Roll changes.
- **An event's history is its own.** "Every change to this entry" could show another event's commits: the history was read with `git log --follow`, which guesses where a file came from when it was added, and events resemble each other closely enough that it guessed wrong. The rename chain is now read from Git's own record of files that really did move.
- **An entry keeps the shape it was written in.** Every event with more than one line was drawn in the terminal as a single run-on line: a heading, two paragraphs and a list arrived as one paragraph with the breaks turned into spaces. The text that guards against a Roll moving the cursor or retitling the window was being applied before the line breaks were counted, and a line break is a control character like any other. Both hold now — the entry screen, the search preview and the messages read the way the file was written, and nothing in a Roll can still drive the terminal.
- **Undo puts the whole file back, not just the words in it.** Ctrl+Z after deleting an event restored its text and quietly dropped everything in its front matter with it: the amount, the topics, the tags, a date written by hand, and any key GitRoll itself doesn't read. `/deleted` was never affected, which is what made this easy to miss — the same event survived one route back and was thinned by the other. A deleted event now comes back exactly as it was, byte for byte.

## 0.3.0 (2026-09-16)

- **Search says what it looks at.** Somebody will eventually search for a word that is inside a receipt and expect a match, so the terminal app, the browser app, `gitroll help more` and the README now say the same thing: search reads what you wrote — an event's words, title, topics, tags, amount, front matter and the names of its attached files — and not what is inside those files, not other Rolls (unless `find --all`), not deleted events and not older versions. A search that finds nothing says it there and then.

- **"/" opens the commands from wherever you are** — reading an event, on the topics list, in the help — rather than only at the prompt. Where you could be typing it still types: a search you've started keeps its slashes, and so does the composer.
- **A topic reads as a name.** Topics are stored as slugs and have no separate name to store, so `bathroom-remodel` now shows as Bathroom Remodel everywhere it's read. Nothing changes on disk, and `topic:bathroom-remodel` is still what search takes.

### Changed
- **The format is much simpler, and this is a breaking change.** An event is now an ordinary Markdown file under `.gitroll/events/`, named for its date and what happened (`2026-09-15-ac-serviced.md`). Front matter is optional: a heading and a paragraph is a complete event. Gone are year/month folders, UUID file names, required `version`, `id`, `created`, `author` and `occurred` fields, hash-named attachments and attachment manifests, project definition files, and custom event types. Files kept with an event are ordinary files in `.gitroll/files/`, linked with ordinary relative Markdown links. GitRoll launched today with no users, so nothing is migrated.
- **Everything GitRoll owns lives in `.gitroll/`** at the root of a Git repository. A log can be a repository of its own or sit beside a project you already have: adding one creates `.gitroll/` and nothing else, leaves your README and branch alone, and commits only the files GitRoll wrote. `.gitroll/` is a namespace, not a privacy boundary — a log in a public repository is public.
- **An event's identity is its path**, so `git mv` is a rename and Git history follows it. `gitroll move` renames an event and rewrites its links. Authors come from Git history instead of a field in the file.
- **Dates come from the file name** unless the front matter says otherwise, and an event with neither is shown as undated rather than rejected. Date filters compare calendar days as written, so an event stays on its author's day everywhere.
- **Projects and tags need no setup.** Naming one on an event is all there is to it.
- **`.gitroll/config.yaml` records `template_version`.** GitRoll reads it, never changes it while logging or editing, refuses to write to a repository whose template is newer than the app, and reports a missing marker as an unknown version instead of assuming it is current (`gitroll template --set 1` records one).
- **Editing preserves what you wrote:** comments, key order and unknown front matter keys survive a save, and the body is left untouched unless the text itself changed.

### Added
- **Imports from GitHub and CI.** `gitroll import github` logs merged pull requests and releases, `gitroll import ci` logs builds that failed (`--status all` for the rest), for this Roll's own repository or one you name. Filter with `--since`, `--until`, `--branch`, `--author`, `--label`, `--status` and `--limit`, and see what would happen with `--dry-run`. GitHub is asked through the GitHub CLI if it's signed in, then `GITHUB_TOKEN`, then not at all; no token is ever stored. JSON piped in from `gh api` or a webhook works too. Nothing is logged twice — `source: { adapter, id }` is the thing's own identity, a repeated import starts where the last one left off and says so, and an event you edited after importing stays as you left it. See [docs/IMPORT.md](docs/IMPORT.md).
- **Ask your Roll is a normal feature**, not an experiment behind an environment variable. `gitroll ai` lists where a model can run (on your computer first, so nothing leaves it), `gitroll ai test` says which thing is wrong when it doesn't work, and `gitroll ai on`/`off` switches it without forgetting the settings. The app has the same thing behind ✨ in the header, and tests what you typed before it saves. Keys are read from environment variables and never stored; a Roll's `ai: false` still turns Ask off for everyone. Answers cite events and link to them, and an answer can be turned into a draft event — which stays a draft until you save it. `gitroll summary` drafts an update from a date range the same way.
- **The Roll's branch is visible**: in the browser header, the terminal header and `gitroll status` (including `--json`, which also carries the head commit, the repository and why syncing is blocked). A detached HEAD and a repository with no commits are named rather than guessed at, and syncing on a detached HEAD stops and says what to do.
- **Code references.** `#412`, `owner/repo#412`, a commit SHA and GitHub URLs in an event's text become links when the event says which repository it is about. `gitroll log --code` records the repository, branch and commit you're on, as `source: { repo, branch, commit }`.
- **`gitroll log --editor`** (and `gitroll edit --editor`), using `$VISUAL` or `$EDITOR`, and **`gitroll completion bash|zsh|fish`** for commands, Rolls, templates, tags, projects and saved searches.
- **Templates** for the kinds of event developers write often — debugging, incident, deployment, experiment and architecture decision — in `gitroll log --template`, `gitroll templates`, and the app's composer.
- **`gitroll restore`**, and *Put this version back* in History: an earlier version returns as a new commit, so nothing is ever rewritten.
- **`gitroll conflicts` and `gitroll resolve`**, and a Conflicts screen in the app: an event changed in two places, side by side, settled by keeping one version or writing one out of both. Both stay in history.
- **Related events and backlinks** from ordinary Markdown links between events (`gitroll related`, and on every event in the app).
- **Saved searches** (`gitroll find … --save <name>`, then `find @name`, `gitroll searches`) and **`gitroll find --all`** across every Roll on this computer.
- **A workspace in the terminal.** `gitroll` now opens a persistent prompt with your recent entries above it. Type what happened and press Enter to log it; press `/` for a searchable command menu (`/log`, `/find`, `/topics`, `/roll`, `/sync`, `/status`, `/undo`, `/web`, `/help`) with descriptions and autocomplete.
- **A complete composer** (Ctrl+O or `/log`): text over several lines, date, amount, tags, topics and files, with topic and tag autocomplete, dragged or pasted file paths, and `Ctrl+E` to write in your own editor. Entries can be edited or duplicated from the composer too.
- **Unsaved drafts are kept.** Leaving the composer, switching Rolls or quitting keeps what you wrote, and GitRoll offers it again next time. Drafts live with your settings, never inside a Roll.
- **Interactive search** (`/find`): results as you type, arrow-key selection, a preview beside the list in a wide terminal, and edit, duplicate, delete or write a new entry without leaving it. Your query and selection are still there when you come back.
- **Undo deletion** with Ctrl+Z (or `/undo`), and the header now says which Roll you're in, where it lives, and whether it's saved only on this computer or backed up.
- **The Roll you switch to is remembered**, so it opens next time.
- **The workspace always says where it's writing:** the Roll, the branch and the folder, in the header. Saving names the file it wrote, and switching Rolls says which folder you landed in.
- **Saved, committed and backed up are three different things**, and the header keeps them apart: files changed in the folder but not committed are counted separately from changes committed here but not yet at your backup.
- **Git states that stop a sync explain themselves.** A detached HEAD, an unfinished merge or an unfinished rebase each say what still works (logging always does) and the command that clears it, instead of a branch name GitRoll guessed at. `gitroll status` reports the same.
- **Files GitRoll can't read are named, not dropped.** An entry whose front matter can't be parsed — a date typed by hand, say — used to disappear from the terminal app with no explanation. The workspace now says how many there are, and `/problems` lists each one with the part to fix and opens it in your editor. GitRoll never rewrites them: the writing stays exactly where its author left it.
- **The workspace picks up changes made anywhere else.** Editing a file in your editor, or logging from another window, updates the timeline by itself — never while you're in the middle of writing something.
- **An entry edited in your editor is never silently overwritten.** If the file changed on disk while the composer was open on it, saving stops and asks, instead of replacing their version with yours.

- **Deleted events have somewhere to go.** `/deleted` lists what has been deleted from this Roll, read back out of Git history, and puts any of it back with the text exactly as it was written. Restoring is a new change, so the history shows both the deletion and the recovery — nothing is rewritten.
- **An event's files can be opened from the terminal** with `o` (`Tab` picks another), in whatever application normally opens them. A file an event links to that isn't in the Roll — not synced yet, say — is marked rather than failing quietly.
- **What happens to attachments is said plainly:** files are copied into `.gitroll/files/` and linked from the event, so the originals can move or be deleted afterwards, and unlinking one leaves the copy alone because another event may link the same file.

### Changed
- **Backing up happens when you ask, in every interface.** 0.2.0 gave the browser app an automatic backup shortly after each save and on returning to the window; the terminal app has always waited to be asked. Uploading a private logbook somewhere else is a decision rather than housekeeping, so now both wait. Nothing about the writing is at risk in the meantime: saving still commits to Git immediately, and the header says how far behind the backup is.

## 0.2.0 (2026-09-15)

### Changed
- **The browser app has been rebuilt** on React, Tailwind CSS and shadcn/ui components, replacing the hand-written DOM code. It looks and behaves like a modern app, and a Roll's own `.gitroll/theme.css` still repaints all of it: the documented variables are unchanged and everything else is derived from them.
- **Logging takes fewer steps.** The composer is always on the timeline instead of behind a button and a dialog. Type, topic, when it happened and amount are visible controls rather than hidden under "More options", `#tags` and amounts like `$40` are read out of what you write, and photos and files can be dropped or pasted straight in.
- **Log something that happened earlier.** When it happened is a visible control with Now, Yesterday and a week ago, plus a date picker. GitRoll still records separately when you wrote it down.
- **Search is one query box.** Filters and typed words are the same string now, so they can't disagree. Suggestions appear as you type (`has:`, `topic:`, `type:`, `after:`, `amount:` and the values for each), and the whole thing works from the keyboard. The syntax is the same one `gitroll find` takes.
- **Event text is rendered as Markdown**, which is what the format always said it was. Headings, lists, emphasis, quotes, code and tables all display, and photos and files can be embedded in the text itself. The editor has a toolbar, `Ctrl`/`⌘`+`B`/`I`/`K`, and a preview. What is written to disk is still plain Markdown a person can read.
- **Backing up happens by itself**, shortly after you save and when you return to the window, and reports what it is actually doing (checking, downloading, combining, uploading) instead of one spinner. The header button is now a status indicator; it only asks for a hand when a sync fails for a reason a person has to resolve.
- **"Project" is now "Topic"** and **"Kind" is now "Type"** throughout the interface, in the browser app and the terminal workspace alike. Nothing changes on disk: events still store `projects`, exactly as SPEC.md version 1 describes. `topic:` and `topics:` are accepted as search filters alongside `project:`.
- **The timeline is paginated**, so a Roll with years of events stays responsive.
- **Accessibility:** the app now meets WCAG 2.1 AA. Everything is reachable and operable from the keyboard, focus is always visible, dialogs replace the browser's own `alert`/`confirm`/`prompt`, results and errors are announced, and colours meet contrast requirements in both light and dark mode. Secondary text is slightly darker than before for that reason.

- **Installing GitRoll still installs nothing else.** The interface is built with React and Tailwind, but everything is bundled at build time, so the published package continues to have no runtime dependencies of its own.

### Removed
- **The built-in Maintenance type.** The starter set is now Log, Expense, Decision, Issue and Milestone. Events already logged as `maintenance` still open and still work; to keep its fields, define it in your own Roll with `gitroll types add`.

### Fixed
- Searching for more than one word. The query round-tripped through the address bar with its whitespace trimmed, which erased the space as soon as it was typed.

### Security
- The app's Content Security Policy now allows inline **styles**, which the interface needs to position dialogs and menus. Scripts remain same-origin only, with no inline or third-party script and no framing.

## 0.1.2 (2026-09-15)

### Fixed
- **Release publishing:** npm now receives each release with provenance (0.1.1 wasn't published to npm), and the Scoop bucket is updated automatically. No changes to the app.

## 0.1.1 (2026-09-15)

### Added
- **Imports from GitHub and CI.** `gitroll import github` logs merged pull requests and releases, `gitroll import ci` logs builds that failed (`--status all` for the rest), for this Roll's own repository or one you name. Filter with `--since`, `--until`, `--branch`, `--author`, `--label`, `--status` and `--limit`, and see what would happen with `--dry-run`. GitHub is asked through the GitHub CLI if it's signed in, then `GITHUB_TOKEN`, then not at all; no token is ever stored. JSON piped in from `gh api` or a webhook works too. Nothing is logged twice — `source: { adapter, id }` is the thing's own identity, a repeated import starts where the last one left off and says so, and an event you edited after importing stays as you left it. See [docs/IMPORT.md](docs/IMPORT.md).
- **Ask your Roll is a normal feature**, not an experiment behind an environment variable. `gitroll ai` lists where a model can run (on your computer first, so nothing leaves it), `gitroll ai test` says which thing is wrong when it doesn't work, and `gitroll ai on`/`off` switches it without forgetting the settings. The app has the same thing behind ✨ in the header, and tests what you typed before it saves. Keys are read from environment variables and never stored; a Roll's `ai: false` still turns Ask off for everyone. Answers cite events and link to them, and an answer can be turned into a draft event — which stays a draft until you save it. `gitroll summary` drafts an update from a date range the same way.
- **The Roll's branch is visible**: in the browser header, the terminal header and `gitroll status` (including `--json`, which also carries the head commit, the repository and why syncing is blocked). A detached HEAD and a repository with no commits are named rather than guessed at, and syncing on a detached HEAD stops and says what to do.
- **Code references.** `#412`, `owner/repo#412`, a commit SHA and GitHub URLs in an event's text become links when the event says which repository it is about. `gitroll log --code` records the repository, branch and commit you're on, as `source: { repo, branch, commit }`.
- **`gitroll log --editor`** (and `gitroll edit --editor`), using `$VISUAL` or `$EDITOR`, and **`gitroll completion bash|zsh|fish`** for commands, Rolls, templates, tags, projects and saved searches.
- **Templates** for the kinds of event developers write often — debugging, incident, deployment, experiment and architecture decision — in `gitroll log --template`, `gitroll templates`, and the app's composer.
- **`gitroll restore`**, and *Put this version back* in History: an earlier version returns as a new commit, so nothing is ever rewritten.
- **`gitroll conflicts` and `gitroll resolve`**, and a Conflicts screen in the app: an event changed in two places, side by side, settled by keeping one version or writing one out of both. Both stay in history.
- **Related events and backlinks** from ordinary Markdown links between events (`gitroll related`, and on every event in the app).
- **Saved searches** (`gitroll find … --save <name>`, then `find @name`, `gitroll searches`) and **`gitroll find --all`** across every Roll on this computer.
- **Scoop (Windows):** `scoop bucket add gitroll https://github.com/jimhoyd-com/scoop-bucket`, then `scoop install gitroll/gitroll`. Every release installs the manifest with Scoop on Windows before publishing. `gitroll version`, `upgrade` and `uninstall` recognize Scoop installs.
- **npm:** `npm install --global gitroll`, published by the release workflow with provenance through npm trusted publishing (no stored npm token).

## 0.1.0 (2026-09-15)

First public release.

### Added
- **Imports from GitHub and CI.** `gitroll import github` logs merged pull requests and releases, `gitroll import ci` logs builds that failed (`--status all` for the rest), for this Roll's own repository or one you name. Filter with `--since`, `--until`, `--branch`, `--author`, `--label`, `--status` and `--limit`, and see what would happen with `--dry-run`. GitHub is asked through the GitHub CLI if it's signed in, then `GITHUB_TOKEN`, then not at all; no token is ever stored. JSON piped in from `gh api` or a webhook works too. Nothing is logged twice — `source: { adapter, id }` is the thing's own identity, a repeated import starts where the last one left off and says so, and an event you edited after importing stays as you left it. See [docs/IMPORT.md](docs/IMPORT.md).
- **Ask your Roll is a normal feature**, not an experiment behind an environment variable. `gitroll ai` lists where a model can run (on your computer first, so nothing leaves it), `gitroll ai test` says which thing is wrong when it doesn't work, and `gitroll ai on`/`off` switches it without forgetting the settings. The app has the same thing behind ✨ in the header, and tests what you typed before it saves. Keys are read from environment variables and never stored; a Roll's `ai: false` still turns Ask off for everyone. Answers cite events and link to them, and an answer can be turned into a draft event — which stays a draft until you save it. `gitroll summary` drafts an update from a date range the same way.
- **The Roll's branch is visible**: in the browser header, the terminal header and `gitroll status` (including `--json`, which also carries the head commit, the repository and why syncing is blocked). A detached HEAD and a repository with no commits are named rather than guessed at, and syncing on a detached HEAD stops and says what to do.
- **Code references.** `#412`, `owner/repo#412`, a commit SHA and GitHub URLs in an event's text become links when the event says which repository it is about. `gitroll log --code` records the repository, branch and commit you're on, as `source: { repo, branch, commit }`.
- **`gitroll log --editor`** (and `gitroll edit --editor`), using `$VISUAL` or `$EDITOR`, and **`gitroll completion bash|zsh|fish`** for commands, Rolls, templates, tags, projects and saved searches.
- **Templates** for the kinds of event developers write often — debugging, incident, deployment, experiment and architecture decision — in `gitroll log --template`, `gitroll templates`, and the app's composer.
- **`gitroll restore`**, and *Put this version back* in History: an earlier version returns as a new commit, so nothing is ever rewritten.
- **`gitroll conflicts` and `gitroll resolve`**, and a Conflicts screen in the app: an event changed in two places, side by side, settled by keeping one version or writing one out of both. Both stay in history.
- **Related events and backlinks** from ordinary Markdown links between events (`gitroll related`, and on every event in the app).
- **Saved searches** (`gitroll find … --save <name>`, then `find @name`, `gitroll searches`) and **`gitroll find --all`** across every Roll on this computer.
- **Rolls:** plain Markdown-and-YAML records with attachments named by their SHA-256 hash, specified in SPEC.md.
- **Local web app:** timeline, search with quick filters, projects, logging with photos and files, editing with history, and a sync button.
- **CLI:** `setup`, `log`, `find`, `sync`, `rolls`, `switch`, `new`, `join`, `share`, `backup`, `rename`, `remove`, `projects`, `types`, `template`, `export`, `import`, `check`, `doctor`, `ask`, `ai`.
- **Event types:** Log, Expense, Maintenance, Decision, Issue and Milestone, plus custom types with fields and defaults.
- **Syncing:** with a private GitHub repository using your own Git credentials, with automatic merging when the same entry was edited in two places.
- **Templates and themes:** reusable Roll templates and per-Roll themes.
- **Template repository:** starter files are published to `jimhoyd-com/gitroll-template` on each release; `gitroll rolls add` registers a Roll you cloned yourself.
- **Dates and time zones:** timestamps keep the author's offset; a hand-typed date (`2026-09-15`) means noon local time so it stays on that day everywhere; only real ISO 8601 dates are accepted (no `Sept 15` or February 30), and `gitroll check` reports others. Rules are in SPEC.md, with tests across time zones and daylight-saving changes.
- **End-to-end tests** of the built app: two people sharing a Roll, the browser app over HTTP, and the terminal app in a real terminal.
- **Template repository renamed** to `jimhoyd-com/gitroll-template`, with step-by-step instructions for starting from it.
- **Upgrade and uninstall:** `gitroll version`, `gitroll upgrade` (checksum-verified, or Homebrew) and `gitroll uninstall` (never deletes Rolls; `--remove-settings` optional), plus `scripts/uninstall.sh`. Releases verify that uninstalling removes the app and keeps Rolls and settings.
- **Homebrew:** `brew install jimhoyd-com/tap/gitroll`, published automatically by the release workflow.
- **Plain `gitroll` opens the terminal app** in a terminal; `gitroll open` (or `--no-browser`/`--plain`, or a script) keeps the browser/basic behavior.
- **Interactive and basic CLI:** full-screen `gitroll menu` / `gitroll -i` (arrow keys, live find, log, sync, switch Roll) and a step-by-step `gitroll log`; every command also runs without prompts, with `--plain` or outside a terminal.
- **Plain `gitroll`:** opens the Roll you're in (checking its shape), offers to set up an empty folder, and never changes a repository with other files.
- **`@gitroll/core`:** the format as a platform-free library.
- **Release artifacts:** a versioned package tarball with `SHA256SUMS`, build provenance, and generated Homebrew and Scoop definitions, each verified by installing on clean Linux, macOS and Windows machines.

### Experimental (hidden)
- **"Ask your Roll":** local AI answers with citations. Off unless `GITROLL_EXPERIMENTAL=ai` is set.

### Security
- Every read and write stays inside the Roll folder, and symbolic links are refused and reported.
- The local app binds to loopback only, with a per-session access key, CSP, CSRF and DNS-rebinding protection.
- Attachments are never cached by the browser, and active content is always downloaded rather than rendered.
- GPS location is removed from photos, and text that looks like a password, key or card number triggers a warning.
- Sync checks the real push destinations before every upload, and refuses public, unconfirmable, or untrusted non-GitHub destinations.
- Distributed builds include third-party license notices.
