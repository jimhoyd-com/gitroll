# Security and privacy

GitRoll is local-first software. There's no GitRoll server, account, database, analytics or telemetry. This page explains where data goes, what GitRoll protects against, and what it doesn't.

## Where your data lives

| Place | What's there | Who controls it |
| --- | --- | --- |
| Your computer | The Roll folder: events, photos, receipts, full history | You |
| Your GitHub repository (optional) | A copy, updated when you sync | You, and anyone you share with |
| GitRoll settings (`~/.config/gitroll`, or `%APPDATA%\GitRoll`) | Where your Rolls are, your display name, AI settings. No events. | You |
| Anywhere else | Nothing | |

GitRoll never asks for, stores or sends a GitHub password or token. Syncing runs your installed `git`, which uses your own SSH key or credential helper.

## Protections

**Local app**
- Listens only on `127.0.0.1`. Other addresses are refused, so other devices can't connect.
- Each run creates a random access key. The browser receives it once, from the link GitRoll opens, then keeps it in an HttpOnly, SameSite=Strict cookie. Other programs or users on the same computer can't read or change your Roll without it.
- Blocks DNS-rebinding requests (the Host header must be local) and cross-site form posts (writes must be JSON).
- A strict Content Security Policy: no third-party or inline scripts, no framing.
- Private responses and attachments are sent with `Cache-Control: no-store`, so receipts and photos aren't left in the browser cache.
- Uploaded HTML, SVG, XML and JavaScript are always downloaded, never rendered.

**Files**
- Every read and write is checked to stay inside the repository. GitRoll never follows symbolic links, and `gitroll check` reports any it finds.
- GitRoll reads and writes only `.gitroll/`, and commits only the files it wrote, so work in progress elsewhere in a repository is never swept into its commits.
- A link in an event is resolved inside the repository only. A link that climbs out of the root or starts at `/` is not an attachment, is never opened, and is reported by `gitroll check`.
- A file stored by GitRoll gets a readable name and never overwrites one that is already there (`ac-receipt-2.pdf`).
- A repository whose `template_version` is newer than the app blocks every write, so an older GitRoll can't half-rewrite a newer format.
- Templates can only add a config marker, a README and a theme stylesheet. Code, scripts and workflows are never copied into a Roll.

**Privacy**
- Location (GPS) data is removed from JPEG photos before they're saved. Turn this off per Roll with `attachments: { remove_location: false }`.
- Saving an event warns if the text looks like a password, API key, private key, card number or Social Security number, and `gitroll check` lists such events.
- Before every upload, sync checks each address `git push` would actually send to (including `pushurl` and `insteadOf` rewrites). It refuses if a GitHub repository is public, or if its privacy can't be confirmed (offline, rate limited). It also refuses non-GitHub hosts unless you explicitly run `gitroll trust <address>`. Nothing is cached, so every sync is checked.
- Events carry no author field. Who wrote and changed each one comes from Git history, so collaborators can't sign events as each other by editing a file.
- **"Ask your Roll" sends nothing anywhere by default.** It is off until you set it up, and a model on your own computer is what it offers first; with one, no part of an event leaves the machine. A non-local address has to be chosen deliberately, must be `https://`, and GitRoll says exactly what would be sent (your question and the text of the matching events; never attachments) before you turn it on. API keys are read from an environment variable you name and are never stored in settings or in a Roll. A Roll can turn Ask off for everyone with `ai: false`, and GitRoll honours that whatever an individual has set up.
- **AI never writes to a Roll.** An answer can be turned into a draft, and a draft is saved only when a person saves it.
- `gitroll doctor` reviews your setup: repository visibility, credentials embedded in the backup address, your email appearing in history, commit signing, settings file permissions and AI endpoint.

**Git behavior**
- Git runs without a shell, with prompts disabled and network timeouts, so a sync can't hang.
- GitRoll never force-pushes or rewrites history. When two people change the same event, both versions are kept.

**Supply chain**
- The installed package has no runtime dependencies; bundled third-party code is listed in `THIRD_PARTY_NOTICES.txt`.
- Rolls contain no workflows, so logging and syncing use no GitHub Actions.
- GitRoll's own repository uses CI pinned to commit SHAs, CodeQL and Dependabot.

## Limitations to understand

- **`.gitroll/` is a namespace, not a privacy boundary.** A log is exactly as visible as the repository it lives in. In a public repository, every event and every file in it is public.
- **You're responsible for keeping your repository private.** GitRoll checks GitHub's visibility before syncing, but can't check other Git hosts, and can't stop you from making the repository public later.
- **Delete isn't erasure.** Deleting an event hides it from the timeline, but it stays in Git history, as do its attachments, on every computer and repository that synced it. Truly removing data means rewriting history (for example with `git filter-repo`) on every copy. Removing a collaborator doesn't delete what they already downloaded.
- **Files aren't encrypted.** Anyone with access to your computer, your backups or the GitHub repository can read them. Use full-disk encryption on your devices.
- **Your email may be in history.** Git records the name and email you commit with. Use GitHub's noreply address if that matters to you.
- **No compliance certification.** GitRoll doesn't make you compliant with GDPR, HIPAA or similar rules. You (and GitHub, as your host) remain responsible for how the data is stored and shared.
- **AI answers can be wrong.** Always check the cited events.

## Reporting a vulnerability

Please report security issues privately with GitHub's "Report a vulnerability" button on the GitRoll repository, not in a public issue.
