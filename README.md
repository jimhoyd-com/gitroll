# GitRoll

**A private logbook. Log what happened, find it later.**

Write down what happened: the AC was serviced, you paid the contractor, you opened a bank account. Add a photo or a receipt. Find it again in seconds, years later.

Your logbook, called a **Roll**, is a folder of plain files on your computer that you can back up to your own private GitHub repository.

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

- **Log:** start typing in the box at the top and click **Save** (or press `n` from anywhere, and `Ctrl`/`⌘`+`Enter` to save). Text is Markdown, `#tags` and amounts like `$40` are picked up as you type, and photos and files can be dropped or pasted straight in. The row of buttons under the box sets the type, the topic, when it happened and the amount — including logging something that happened last week.
- **Find:** type words in **Search**, or a filter like `has:photo`, `topic:house`, `after:2026-01-01` or `amount:>500`. Suggestions appear as you type; press `/` to jump to the box. The same filters work in `gitroll find`.
- **Edit:** open an event and click **Edit**. **History** shows every earlier version.
- **Back up:** GitRoll never uploads on its own. Your events are saved and committed the moment you write them; sending them to your backup is something you ask for — `gitroll sync`, `/sync` in the terminal app, or the indicator in the header of the browser app, which shows how far behind the backup is and why a sync failed.
- **Keyboard:** press `?` for the full list of shortcuts.

If the page asks you to open GitRoll from the link in your terminal, copy that link. It's a per-session key that keeps other programs on your computer out.

## Your data lives in your own repository

You don't fork or clone this repository to use GitRoll; it holds only the app's source code. `gitroll setup` creates a separate **private** repository in your own GitHub account for your Roll, containing only your entries and files. (A fork of this public repository couldn't be made private.)

## Upgrading

Your Rolls contain no app code, so upgrading never changes them: new versions read the same files. If a future version ever needs to change the file format, it will tell you and make the change as a normal commit you can review.

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

3. Open it:

   ```bash
   cd my-roll && gitroll
   ```

   GitRoll checks the Roll, adds it to your list, and opens it. To add it without opening, run `gitroll rolls add .` instead.

Running `gitroll` inside an **empty** folder or freshly cloned empty repository offers to set it up as a Roll. GitRoll never changes a folder that already has other files in it.

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
| `gitroll rolls add [folder]` | Add a Roll you cloned yourself |
| `gitroll new "Business" --github` | Create another Roll with a private GitHub backup |
| `gitroll share <github-user>` | Let someone else log in this Roll |
| `gitroll doctor` | Check your setup, privacy and backup |
| `gitroll help more` | Everything else |

### Interactive or basic

- **Interactive:** `gitroll` (or `gitroll menu` / `gitroll -i`) opens a workspace that stays open. Your recent entries sit above a prompt; type what happened and press Enter to log it. Press `/` for commands with descriptions and autocomplete — `/log`, `/find`, `/topics`, `/roll`, `/sync`, `/status`, `/problems`, `/deleted`, `/web`, `/help` — and `?` for the key list.

  | Key | What it does |
  | --- | --- |
  | Enter | Log what's in the prompt, or open the entry you picked |
  | ↑ ↓ | Pick one of the recent entries above the prompt |
  | Ctrl+O | Open the full composer: text over several lines, date, amount, type, tags, topics and files, with topic and tag autocomplete |
  | Ctrl+S | Save, in the composer |
  | Ctrl+E | Edit the text in your own editor (`EDITOR` or `VISUAL`) |
  | Ctrl+Z | Undo the last deletion |
  | Ctrl+R | Re-read the Roll from its folder |
  | Esc | Go back, one step at a time |
  | Ctrl+C | Quit — unsaved text is kept as a draft and offered again next time |

  `/find` searches as you type, shows the selected entry beside the results in a wide terminal, and gives you `Ctrl+O` to write a new entry, `Ctrl+E` to edit, `Ctrl+K` to duplicate and `Ctrl+D` to delete. Open an entry with Enter to edit (`e`), duplicate (`y`), attach files (`a`), open one of its files in the application that normally opens it (`o`, `Tab` to pick another), see its history (`h`) or delete it (`d`). Attached files are copied into the Roll, so the originals can move or go; removing one from an entry leaves the copy where it is, since another entry may use the same file. Deleting an entry only takes it off the timeline: `/deleted` lists what has gone and puts any of it back as a new change. The header always says which Roll you're in, where it lives, and whether your entries are backed up. In a simple terminal it falls back to a numbered menu. Also, `gitroll log` with no text asks what happened, which files to attach (you can drag them into the terminal), and which project.
- **Basic:** every command also works in one line with no questions asked, for scripts and automation. Prompts and colors are off automatically outside a terminal, when `NO_COLOR` is set, or with `--plain`.

## Sharing a Roll

```bash
gitroll share partner-github-name
```

They accept the GitHub invitation, install GitRoll, and run `gitroll join you/home`. Everyone syncs with the same private repository. If two people edit the same entry, GitRoll keeps both versions and tags the entry `#conflict`. See [docs/SHARING.md](docs/SHARING.md).

## Templates and themes

Add your own kinds of entries, save a Roll's setup as a template for new Rolls, and restyle GitRoll with a small CSS file. See [docs/TEMPLATES.md](docs/TEMPLATES.md).

## Privacy

- Your entries live only on your computer and, if you back up, in your own GitHub repository. GitRoll collects nothing and keeps no copy.
- It removes location data from photos, and warns before you save something that looks like a password or card number.
- Before every sync it confirms your backup repository is private, and refuses to upload if it's public or it can't tell. It only opens on your own computer.
- **Limitations:** files aren't encrypted, and deleting an entry doesn't erase it from history.

Details are in [SECURITY.md](SECURITY.md).

## For developers

Every entry is a Markdown file with YAML front matter, so `git clone` gives you everything and your records stay readable without GitRoll. The format is specified in [SPEC.md](SPEC.md). The same rules are available as a library, [`@gitroll/core`](packages/core), for building your own tools.

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
| `src/core` | The GitRoll Format: parsing, validation, event types, search, privacy checks (published as `@gitroll/core`) |
| `src/node` | Git operations, the CLI and the local web server |
| `src/web` | The browser interface |
| `template` | Starter files for a new Roll (data only: no code or workflows) |

## GitRoll.com

GitRoll.com is an optional, separate, paid service for using your Rolls from any browser or phone. It isn't part of this repository, and the free app never needs it. Your Rolls work the same with or without it.

## License

[MIT](LICENSE). Bundled third-party licenses are listed in `dist/THIRD_PARTY_NOTICES.txt`.
