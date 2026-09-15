# GitRoll

**A private logbook. Log what happened, find it later.**

Write down what happened: the AC was serviced, you paid the contractor, you opened a bank account. Add a photo or a receipt. Find it again in seconds, years later.

Your logbook, called a **Roll**, is a folder of plain files on your computer that you can back up to your own private GitHub repository.

**GitRoll is free and open source (MIT).** There are no accounts, subscriptions, usage limits, telemetry or servers. Use it for anything, personal or commercial, on as many computers and Rolls as you like.

## Install

GitRoll needs [Git](https://git-scm.com/downloads) and [Node.js](https://nodejs.org) 20 or newer.

**Mac or Linux:** download and run the installer. It fetches the latest release, verifies its SHA-256 checksum, and installs it.

```bash
curl -fsSL https://raw.githubusercontent.com/gitroll/gitroll/main/scripts/install.sh -o install.sh
```

```bash
sh install.sh
```

**Windows (or any system with Node.js):** download `gitroll-<version>.tgz` and `SHA256SUMS` from the [latest release](https://github.com/gitroll/gitroll/releases/latest), check the checksum, then install the downloaded file:

```bash
npm install -g gitroll-<version>.tgz
```

Every release is tested by installing it on clean Linux, macOS and Windows machines before it's published. Homebrew (`brew install gitroll/tap/gitroll`), Scoop and the npm registry are coming; they'll be listed here once they're live.

For one-command backup and sharing, also install the [GitHub CLI](https://cli.github.com) and run `gh auth login`. It's optional.

## Start

```bash
gitroll setup
```

This asks for a name, creates your Roll in `~/GitRoll`, and offers to back it up to a new **private** GitHub repository. After that, just run:

```bash
gitroll
```

GitRoll opens in your browser; keep the terminal open while you use it.

- **Log:** click **Log**, write what happened, and add photos or files. **More options** has project, kind, amount, date and tags. Then click **Save**.
- **Find:** type in **Search**, use **This month**, **This year** or **With files**, or click any project or `#tag`.
- **Edit:** open an entry and click **Edit**. **History** shows every earlier version.
- **Back up:** click **Sync**. The number on the button counts changes that aren't backed up yet.

If the page asks you to open GitRoll from the link in your terminal, copy that link. It's a per-session key that keeps other programs on your computer out.

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
| `gitroll` | Open GitRoll in your browser |
| `gitroll log "text" [files]` | Log something, with optional photos or receipts |
| `gitroll find "words"` | Find events |
| `gitroll sync` | Back up, and get changes from anyone you share with |
| `gitroll rolls` / `gitroll switch <name>` | See your Rolls and pick one |
| `gitroll new "Business" --github` | Create another Roll with a private GitHub backup |
| `gitroll share <github-user>` | Let someone else log in this Roll |
| `gitroll doctor` | Check your setup, privacy and backup |
| `gitroll help more` | Everything else |

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
