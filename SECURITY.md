# Security and privacy

GitRoll is local-first software. There's no GitRoll server, account, database, analytics or telemetry. This page explains where data goes, what GitRoll protects against, and what it doesn't.

## Where your data lives

| Place | What's there | Who controls it |
| --- | --- | --- |
| Your computer | The Roll folder: events, photos, receipts, full history | You |
| Your GitHub repository (optional) | A copy, updated when you sync | You, and anyone you share with |
| GitRoll settings (`~/.config/gitroll`, or `%APPDATA%\GitRoll`) | Where your Rolls are, your display name, saved searches, and your secret keys for sealed content (`keys.txt`, if you made one). No events. | You |
| Anywhere else | Nothing | |

GitRoll never asks for, stores or sends a GitHub password or token. Syncing runs your installed `git`, which uses your own SSH key or credential helper.

## Protections

**Local app**
- Listens only on `127.0.0.1`. Other addresses are refused, so other devices can't connect.
- Each run creates a random access key. The browser receives it once, from the link GitRoll opens, then keeps it in an HttpOnly, SameSite=Strict cookie. Other programs or users on the same computer can't read or change your Roll without it.
- **All Rolls** searches the other Rolls on your list from a browser already signed in with that key, and changes nothing in them. Following a result into another Roll starts that Roll's app on its own port with its own random key, and hands the link to that same signed-in browser only.
- Blocks DNS-rebinding requests (the Host header must be local) and cross-site form posts (writes must be JSON).
- A strict Content Security Policy: no third-party or inline scripts, no framing.
- Private responses and attachments are sent with `Cache-Control: no-store`, so receipts and photos aren't left in the browser cache.
- Uploaded HTML, SVG, XML and JavaScript are always downloaded, never rendered.

**Files**
- Every read and write is checked to stay inside the repository. GitRoll never follows symbolic links, and `gitroll check` reports any it finds.
- GitRoll reads and writes only `.gitroll/`, and commits only the files it wrote, so work in progress elsewhere in a repository is never swept into its commits.
- A link in an event is resolved inside the repository only. A link that climbs out of the root or starts at `/` is not an attachment, is never opened, and is reported by `gitroll check`.
- A file stored by GitRoll gets a readable name and never overwrites one that is already there (`ac-receipt-2.pdf`).
- `gitroll attach` (and `gitroll_attach` over MCP) reads exactly the one file on this computer that it is given — no folders, no wildcards — and writes only under `.gitroll/files/`. `gitroll reassemble --out` writes only the new path it is given and never overwrites.
- A file kept in parts is read part by part through the same checks, only under `.gitroll/files/`; a part behind a symbolic link, a gap in the numbering, or fewer parts than the sidecar lists is refused rather than served short, and joined files are checked against the sidecar's sha256.
- A repository whose `template_version` is newer than the app blocks every write, so an older GitRoll can't half-rewrite a newer format.
- Templates can only add a config marker, a README and a theme stylesheet. Code, scripts and workflows are never copied into a Roll.

**Privacy**
- Location (GPS) data is removed from JPEG photos before they're saved. Turn this off per Roll with `attachments: { remove_location: false }`.
- Saving an event warns if the text looks like a password, API key, private key, card number or Social Security number, and `gitroll check` lists such events.
- Before every upload, sync checks each address `git push` would actually send to (including `pushurl` and `insteadOf` rewrites). It refuses if a GitHub repository is public, or if its privacy can't be confirmed (offline, rate limited). It also refuses non-GitHub hosts unless you explicitly run `gitroll trust <address>`. Nothing is cached, so every sync is checked.
- Events carry no author field. Who wrote and changed each one comes from Git history, so collaborators can't sign events as each other by editing a file.
- `gitroll doctor` reviews your setup: repository visibility, credentials embedded in the backup address, your email appearing in history, commit signing and settings file permissions.

**Signed commits**
- GitRoll uses Git's own SSH commit signing and adds no hashes or signatures of its own. A Roll can list who may sign in `.gitroll/allowed_signers` (ssh-keygen's format), committed with the Roll.
- `gitroll agent-key <name>` gives an AI agent its own Ed25519 key. The private key is written to GitRoll's settings folder with permissions 0600, never inside a repository (GitRoll refuses if the settings folder is inside the Roll), and only its public key is committed. It isn't offered as an MCP tool: an agent shouldn't mint its own identity.
- `gitroll verify` has Git check every change's signature against the Roll's allowed signers, and fails on a `Gitroll-Agent:` trailer signed by a different agent's key, or on a key the allowed signers don't list. A listed person's signature on an agent's change vouches for it and passes. A trailer by itself is only a claim.

