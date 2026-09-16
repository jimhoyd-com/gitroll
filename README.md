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

**GitRoll is free and open source (MIT).** There are no accounts, subscriptions, usage limits, telemetry or servers. Use it for anything, personal or commercial, on as many computers and Rolls as you like.

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
- **Find:** type words in **Search**, or a filter like `has:photo`, `topic:house`, `after:2026-01-01` or `amount:>500`. Suggestions appear as you type; press `/` to jump to the box. The same filters work in `gitroll find`.
- **Edit:** open an event and click **Edit**. **History** shows every earlier version.
- **Back up:** GitRoll never uploads on its own. Your events are saved and committed the moment you write them; sending them to your backup is something you ask for — `gitroll sync`, `/sync` in the terminal app, or the indicator in the header of the browser app, which shows how far behind the backup is and why a sync failed.
- **Keyboard:** press `?` for the full list of shortcuts.
- **Ask:** press ✨ to set up a model — on your computer, so nothing leaves it — then ask questions in the search box. Every answer links to the events it came from. See [docs/AI.md](docs/AI.md).

If the page asks you to open GitRoll from the link in your terminal, copy that link. It's a per-session key that keeps other programs on your computer out.

## If you write code

A log that lives in the repository it is about answers the questions Git can't: why this, what we tried, what broke at 3am and what fixed it.

```bash
cd ~/code/my-project
gitroll log --template incident --code --editor "Checkout timeouts"
```

- **`--template`** opens one of `debugging`, `incident`, `deployment`, `experiment` or `decision` (an ADR) — headings worth answering, which you can delete if they don't apply.
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
gitroll log "AC serviced, capacitor replaced. $325" invoice.pdf
```

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
| `gitroll find "words"` | Find events |
| `gitroll sync` | Back up, and get changes from anyone you share with |
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

### Interactive or basic

- **Interactive:** `gitroll` (or `gitroll menu` / `gitroll -i`) opens a workspace that stays open. Your recent entries sit above a prompt; type what happened and press Enter to log it. Press `/` for commands with descriptions and autocomplete — `/log`, `/find`, `/topics`, `/roll`, `/sync`, `/status`, `/problems`, `/web`, `/help` — and `?` for the key list.

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

  `/find` searches as you type, shows the selected entry beside the results in a wide terminal, and gives you `Ctrl+O` to write a new entry, `Ctrl+E` to edit, `Ctrl+K` to duplicate and `Ctrl+D` to delete. Open an entry with Enter to edit (`e`), duplicate (`y`), attach files (`a`), see its history (`h`) or delete it (`d`). The header always says which Roll you're in, where it lives, and whether your entries are backed up. In a simple terminal it falls back to a numbered menu. Also, `gitroll log` with no text asks what happened, which files to attach (you can drag them into the terminal), and which project.
- **Basic:** every command also works in one line with no questions asked, for scripts and automation. Prompts and colors are off automatically outside a terminal, when `NO_COLOR` is set, or with `--plain`.

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

## For developers

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

[MIT](LICENSE). Bundled third-party licenses are listed in `dist/THIRD_PARTY_NOTICES.txt`.
