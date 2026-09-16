<!--
Thanks for contributing. Keep this short: a reviewer should understand the
change from this description without opening the diff. Delete anything that
doesn't apply.
-->

## What this changes

<!-- One or two sentences. What is different after this is merged? -->

## Why

<!-- The problem, bug or request behind it. Link an issue if there is one. -->

## How it was tested

<!-- `make check` passes is the baseline. Say what else you did: new tests,
     steps you walked through by hand, a terminal or browser session. -->

- [ ] `make check` passes (typecheck, tests, build, audit)
- [ ] Tests added or updated for every behavior change

## Anything a reviewer should look at closely

<!-- Trade-offs you weren't sure about, a decision you'd like challenged, or
     anything you left out and why. Say "nothing" if there is nothing. -->

---

If your change touches any of these, please say so here:

- **The format of files in a Roll** — update [SPEC.md](../SPEC.md) in the same pull request, keep unknown fields preserved, and say whether `template_version` needs to change (see SPEC.md, "Template versions"). A Roll written by an older GitRoll must still open.
- **`src/core`** — it's shared with other runtimes and must stay platform-free (`test/core-boundary.test.ts` enforces it).
- **`template/`** — it is published to [gitroll-template](https://github.com/jimhoyd-com/gitroll-template) on each release, so it may contain Roll data only: no code, scripts or workflows.
- **Security** (paths, symbolic links, the local server, rendering text from a Roll, sync) — see [SECURITY.md](../SECURITY.md).
- **Dependencies** — new runtime dependencies need discussion first.
- **What people see** — keep messages short, plain, and understandable by someone who has never heard of Git.