**Sealed content**
- Lines of a note or event, a front matter field, or a whole file can be sealed: encrypted with [age v1](https://age-encryption.org/v1) (X25519, HKDF-SHA-256, ChaCha20-Poly1305, HMAC-SHA-256 header MAC) to the recipients listed in `.gitroll/config.yaml`. GitRoll implements the format with Node's built-in crypto only, and the reference `age` CLI reads and writes the same files, so sealed content stays readable without GitRoll.
- Secret keys live in `keys.txt` in your GitRoll settings folder (or wherever `GITROLL_IDENTITY` points), with 0600 permissions. `gitroll key new` refuses to write one inside a Git repository. A Roll holds only public recipients.
- Without a key, sealed parts are shown as `[sealed]` (or `{"sealed": true}` in JSON and over MCP), never as an error, and search never indexes them. `show --unsealed` decrypts for display only; plaintext reaches the disk again only through an explicit, confirmed `gitroll unseal`.
- `gitroll reseal` opens sealed content with your key and seals it again to the Roll's current recipients, in one commit, after a recipient is added or removed. It never writes plaintext to disk, leaves anything your key can't open exactly as it was (and says which), and refuses to seal to a list that leaves out every key on your computer.
- `gitroll mcp` never offers `key`, and returns sealed content opened only when the server process itself has a key and the call asks for it. `gitroll_unseal` and `gitroll_reseal` (which can widen who reads sealed content to a newly added recipient) both need `yes: true`. Giving an agent a Roll without a key is how to share it safely.
- The secret scanner offers `gitroll seal` (with the exact lines) when it spots a password or key.
- The browser interface opens sealed content only when the page it runs in provides a way to (an `Unsealer`, `src/web/unseal.tsx`): a host that holds an age key in the browser, as GitRoll.com does. The local app provides none, so it shows `[sealed]` and opens a sealed file only through its own server, with a key on this computer. With an unsealer, opened blocks, fields and files are shown on screen only, marked as sealed, and never handed back to the store, so editing an event keeps its sealed parts sealed. A decrypted file is opened from a `blob:` URL; a type that can run script (HTML, SVG) is only ever downloaded. In a browser, `src/web/age-crypto.ts` implements the same primitives with WebCrypto and the audited `@noble/ciphers`, `@noble/curves` and `@noble/hashes` for what WebCrypto lacks; those are bundled only by a host that uses it, never into the command line.

**What sealing protects against, and what it doesn't**

| Threat | Sealed content |
| --- | --- |
| The hosting account or a token is compromised; the repository is made public by mistake | Protected: the host only ever has ciphertext |
| A clone ends up where it shouldn't: a backup, a shared machine, an agent's sandbox | Protected, as long as no key went with it |
| Someone you share the Roll with, who isn't a recipient | Protected |
| A recipient you later remove | Not protected for what was sealed while they were listed. `gitroll reseal` shuts them out of the current version and what comes after, but every earlier commit still holds the old ciphertext, on every clone and backup, and their key still opens it there. Treat what it protected as seen by them; to remove those versions, see below |
| Text committed in plain before it was sealed | **Not protected.** It is still in Git history. GitRoll names the commits when you seal it; see below |
| Your own computer is compromised (malware, someone at your unlocked desk) | **Not protected.** The key is on that computer, and opened content is shown there. Use full-disk encryption and a locked screen |
| Losing your key | Sealed content can't be opened by anyone, including you. Back up `keys.txt`, or list a second key (another device, or one kept offline) as a recipient |

What is not sealed is not hidden: file names, the title and the rest of a note, which front matter keys exist, when things were committed and by whom, and roughly how long a sealed part is.

### Removing something from Git history

Sealing changes the current version only. If text or a file was committed in plain before it was sealed, every earlier commit still has it, on every clone and every backup. The same goes for re-sealing after removing a recipient: the earlier commits still hold ciphertext that recipient's key opens. GitRoll never rewrites history, so removing it is a deliberate step you take with Git itself:

1. Treat the secret as exposed. Change the password, revoke the token, cancel the card: rewriting history doesn't reach copies that were already made.
2. With every collaborator's work pushed, rewrite the repository with [`git filter-repo`](https://github.com/newren/git-filter-repo), for example `git filter-repo --replace-text expressions.txt` for text, or `git filter-repo --invert-paths --path .gitroll/files/x.pdf` for a file. Read its documentation first: it rewrites every commit after the first that contained it.
3. Force-push the rewritten branch to every remote, and ask everyone who cloned the Roll to clone it again. Their old copies still contain it.
4. On GitHub, cached views and pull requests can keep old commits reachable; GitHub's documentation on removing sensitive data explains how to ask for those to be purged.

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
- **Only what you seal is encrypted.** Everything else is plain text, readable by anyone with access to your computer, your backups or the GitHub repository. Sealed content is protected from the host, clones and backups, not from a compromised computer that holds the key (see the table above). Use full-disk encryption on your devices.
- **A signature proves which key signed, not who controls the Roll.** Anyone who can push can change `.gitroll/allowed_signers`; review changes to it. An agent's key is unencrypted on disk, protected by file permissions, so anyone who can read your settings folder can sign as that agent. Syncing may rebase unsynced commits onto newer ones, which re-signs them with your own Git signing settings (or leaves them unsigned) rather than the agent's key.
- **Your email may be in history.** Git records the name and email you commit with. Use GitHub's noreply address if that matters to you.
- **No compliance certification.** GitRoll doesn't make you compliant with GDPR, HIPAA or similar rules. You (and GitHub, as your host) remain responsible for how the data is stored and shared.

## Reporting a vulnerability

Please report security issues privately with GitHub's "Report a vulnerability" button on the GitRoll repository, not in a public issue.
