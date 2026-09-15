# Contributing to GitRoll

Thanks for helping. GitRoll is free and open source under the [MIT License](LICENSE). By contributing, you agree your contribution is licensed under it too.

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

`make check` runs the typecheck, tests, build, the `@gitroll/core` build and a dependency audit. Pull requests must pass it.

`make test` includes the end-to-end tests in `test/e2e.test.ts`, which build the app and use `dist/gitroll.mjs` the way people do: two people sharing a Roll through a Git remote, the browser app over HTTP, and the terminal app through a real pseudo-terminal. Run only those with `make e2e`. `make release && make verify-release` also installs the release package into a clean location, uses it, and uninstalls it.

## Repositories

| Repository | What it is | Edit it? |
| --- | --- | --- |
| [jimhoyd-com/gitroll](https://github.com/jimhoyd-com/gitroll) | The app, and the source of truth for everything below | Yes, with pull requests here |
| [jimhoyd-com/gitroll-template](https://github.com/jimhoyd-com/gitroll-template) | Starter files for a Roll, generated from `template/` on each release | No: change `template/` here |
| [jimhoyd-com/homebrew-tap](https://github.com/jimhoyd-com/homebrew-tap) | The Homebrew formula, generated from `packaging/homebrew/` on each release | No: change `packaging/homebrew/` here |

`main` is protected: changes go through pull requests that pass CI and CodeQL and are approved by the code owner (see `.github/CODEOWNERS`). Release tags (`v*`) can only be created by maintainers.

```bash
make demo
```

This opens a throwaway Roll with sample entries.

## Guidelines

- **Keep the format stable.** Changes to files in a Roll must be reflected in [SPEC.md](SPEC.md) and stay readable by older versions where possible. Unknown fields must always be preserved.
- **Keep `src/core` platform-free.** It's shared with other runtimes; `test/core-boundary.test.ts` enforces it.
- **Security first.** Never follow symbolic links, never execute anything from a Roll, keep the local server on loopback, and escape all user text.
- **Plain language.** The app and CLI should be understandable by someone who has never heard of Git. Keep messages short and consistent.
- **Tests.** Add or update tests for every behavior change.
- **No new runtime dependencies** without discussion. Dependencies are bundled and their licenses must be compatible with MIT.

## Reporting bugs and security issues

Open an issue for bugs. Report security vulnerabilities privately using GitHub's "Report a vulnerability" button, as described in [SECURITY.md](SECURITY.md), not in a public issue.
