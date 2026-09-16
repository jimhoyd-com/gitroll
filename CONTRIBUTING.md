# Contributing to GitRoll

Thanks for helping. GitRoll is free and **source available** under the [PolyForm Shield License 1.0.0](LICENSE) — free for personal and internal business use, including paid client work, but not for building a competing product. Please read [Contribution terms](#contribution-terms) before you open a pull request: they are not the usual "inbound = outbound".

## What GitRoll is (and isn't)

GitRoll answers four questions: what happened, when did it happen, what evidence do I have, and can I find it again. Please read [docs/ROADMAP.md](docs/ROADMAP.md) before proposing features. Task management, Kanban boards, accounting and hosted services are out of scope for this repository.

## Getting started

You need Node.js 24 and Git.

```bash
make setup
```

```bash
make check
```

Every `make` target is a thin wrapper over an `npm run` script, so use whichever
you prefer:

| make | npm | What it does |
| --- | --- | --- |
| `make dev ARGS="…"` | `npm run dev -- …` | The CLI from `src/`, against the sandbox Roll |
| `make dev-reset` | `npm run dev:reset` | Start the sandbox over |
| `make watch` | `npm run watch` | Rebuild `dist/` on save |
| `make build` | `npm run build` | Build the installable app |
| `make test` | `npm test` | The tests |
| `make e2e` | `npm run e2e` | Only the end-to-end tests |
| `make typecheck` | `npm run typecheck` | Types |
| `make check` | `npm run check` | Everything that must pass before a release |
| `make demo` | `npm run demo` | Build, then open the sandbox in the browser |
| `make clean` | `npm run clean` | Remove build output |

`make link` / `make unlink` (`npm link`, `npm unlink -g gitroll`) put a `gitroll`
command from this checkout on your PATH.

### Working on it

```bash
make dev                      # a throwaway Roll in .dev/, opened in the terminal app
make dev ARGS="log 'hello'"   # any command, straight from src/ — no build step
make dev ARGS="storage"
make dev-reset                # start the sandbox over
```

`make dev` runs `src/node/cli.ts` directly, so an edit is live on the next
command. The sandbox has its own settings and Rolls folder (`GITROLL_HOME`,
`GITROLL_ROLLS` are set for it), so it cannot reach the Rolls you actually keep,
and it is seeded with the cases that are tedious to make by hand: entries logged
through GitRoll, one backdated with a time, one date-only, an entry written by
hand with no marker, and an archived, gzipped month.

For the browser app:

```bash
make watch                    # rebuilds dist/ as you save
make dev ARGS="open"          # serves it; refresh the browser after a save
```

This repository ignores a Roll made inside it (`/.gitroll/`, anchored to the
root so `template/.gitroll/` stays tracked), because a log is somebody's notes
and receipts and this is the app's source code. If you do make one here, GitRoll
says why it can't commit it rather than failing a git command.

`make dev ARGS="--real status"` uses your own Rolls instead of the sandbox, and
`make link` puts a `gitroll` command from this checkout on your PATH
(`make unlink` removes it). `gitroll version` always says which one you are
talking to.

`make check` runs the typecheck, tests, build, the `@gitroll/core` build and a dependency audit. Pull requests must pass it.

`make test` includes the end-to-end tests in `test/e2e.test.ts`, which build the app and use `dist/gitroll.mjs` the way people do: two people sharing a Roll through a Git remote, the browser app over HTTP, and the terminal app through a real pseudo-terminal. Run only those with `make e2e`. `make release && make verify-release` also installs the release package into a clean location, uses it, and uninstalls it.

## Repositories

| Repository | What it is | Edit it? |
| --- | --- | --- |
| [jimhoyd-com/gitroll](https://github.com/jimhoyd-com/gitroll) | The app, and the source of truth for everything below | Yes, with pull requests here |
| [jimhoyd-com/gitroll-template](https://github.com/jimhoyd-com/gitroll-template) | Starter files for a Roll, generated from `template/` and `scripts/publish-template.mjs` on each release | No: change `template/` here |
| [jimhoyd-com/homebrew-tap](https://github.com/jimhoyd-com/homebrew-tap) | The Homebrew formula, generated from `packaging/homebrew/` on each release | No: change `packaging/homebrew/` here |
| [jimhoyd-com/scoop-bucket](https://github.com/jimhoyd-com/scoop-bucket) | The Scoop manifest, generated from `packaging/scoop/` on each release | No: change `packaging/scoop/` here |

`main` is protected: changes go through pull requests that pass CI and CodeQL and are approved by the code owner (see `.github/CODEOWNERS`). Release tags (`v*`) can only be created by maintainers.

```bash
make demo
```

This opens a throwaway Roll with sample events.

## Guidelines

- **Keep the format stable.** Changes to files in a Roll must be reflected in [SPEC.md](SPEC.md) and stay readable by older versions where possible. Unknown fields must always be preserved.
- **Keep `src/core` platform-free.** It's shared with other runtimes; `test/core-boundary.test.ts` enforces it.
- **Security first.** Never follow symbolic links, never execute anything from a Roll, keep the local server on loopback, and escape all user text.
- **Plain language.** The app and CLI should be understandable by someone who has never heard of Git. Keep messages short and consistent.
- **Tests.** Add or update tests for every behavior change.
- **No new runtime dependencies** without discussion. Dependencies are bundled into the release, so each one must be under a permissive license (MIT, ISC, BSD, Apache-2.0, 0BSD) whose notice requirements we can satisfy in `THIRD_PARTY_NOTICES.txt`. Copyleft licenses (GPL, AGPL, LGPL) and source-available licenses are not acceptable for bundled code. A dual-licensed package is fine if one option is permissive — `dompurify` is taken under Apache-2.0, not MPL-2.0. Never remove or edit a third-party notice.

## Contribution terms

GitRoll is maintained by one person, Jimmy Ho, who also runs GitRoll.com, a paid
hosted service built on this code. For that to work, the project needs to hold
clear rights in every line it ships. So the contribution terms here are
deliberately explicit, and they are **not** simply "your contribution is under
the project's license."

**By opening a pull request against this repository, you confirm all of the
following.**

1. **It's yours to give.** You wrote the contribution, or you otherwise have the
   right to submit it. It is not copied from code under another license, it is
   not owned by your employer in a way that stops you giving it, and it is not
   subject to anyone else's patent or confidentiality claim that you know of. If
   your employer owns your work, you have their permission.

2. **You grant a broad license.** You grant Jimmy Ho a perpetual, worldwide,
   non-exclusive, irrevocable, royalty-free, transferable, sublicensable license
   to use, copy, modify, make derivative works of, publicly display, distribute
   and otherwise exploit your contribution, for any purpose and in any medium,
   **with the right to license and relicense it under any terms, including
   proprietary and commercial terms**. This is what allows the contribution to
   ship both in GitRoll and in GitRoll.com, and to be offered under a paid
   commercial license to a customer who needs one.

3. **A patent grant comes with it.** You grant Jimmy Ho and every recipient of
   the software a perpetual, worldwide, non-exclusive, irrevocable, royalty-free
   patent license for any patent claims you own or control that your
   contribution would otherwise infringe.

4. **You keep your copyright.** This is a license, not an assignment. You still
   own your contribution and may use it however you like elsewhere. You are also
   licensed to use the result under the project's LICENSE like anyone else.

5. **No warranty.** You provide the contribution as is, with no warranty of any
   kind.

**Why it is written this way.** Under a plain "inbound = outbound" rule, a
contribution would come in under PolyForm Shield, which forbids competing uses —
including some of what GitRoll.com itself does. The project could then not
lawfully ship its own contributors' code in its own hosted product, and could not
sell a commercial license covering it. Clause 2 is what prevents that deadlock.

Plain-language answers to the questions this raises are in
[docs/LICENSE-FAQ.md](docs/LICENSE-FAQ.md).

**If you are not comfortable with these terms, please don't send code** — open an
issue instead and describe the change. Bug reports, design discussion,
documentation suggestions and test cases in issues are just as welcome, and this
section does not apply to them.

Contributions made before version 0.4.0 were submitted under the MIT License and
are unaffected; see [LICENSE-MIT-HISTORICAL](LICENSE-MIT-HISTORICAL).

## Reporting bugs and security issues

Open an issue for bugs. Report security vulnerabilities privately using GitHub's "Report a vulnerability" button, as described in [SECURITY.md](SECURITY.md), not in a public issue.
