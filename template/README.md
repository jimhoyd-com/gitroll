# My Roll

A [GitRoll](https://github.com/jimhoyd-com/gitroll) Roll: a private, chronological record of what happened.

- `entries/YYYY/MM/<id>.md`: one Markdown file per event, with YAML front matter
- `projects/<slug>.yaml`: projects that events reference
- `attachments/<sha256>.<ext>`: photos, receipts and documents, named by content hash
- `.gitroll/types/<id>.yaml`: optional custom event types

Every file uses an ordinary format. Edit files directly, commit, and push; GitRoll picks up the changes.
Run `gitroll check` to validate the Roll locally. No GitHub Actions are needed.

**Keep this repository private.**
