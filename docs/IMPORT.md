# Importing from GitHub and CI

A log is worth keeping because it says what happened. Quite a lot of what happened is already written down somewhere else — in merged pull requests, in releases, in the build that failed at 3am — and retyping it is how a log stops being kept.

```bash
gitroll import github            # merged pull requests and releases
gitroll import ci                # builds that failed
```

Both work on the repository your Roll is in, or one you name: `gitroll import github acme/app`.

## What comes in, and what doesn't

The defaults are the narrow, useful answer. Everything else is asked for.

| Command | Brings in | Ask for more with |
| --- | --- | --- |
| `import github` | Merged pull requests, published releases | `--include pr,issue,release`, `--only closed\|merged\|all` |
| `import ci` | Builds that **failed** | `--status all\|success\|failure`, `--include deployment` |

A log of every green build is noise, and noise is what makes people stop reading a log. That is why `import ci` keeps to failures until you say otherwise.

## Filters

| Filter | Means |
| --- | --- |
| `--since 2026-09-01` / `--until 2026-09-30` | Calendar days, compared to the event's own date |
| `--branch main` | The branch a pull request went **into**, or a run happened **on** |
| `--author sam` | Who opened it |
| `--label performance` | Any of these labels (repeat the flag for more) |
| `--status failure` | For CI: `success`, `failure`, `cancelled`, `running`, or `all` |
| `--limit 20` | At most this many, newest first |
| `--dry-run` | Print what would be logged. Nothing is written. |

Always safe to start with:

```bash
gitroll import github acme/app --since 2026-09-01 --dry-run
```

## Nothing is ever logged twice

Every imported event records where it came from:

```yaml
source:
  adapter: github
  id: pr:acme/app#412
  url: https://github.com/acme/app/pull/412
  repo: acme/app
  branch: main
  commit: aa11bb22cc33dd44ee55ff6600112233445566aa
```

`adapter` + `id` is that thing's own identity on GitHub, so:

- Importing the same range twice logs nothing the second time.
- A payload from a webhook and one from the API are the same event.
- **An event you edited after importing it stays edited.** An import skips what is already there; it never rewrites an event, so the sentence you added about what really broke is safe.

A repeated import also starts where the last one finished: GitRoll looks at the newest event that import already logged and asks GitHub for that day onwards. It says so when it does, and `--since` overrides it:

```
Looking at 2026-09-15 and later, where the last github import left off. Use --since to go further back.
```

The `repo`, `branch` and `commit` in `source` are the same ones `gitroll log --code` writes, so an imported event links to its commit and its `#412` references resolve to the right repository. See [SPEC.md](../SPEC.md#code-references).

## Credentials

GitRoll asks GitHub in the first way that works:

1. **The GitHub CLI**, if it is installed and signed in (`gh auth login`). It already holds the credentials, including for SSO and GitHub Enterprise, and nothing new is stored.
2. **`GITHUB_TOKEN` or `GH_TOKEN`** from your environment, over HTTPS.
3. **Nothing**, which works for public repositories and is rate limited.

No token is written to a Roll or to GitRoll's settings, and the import says which it used before it starts. A private repository with no credentials says so rather than appearing to be empty.

## Piping JSON in

The adapters read GitHub's own JSON, so anything that can produce it works — useful in a GitHub Action, a webhook receiver, or when you want a query GitRoll doesn't offer:

```bash
gh api 'repos/acme/app/pulls?state=closed&per_page=100' | gitroll import github -
gh api 'repos/acme/app/actions/runs?status=completed' | gitroll import ci -
```

Both accept a single object, an array, GitHub's `{ workflow_runs: [...] }`, and webhook envelopes like `{ action, pull_request: {...} }`.

## Another CI system

`import ci` also reads a plain shape you can map anything onto with a few lines of `jq`:

```json
{
  "id": "4711",
  "name": "nightly",
  "status": "failed",
  "branch": "main",
  "commit": "9f1c2d3",
  "url": "https://ci.example.com/4711",
  "started_at": "2026-09-16T02:00:00Z",
  "finished_at": "2026-09-16T02:12:00Z"
}
```

`status` can be whatever your system calls it — `failed`, `error`, `red`, `timed_out` all mean the same thing here — and `id` is what stops the same build being logged twice.

## What an imported event looks like

An ordinary Markdown file, like every other event:

```markdown
---
tags: [pull-request, merged, performance]
source:
  adapter: github
  id: pr:acme/app#412
  url: https://github.com/acme/app/pull/412
  repo: acme/app
  branch: main
  commit: aa11bb22cc33dd44ee55ff6600112233445566aa
---

# Merged acme/app#412: Add a partial index on orders

Opened by @sam, merged by @jo, into `main`, from `fix/checkout`.

> Checkout was timing out on large carts.

[Pull request](https://github.com/acme/app/pull/412) · 7 commits · +212 −40 · 9 files
```

What GitHub wrote is **quoted**, not adopted: a pull request description with its own `# heading` can't outrank the event's, and a long one is shortened with a link to the rest. Labels become tags, so `gitroll find tag:performance` finds it later.
