# GitRoll

**A private logbook. Log what happened, find it later.**

Write down what happened: the AC was serviced, you paid the contractor, you opened a bank account. Add a photo or a receipt. Find it again in seconds, years later.

Your logbook, called a **Roll**, is a `.gitroll/` folder of plain Markdown files in a Git repository of your own — either a repository just for the log, or one that already holds a project.

**You don't need GitRoll to keep one.** An event is a Markdown file:

```
.gitroll/events/2026-09-15-ac-serviced.md
```

```markdown
# AC serviced

Replaced the capacitor. Paid $325.
One-year warranty on the repair.

[Receipt](../files/ac-receipt.pdf)
```

Commit it, push it, done. No front matter, no ids, no timestamps — the date comes from the file name. GitRoll is an app that reads and writes exactly this, and everything it can do, you can do with a text editor. The whole format is in [SPEC.md](SPEC.md).

**GitRoll is free and source available.** There are no accounts, subscriptions, usage limits, telemetry or servers. Use it at home and at work, including for paid client work, on as many computers and Rolls as you like. The one thing you may not do is use GitRoll to build a product that competes with GitRoll or with GitRoll.com. See [License](#license).

## Install

GitRoll needs [Git](https://git-scm.com/downloads) and [Node.js](https://nodejs.org) 20 or newer.

**Homebrew (Mac or Linux):**

```bash
brew install jimhoyd-com/tap/gitroll
```

**Mac or Linux without Homebrew:** download and run the installer. It fetches the latest release, verifies its SHA-256 checksum, and installs it.

```bash
curl -fsSL https://raw.githubusercontent.com/jimhoyd-com/gitroll/main/scripts/install.sh -o install.sh
```

```bash
sh install.sh
```

**Windows, with [Scoop](https://scoop.sh):**

```powershell
scoop bucket add gitroll https://github.com/jimhoyd-com/scoop-bucket
scoop install gitroll/gitroll
```

**Any system with Node.js, from npm:** published with [provenance](https://docs.npmjs.com/generating-provenance-statements), so you can check it was built by this repository's release workflow.

```bash
npm install --global gitroll
```

Every release is tested by installing it on clean Linux, macOS and Windows machines, with Homebrew and with Scoop, before it's published. Each release also has the package and `SHA256SUMS` on the [releases page](https://github.com/jimhoyd-com/gitroll/releases/latest) if you'd rather download and check it yourself.

For one-command backup and sharing, also install the [GitHub CLI](https://cli.github.com) and run `gh auth login`. It's optional.

## Start

```bash
gitroll setup
```

This asks for a name, creates your Roll in `~/GitRoll`, and offers to back it up to a new **private** GitHub repository. After that, just run:

```bash
gitroll
```

GitRoll opens right in your terminal: use ↑↓ to browse, `n` to log, `/` to find and `q` to quit. Prefer clicking? Press `o` (or run `gitroll open`) to use it in your browser; keep the terminal open while you do.

In the browser:

- **Log:** start typing in the box at the top and click **Save** (or press `n` from anywhere, and `Ctrl`/`⌘`+`Enter` to save). Text is Markdown, `#tags` and amounts like `$40` are picked up as you type, and photos and files can be dropped or pasted straight in. The row of buttons under the box sets the topic, the date and the amount — including logging something that happened last week.
- **Find:** type words in **Search**, or a filter like `has:photo`, `topic:house`, `after:2026-01-01` or `amount:>500`. Suggestions appear as you type; press `/` to jump to the box. The same filters work in `gitroll find`. The buttons under the box are yours to choose — see [Buttons under the search box](#buttons-under-the-search-box).
- **Edit:** open an event and click **Edit**. **History** shows every earlier version.
- **Back up:** GitRoll never uploads on its own. Your events are saved and committed the moment you write them; sending them to your backup is something you ask for — `gitroll sync`, `/sync` in the terminal app, or the indicator in the header of the browser app, which shows how far behind the backup is and why a sync failed.
- **Start from something:** the **Template** button fills the box with headings worth answering — a journal entry, a learning note, what a repair cost and when it's due again, what you bought and where the receipt is, or how a project is going. They're ordinary Markdown: delete the headings you don't want. `gitroll templates` lists them, and you can write your own — a Markdown file in `.gitroll/templates/` — or keep none of GitRoll's. See [docs/TEMPLATES.md](docs/TEMPLATES.md).
- **Keyboard:** press `?` for the full list of shortcuts.
- **Ask:** press ✨ to set up a model — on your computer, so nothing leaves it — then ask questions in the search box. Every answer links to the events it came from. See [docs/AI.md](docs/AI.md).

If the page asks you to open GitRoll from the link in your terminal, copy that link. It's a per-session key that keeps other programs on your computer out.

## If you write code

A log that lives in the repository it is about answers the questions Git can't: why this, what we tried, what broke at 3am and what fixed it.

```bash
cd ~/code/my-project
gitroll log --template incident --code --editor "Checkout timeouts"
```

- **`--template`** opens one of `debugging`, `incident`, `deployment`, `experiment` or `decision` (an ADR) — headings worth answering, which you can delete if they don't apply. There are everyday ones too (`progress`, `learning`, `journal`, `maintenance`, `purchase`); `gitroll templates` lists both sets.
- **`--code`** records the repository, branch and commit you're on, so the event knows which work it is about.
- **`--editor`** writes it in `$VISUAL` or `$EDITOR`.

Then `#412`, `owner/repo#412`, a commit SHA or a GitHub URL in the text become links to the right repository, and an ordinary Markdown link to another event (`[the incident](2026-09-14-checkout-timeouts.md)`) shows up on both events — the second one as a backlink.

The header (in the browser and the terminal) and `gitroll status` show which repository and **branch** the log itself is on, so you always know where what you write is going. `gitroll completion bash|zsh|fish` prints a completion script for commands, Rolls, templates, tags and saved searches.

| Command | What it does |
| --- | --- |
| `gitroll ask "what broke in checkout last month?"` | Answer from your events, with links to them |
| `gitroll summary --since 2026-09-01` | Draft an update from what you logged. Nothing is saved until you save it. |
| `gitroll restore <file>` | Put an earlier version back, as a new commit |
| `gitroll conflicts` / `gitroll resolve <file> --mine` | Settle an event that was changed in two places |
| `gitroll related <file>` | What it links to, and what links back |
| `gitroll find "tag:incident" --save incidents` | Keep a search; run it later with `gitroll find @incidents` |
| `gitroll find "postgres" --all` | Search every Roll you have |
| `gitroll import github` / `gitroll import ci` | Log merged pull requests and releases, and builds that failed |

A lot of what happened is already written down in merged pull requests and in the build that broke at 3am. `gitroll import github` and `gitroll import ci` bring those in as ordinary events — failures only by default, picking up where the last import left off, and never logging the same thing twice. See [docs/IMPORT.md](docs/IMPORT.md).

### When the log shares a repository with your work

By default, logging an event commits it straight away. In a repository that only holds a log, that is exactly right. In one that also holds a project, it means a commit landing in the middle of your branch while you are halfway through something — and running your team's commit hooks on a Markdown file they were never written for.

Two lines in `.gitroll/config.yaml` settle both:

```yaml
commit: manual                    # write events; leave committing to me
commit_prefix: "chore(gitroll): " # keep the team's commit convention
```

- **`commit: manual`** writes the event and stops there. Nothing is at risk: the file is on disk before Git is asked anything, `gitroll status` counts what is waiting rather than calling it backed up, and `gitroll save` (or `/save`, or your own `git commit`) commits it when it suits you — including as part of the commit the work belongs to.
- **`commit_prefix`** goes in front of every message GitRoll writes, exactly as you type it, so `chore(gitroll): log: replaced the tap` satisfies a Conventional Commits check. GitRoll's own word still says which kind of change it was.
- **Your hooks still run.** GitRoll doesn't pass `--no-verify`: a repository that scans for secrets before every commit should scan a log entry too. If a hook refuses the commit, the event is already written and GitRoll says so, names the hook, and tells you both ways forward — fix the hook's complaint and `gitroll save`, or switch that Roll to `commit: manual`.

`gitroll status --json` reports `"commit": "auto"` or `"manual"` alongside `uncommittedLog`, so a script can tell a Roll that is waiting to be committed from one that has fallen behind.

## Adding a log to a project you already have

Run `gitroll` inside any Git repository. If it has no log yet, GitRoll offers to add one, to open a different Roll, or to cancel — and it creates nothing until you say so:

```bash
cd ~/code/my-project
gitroll
```

Choosing *Add a log to this repository* creates `.gitroll/` and nothing else. Your project's own README, files and branch are untouched, and GitRoll commits only the files it wrote, so anything you had staged or half-finished stays exactly as it was. From then on, decisions, incidents and releases live next to the code they are about:

```
.gitroll/events/2026-09-15-auth-decision.md
```

**`.gitroll/` is a namespace, not a privacy boundary.** The log is exactly as visible as the repository it lives in, so a log in a public repository is public.

## Your data lives in your own repository

You don't fork or clone this repository to use GitRoll; it holds only the app's source code. `gitroll setup` creates a separate **private** repository in your own GitHub account for your Roll, containing only your events and files. (A fork of this public repository couldn't be made private.)

## Upgrading

Your Rolls contain no app code, so upgrading never changes them: new versions read the same files. `.gitroll/config.yaml` records which template revision your repository follows:

```yaml
template_version: 1
```

GitRoll reads that marker and never changes it while logging or editing — upgrading the app does not upgrade your repository. If a future version ever needs to change the format, it will say so, make the change as a normal commit you can review, and update the marker only once that has worked. A repository whose template is newer than your app refuses writes and tells you to upgrade; one that doesn't record a version is reported as unknown rather than assumed to be current (`gitroll template --set 1` records it).

| How you installed | Upgrade with |
| --- | --- |
| Homebrew | `brew upgrade gitroll` (or `gitroll upgrade`) |
| Scoop (Windows) | `scoop update gitroll` (or `gitroll upgrade`) |
| The installer, or npm | `gitroll upgrade`. It downloads the latest release, checks it against `SHA256SUMS`, and installs it. Running the installer again, or `npm install --global gitroll@latest`, also works. |
| From source | `git pull && npm ci && npm run build` |

Not sure? `gitroll version` shows the version and how it was installed. `gitroll upgrade --dry-run` shows what would happen without changing anything.

## Uninstalling

Uninstalling removes the app only. **Your Rolls are never deleted:** they're ordinary folders (in `~/GitRoll` by default) and your private GitHub repositories, and they keep working if you reinstall later.

```bash
gitroll uninstall
```

It shows what it removes and what it keeps, then asks before doing anything. Add `--remove-settings` to also delete GitRoll's settings (your list of Rolls and trusted backups, in `~/.config/gitroll` or `%APPDATA%\GitRoll`), or `--dry-run` to only see the plan.

If the `gitroll` command no longer works, remove it directly:

| How you installed | Uninstall with |
| --- | --- |
| Homebrew | `brew uninstall gitroll` |
| Scoop (Windows) | `scoop uninstall gitroll` |
| The installer, or npm (Mac, Linux, Windows) | `npm uninstall --global gitroll` |
| Mac or Linux, any method | [`scripts/uninstall.sh`](scripts/uninstall.sh): download it, read it, then run `sh uninstall.sh` (add `--remove-settings` to also remove settings) |

To delete a Roll as well, remove its folder and, if you backed it up, delete its repository on GitHub. That's permanent.

## Advanced: start from the template

Prefer to skip `gitroll setup`? Every release publishes the starter files to [jimhoyd-com/gitroll-template](https://github.com/jimhoyd-com/gitroll-template):

1. Click **Use this template → Create a new repository**, and choose **Private**.
2. Clone your new repository:

   ```bash
   git clone git@github.com:you/my-roll.git
   ```

3. Log something — with or without GitRoll:

   ```bash
   cd my-roll
   $EDITOR .gitroll/events/2026-09-15-ac-serviced.md
   git add .gitroll && git commit -m "AC serviced" && git push
   ```

   Or open it in the app, which checks the log, adds it to your list, and opens it:

   ```bash
   cd my-roll && gitroll
   ```

   To add it without opening, run `gitroll rolls add .` instead.

Running `gitroll` inside an **empty** folder offers to make it a Roll; inside a repository that already holds a project, it offers to add a `.gitroll/` folder to it. Either way it asks first and never touches anything else.

## Everyday commands

```bash
gitroll log 'AC serviced, capacitor replaced. $325' invoice.pdf
```

Single quotes, because `"… $325"` in bash and zsh expands `$3` and logs `25`. In PowerShell, use single quotes too:

```powershell
gitroll log 'AC serviced, capacitor replaced. $325' invoice.pdf
```

The amount can also be a field of its own, which is what search and totals read: `gitroll log 'AC serviced' --amount '$325'`.

```bash
gitroll find "capacitor"
```

```bash
gitroll sync
```

| Command | What it does |
| --- | --- |
| `gitroll` | Open GitRoll in the terminal (`/web` opens the browser app) |
| `gitroll open` | Open GitRoll in your browser |
| `gitroll upgrade` / `gitroll uninstall` | Get the latest version, or remove the app (your Rolls stay) |
| `gitroll menu` or `gitroll -i` | The workspace: type an entry at the prompt, `/` for commands, ↑↓ to browse |
| `gitroll log "text" [files]` | Log something, with optional photos or receipts |
| `gitroll capture` | Quick Capture: a small window over whatever you're doing ([docs/CAPTURE.md](docs/CAPTURE.md)) |
| `gitroll inbox [name]` | The Roll Quick Capture saves into |
| `gitroll shortcut "Ctrl+Alt+L"` | Bind a key to `gitroll capture` using your desktop's own settings |
| `gitroll find "words"` | Find events (see [What search looks at](#what-search-looks-at)) |
| `gitroll sync` | Back up, and get changes from anyone you share with (uploads the whole branch — see [What backing up covers](#what-backing-up-covers)) |
| `gitroll save` | Commit log files you edited by hand, so a backup includes them |
| `gitroll deleted` / `gitroll undelete <file>` | See what you deleted, and put any of it back |
| `gitroll rolls` / `gitroll switch <name>` | See your Rolls and pick one |
| `gitroll rolls add [folder]` | Add a repository with a log that you cloned yourself |
| `gitroll init --dir <folder>` | Add a log (`.gitroll/`) to a repository you already have |
| `gitroll move <file> <new path>` | Rename or reorganize an event, keeping its links and history |
| `gitroll template` | Show the repository's template version (`--set 1` records one) |
| `gitroll new "Business" --github` | Create another Roll with a private GitHub backup |
| `gitroll share <github-user>` | Let someone else log in this Roll |
| `gitroll ai` / `gitroll ask "…"` | Set up a model, then ask questions of your own events |
| `gitroll log --template incident --code` | Start from a template, recording the branch and commit you're on |
| `gitroll restore <file>` / `gitroll conflicts` | Put a version back; settle an event changed in two places |
| `gitroll import github` / `gitroll import ci` | Log merged pull requests, releases and failed builds ([docs/IMPORT.md](docs/IMPORT.md)) |
| `gitroll completion <shell>` | Completion for bash, zsh or fish |
| `gitroll doctor` | Check your setup, privacy and backup |
| `gitroll help more` | Everything else |

### Quick Capture

A thought arrives while you are in an editor, a terminal, a browser, a meeting.
`gitroll capture` opens a small window over whatever you are doing, takes it,
and closes:

```bash
gitroll inbox inbox              # once: where captures go (a private Roll of your own)
gitroll shortcut "Ctrl+Alt+L"    # optional: bind a key to it
gitroll capture                  # any time
```

`⌘Enter` (macOS) or `Ctrl+Enter` saves and closes. `Esc` puts it away and keeps
the draft. `⌘K` / `Ctrl+K` picks a different Roll without touching a character
of what you have written. The destination is on screen the whole time, it is the
one you chose rather than one guessed from the application in front of you, and
a Roll that lives inside a project repository says **Shared with repository** on
every draft addressed to it.

A capture is an ordinary event in an ordinary commit — the same writer, the same
files, no upload. If the commit fails, the window says so and keeps your text
rather than closing as though it had saved. The shortcut is your desktop's own,
so nothing runs in the background, and `gitroll capture` works whether or not
you ever bind a key. See [docs/CAPTURE.md](docs/CAPTURE.md) for the per-platform
detail, the limitations, and why there is no Electron app.

### Interactive or basic

- **Interactive:** `gitroll` (or `gitroll menu` / `gitroll -i`) opens a workspace that stays open. Your recent entries sit above a prompt; type what happened and press Enter to log it. Press `/` for commands with descriptions and autocomplete — `/log`, `/find`, `/topics`, `/roll`, `/sync`, `/status`, `/problems`, `/deleted`, `/web`, `/help` — and `?` for the key list.

  | Key | What it does |
  | --- | --- |
  | Enter | Log what's in the prompt, or open the entry you picked |
  | ↑ ↓ | Pick one of the recent entries above the prompt |
  | Ctrl+O | Open the full composer: text over several lines, date, amount, tags, topics and files, with topic and tag autocomplete |
  | Ctrl+S | Save, in the composer |
  | Ctrl+E | Edit the text in your own editor (`EDITOR` or `VISUAL`) |
  | Ctrl+Z | Undo the last deletion |
  | Ctrl+R | Re-read the Roll from its folder |
  | Esc | Go back, one step at a time |
  | Ctrl+C | Quit — unsaved text is kept as a draft and offered again next time |

  `/find` searches as you type, shows the selected entry beside the results in a wide terminal, and gives you `Ctrl+O` to write a new entry, `Ctrl+E` to edit, `Ctrl+K` to duplicate and `Ctrl+D` to delete. Open an entry with Enter to edit (`e`), duplicate (`y`), attach files (`a`), open one of its files in the application that normally opens it (`o`, `Tab` to pick another), see its history (`h`) or delete it (`d`). Attached files are copied into `.gitroll/files/` and linked from the event, so the originals can move or go; unlinking one leaves the copy where it is, since another event may link the same file. Deleting an event only takes it off the timeline: `/deleted` lists what has gone and puts any of it back as a new change. The header always says which Roll you're in, where it lives, and whether your entries are backed up. In a simple terminal it falls back to a numbered menu. Also, `gitroll log` with no text asks what happened, which files to attach (you can drag them into the terminal), and which topic.
- **Basic:** every command also works in one line with no questions asked, for scripts and automation. Prompts and colors are off automatically outside a terminal, when `NO_COLOR` is set, or with `--plain`.

### What search looks at

`gitroll find`, `/find` in the terminal app and the search box in the browser all read the same thing: **what you wrote.**

| Searched | Not searched |
| --- | --- |
| The words of an event, and its title | What's inside an attached file — no PDF text, no text in photos |
| Its topics and tags | Other Rolls, unless you ask with `--all` |
| Its amount and currency | Events you deleted (`/deleted` lists those) |
| Anything in its front matter | Older versions of an event (`gitroll history <id>` shows those) |
| Its file name, and the names of files attached to it | |

It covers this Roll as its files are right now, on the branch you're on. Filters combine: `topic:house tag:payment after:2026-01-01 before:2026-06-30 amount:>500 has:photo by:jimmy`.

### Buttons under the search box

Today, This month and This year, unless your Roll says otherwise. Which searches deserve one click depends on what you keep in it, so they are a list in `.gitroll/config.yaml`:

```yaml
filters:
  - today
  - this-month
  - has:photo                    # one of GitRoll's, back again
  - label: Unpaid                # or one of your own
    query: tag:unpaid
  - label: Big jobs
    query: "amount:>500 topic:house"
```

Each one is a toggle over whatever is already in the box, in the order you list them. `filters: []` means no buttons at all. Leave the key out and you get the three defaults — **With a photo** isn't among them, because a button that matches almost nothing in most Rolls is a button in the way; the line above puts it back.

### What backing up covers

Three different things, kept apart because confusing them is how writing gets lost:

| Word | What it means |
| --- | --- |
| **Saved** | The words are in a file in your folder. Logging through GitRoll saves *and* commits, in one step. |
| **Committed** | Git has a version of it. An event you wrote by hand in your own editor is saved but not committed until you run `gitroll save` (or commit it yourself). |
| **Backed up** | The commits are on the backup you connected. Only what is committed can be uploaded. |

`gitroll status` counts them separately and never calls a Roll synced while writing on this computer isn't, and so does the browser app's backup panel.

Backing up runs `git push`, which uploads **the whole branch, not just the log**. In a Roll of its own that is the same thing. In a log that lives beside a project, any commit of yours waiting to go — code included — goes with it; `gitroll sync` says so and asks before it does, and `--yes` answers that question in a script. If you would rather your project pushed on its own schedule, don't use `gitroll sync` there: commit through GitRoll and push with Git the way you already do.

## Sharing a Roll

```bash
gitroll share partner-github-name
```

They accept the GitHub invitation, install GitRoll, and run `gitroll join you/home`. Everyone syncs with the same private repository. If two people edit the same entry, GitRoll keeps both versions and tags the entry `#conflict`. See [docs/SHARING.md](docs/SHARING.md).

## Templates and themes

Start new Rolls from a template repository, and restyle GitRoll with a small CSS file. See [docs/TEMPLATES.md](docs/TEMPLATES.md).

## Privacy

- Your events live only on your computer and, if you back up, in your own GitHub repository. GitRoll collects nothing and keeps no copy.
- **Ask uses the model you choose.** With one on your computer, nothing leaves it. With a hosted provider, GitRoll says exactly what is sent before you turn it on, never sends attachments, and never stores your API key — it reads the environment variable you name. A Roll can turn Ask off for everyone with `ai: false`.
- A log is as visible as the repository it is in. `.gitroll/` is a namespace, not a privacy boundary: in a public repository, the log is public.
- It removes location data from photos, and warns before you save something that looks like a password or card number.
- Before every sync it confirms your backup repository is private, and refuses to upload if it's public or it can't tell. It only opens on your own computer.
- **Limitations:** files aren't encrypted, and deleting an entry doesn't erase it from history.

Details are in [SECURITY.md](SECURITY.md).

### GitRoll runs on your computer, not on your phone

This is a decision, not an oversight. GitRoll is a program on a computer you own, writing to a folder you own; the browser app is served from that computer to that computer and signs in with a link printed in your terminal. There is no GitRoll server, and nothing to log in to.

So there is no phone app and no way to log something from a phone. The browser app's layout does adapt to a narrow window, which is about a small window on a laptop — **that is not phone access, and it should not be read as any**. Exposing the local server to your network to reach it from a phone would put your logbook on whatever network you're on, behind a link meant for one machine; don't, and GitRoll won't help you do it.

If you want what you logged while away from your desk, the honest paths today are the ones you already have: write it wherever you write things and log it later, or commit a Markdown file to the repository from anywhere you can reach Git. Phone capture worth having would need somewhere for events to pass through, and deciding what that means for a private logbook is a bigger question than a layout.

## For developers

### Using GitRoll from an AI agent

Run `gitroll help agent --json` for an offline agent guide. `gitroll schema`
lists commands, arguments, accepted flags, side effects and output contracts;
`gitroll schema edit` or `gitroll edit --help` describes one command.

```bash
gitroll find 'tag:incident' -C /path/to/roll --json --limit 10 --fields path,title
gitroll log 'Fixed checkout timeout' -C /path/to/roll --json --idempotency-key incident-412
```

`--json` implies `--non-interactive`: GitRoll won't prompt, open an editor, or
launch a workspace/browser. Commands that do not support JSON reject it before
running. Unsupported flags also fail before execution: `log --dry-run` cannot
accidentally write an event. Use `gitroll schema <command>` to discover what is
supported.

JSON results go to stdout. Thrown errors go to stderr as
`{ "error": { "code": "…", "message": "…" } }` and exit 1. Diagnostic commands
such as `check`, `ai test`, and `sync` return their JSON report on stdout even
when they exit 1. Always check the exit status.

Use the same idempotency key and input to retry a log without another commit.
Keys survive edits, moves and clones; deleting an event or its source metadata
releases its key. For edits, read the `revision` from `show --json` and pass it
back with `edit --expect <revision>` to reject a stale edit. `find`, `today`, and
`recent` accept `--limit`, `--offset`, and JSON `--fields` selection. Offset pages
reflect the current files, so concurrent changes can shift results.

Logging and editing commit locally; uploading requires an explicit sync. For
an unattended workflow, pass text explicitly or pipe it into `log`, select the
Roll with `-C` or `--roll`, and avoid editor options. See [docs/CLI.md](docs/CLI.md)
for the full automation contract.

Every event is a Markdown file, front matter optional, so `git clone` gives you everything and your records stay readable — and writable — without GitRoll. The format is specified in [SPEC.md](SPEC.md). The same rules are available as a library, [`@gitroll/core`](packages/core), for building your own tools.

```bash
make setup
```

```bash
make check
```

```bash
make demo
```

Run `make` to list every shortcut. See [CONTRIBUTING.md](CONTRIBUTING.md) to contribute and [packaging/README.md](packaging/README.md) for releases.

| Path | What it is |
| --- | --- |
| `src/core` | The GitRoll format: parsing, validation, search, privacy checks (published as `@gitroll/core`) |
| `src/node` | Git operations, the CLI and the local web server |
| `src/web` | The browser interface |
| `template` | Starter files for a new Roll: a `.gitroll/` folder and a short root README (data only: no code or workflows) |

## GitRoll.com

GitRoll.com is an optional, separate, paid service for using your Rolls from any browser or phone. It isn't part of this repository, and the free app never needs it. Your Rolls work the same with or without it.

## License

GitRoll 0.4.0 and later is licensed under the [PolyForm Shield License 1.0.0](LICENSE).

GitRoll is **source available**, not open source: the source is public and you
may read, run, change and share it, but one purpose is carved out. It does not
meet the Open Source Definition, and saying otherwise would be inaccurate.

**Free, no permission needed:**

- Personal use, on any number of computers and Rolls.
- Use inside a company, of any size, for its own work.
- Paid work for clients — consulting, contracting, agency work — where GitRoll
  is a tool you use rather than the product you sell.
- Reading, changing, forking and sharing the source, with the notices kept.

**Needs a separate license from me:**

- Providing a product or service that competes with GitRoll or with GitRoll.com,
  including a hosted or managed GitRoll, free or paid.
- Reselling GitRoll, or bundling it into a product sold as a substitute for it.

If you want to do something in the second list, email jimhoyd@gmail.com — commercial
licenses are available and I would rather say yes than have you guess.

Common questions — using it at work, billing clients for work logged in it,
forking it, running it for a team — are answered in
[docs/LICENSE-FAQ.md](docs/LICENSE-FAQ.md).

**Earlier versions stay MIT.** Releases through 0.3.0 were published under the
MIT License and remain under it forever, with every permission it granted. See
[LICENSE-MIT-HISTORICAL](LICENSE-MIT-HISTORICAL).

Bundled third-party components keep their own licenses, which this change does
not affect; they are listed in `dist/THIRD_PARTY_NOTICES.txt`.
