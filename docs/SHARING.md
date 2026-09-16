# Sharing a Roll

A shared Roll is one private GitHub repository that several people sync with. The repository is the source of truth. There's no GitRoll server in between.

## Share

The Roll must be backed up to GitHub first (`gitroll backup`). Then:

```bash
gitroll share their-github-name
```

This sends a GitHub invitation. Add `--read-only` for someone who should see but not log. `gitroll share` with no name lists who has access. Sharing uses the GitHub CLI; without it, manage access at `https://github.com/<you>/<roll>/settings/access`.

## Join

After accepting the invitation on GitHub, the other person runs:

```bash
gitroll join you/home
```

The Roll appears in `gitroll rolls`, and `gitroll` opens it.

## Syncing together

Everyone logs on their own computer and clicks **Sync** (or runs `gitroll sync`). Syncing downloads others' changes, combines them with yours, and uploads the result.

Because every event is its own file, most changes never collide. When they do:

| What happened | Result |
| --- | --- |
| Two people logged different events | Both are kept |
| Two people edited different parts of the same event (different lines, or text vs. front matter) | Combined automatically |
| Two people changed the same lines differently | Your version is kept as it is, the other version is quoted in a note at the bottom, and the event is tagged `#conflict`. Search `#conflict` to review. |
| Someone deleted an event you edited | Your edit is kept |
| Two people synced at the same moment | GitRoll retries |

GitRoll never force-pushes, so nobody's work can be overwritten.

## Removing someone

```bash
gitroll unshare their-github-name
```

They can no longer sync. Anything they already downloaded stays on their computer. That's how Git works, and it's worth remembering before sharing sensitive records.

## Good practice

- Keep the repository private. GitRoll refuses to sync to a public GitHub repository.
- Events carry no author field: Git history records who wrote and changed every event, so nobody can sign as someone else by editing a file.
- Turn on commit signing if you need proof of who changed what.
