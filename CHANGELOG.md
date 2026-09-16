# Changelog

All notable changes to GitRoll are documented here. GitRoll follows [semantic versioning](https://semver.org). The Roll file format has its own version, documented in [SPEC.md](SPEC.md).

## Unreleased

### Added
- **A workspace in the terminal.** `gitroll` now opens a persistent prompt with your recent entries above it. Type what happened and press Enter to log it; press `/` for a searchable command menu (`/log`, `/find`, `/topics`, `/roll`, `/sync`, `/status`, `/undo`, `/web`, `/help`) with descriptions and autocomplete.
- **A complete composer** (Ctrl+O or `/log`): text over several lines, date, amount, type, tags, topics, type-specific fields and attachments, with topic and tag autocomplete, dragged or pasted file paths, and `Ctrl+E` to write in your own editor. Entries can be edited or duplicated from the composer too.
- **Unsaved drafts are kept.** Leaving the composer, switching Rolls or quitting keeps what you wrote, and GitRoll offers it again next time. Drafts live with your settings, never inside a Roll.
- **Interactive search** (`/find`): results as you type, arrow-key selection, a preview beside the list in a wide terminal, and edit, duplicate and delete without leaving it. Your query and selection are still there when you come back.
- **Undo deletion** with Ctrl+Z (or `/undo`), and the header now says which Roll you're in, where it lives, and whether it's saved only on this computer or backed up.
- **The Roll you switch to is remembered**, so it opens next time.
- **The workspace always says where it's writing:** the Roll, the branch and the folder, in the header. Saving names the file it wrote, and switching Rolls says which folder you landed in.
- **Saved, committed and backed up are three different things**, and the header keeps them apart: files changed in the folder but not committed are counted separately from changes committed here but not yet at your backup.
- **Git states that stop a sync explain themselves.** A detached HEAD, an unfinished merge or an unfinished rebase each say what still works (logging always does) and the command that clears it, instead of a branch name GitRoll guessed at. `gitroll status` reports the same.

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
- **Scoop (Windows):** `scoop bucket add gitroll https://github.com/jimhoyd-com/scoop-bucket`, then `scoop install gitroll/gitroll`. Every release installs the manifest with Scoop on Windows before publishing. `gitroll version`, `upgrade` and `uninstall` recognize Scoop installs.
- **npm:** `npm install --global gitroll`, published by the release workflow with provenance through npm trusted publishing (no stored npm token).

## 0.1.0 (2026-09-15)

First public release.

### Added
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
