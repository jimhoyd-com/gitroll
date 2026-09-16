# Releasing GitRoll

A release is a Git tag, `vX.Y.Z`, matching `version` in `package.json`. The release workflow (`.github/workflows/release.yml`) does everything else:

1. **Build.** It runs `make check`, then `scripts/release.mjs`, which produces:
   - `gitroll-X.Y.Z.tgz`: the installable package (built app, starter files, docs, license notices; no source, tests or runtime dependencies)
   - `SHA256SUMS`
   - `gitroll.rb`: the Homebrew formula, generated from `homebrew/gitroll.rb.template` with the real URL and checksum
   - `gitroll.json`: the Scoop manifest, generated from `scoop/gitroll.json.template`
2. **Verify on clean machines.**
   - `scripts/verify-install.mjs` checks the checksum, installs the package into an empty location on fresh Ubuntu, macOS and Windows runners using Node.js 20 (the oldest supported) and 24, then creates a Roll, logs with an attachment, searches, validates, and confirms AI is hidden.
   - On macOS, the generated formula is also installed with Homebrew and its `brew test` block is run.
   - On Windows, Scoop is installed and the generated manifest is installed with it; `gitroll help` and `gitroll version` must work.
3. **Publish.** The workflow creates build provenance for the package and publishes a GitHub Release with all four files. It only runs if every verification passed.

Placeholders are never committed as if they were real: the formula and manifest exist only as templates here and as generated files in each release.

4. **Template repository.** `scripts/publish-template.mjs` copies `template/` to `jimhoyd-com/gitroll-template` as a new commit. It only allows Roll data files and validates the result with `gitroll check`. This needs a `TEMPLATE_REPO_TOKEN` secret: a fine-grained token with Contents read and write on that one repository. Without it the step is skipped with a warning.

## After the workflow publishes

- **Homebrew:** automatic. The `publish-homebrew` job commits the verified `gitroll.rb` to `jimhoyd-com/homebrew-tap` (`Formula/gitroll.rb`) using the `TAP_REPO_TOKEN` secret, a fine-grained token with Contents read and write on that one repository. Without it the step is skipped with a warning, and you copy the file by hand. Users run `brew install jimhoyd-com/tap/gitroll`.
- **Scoop:** automatic. The `publish-scoop` job commits the verified `gitroll.json` to `jimhoyd-com/scoop-bucket` (`bucket/gitroll.json`) using the `SCOOP_REPO_TOKEN` secret, a fine-grained token with Contents read and write on that one repository. Without it the step is skipped with a warning. Users run `scoop bucket add gitroll https://github.com/jimhoyd-com/scoop-bucket` then `scoop install gitroll/gitroll`.
- **npm:** automatic after a one-time setup. The `publish-npm` job publishes the verified package with provenance using npm trusted publishing: GitHub's short-lived OIDC identity, so there's no npm token stored anywhere. It runs in the `npm` environment, which only release tags (`v*`) can use. If the package doesn't exist on npm yet, the job skips with a warning, and if a version is already published it does nothing.

### One-time npm setup

npm only lets you configure trusted publishing on a package that already exists, so the first version is published by hand:

1. Sign in to [npmjs.com](https://www.npmjs.com) with two-factor authentication turned on.
2. Publish the verified release package (not a local build):

   ```bash
   gh release download vX.Y.Z -R jimhoyd-com/gitroll -p 'gitroll-*.tgz' -p SHA256SUMS
   shasum -a 256 -c SHA256SUMS
   npm login
   npm publish gitroll-X.Y.Z.tgz --access public
   ```

3. On npmjs.com, open **gitroll → Settings → Trusted publishing**, choose **GitHub Actions**, and enter organization `jimhoyd-com`, repository `gitroll`, workflow `release.yml`, environment `npm`.
4. Still under **Settings**, set **Publishing access** to "Require two-factor authentication and disallow tokens". Trusted publishing keeps working, and no token can publish.

From then on every release publishes to npm automatically.

Users without Homebrew, Scoop or npm install from the release with `scripts/install.sh` (macOS/Linux, verifies the checksum) or `npm install -g <release tarball URL>`.

## Local dry run

```bash
make release
```

```bash
make verify-release
```

## Licensing in a release

From 0.4.0 onward GitRoll ships under the [PolyForm Shield License 1.0.0](../LICENSE).
It is **source available**, not open source — never describe a release as open
source in release notes, the GitHub description, a formula, a manifest or an
announcement.

Every release package must contain both license files, and `scripts/release.mjs`
fails the build if either is missing:

- `LICENSE` — the current terms, including the `Required Notice:` and
  `Licensor Line of Business:` lines that PolyForm Shield requires be passed on
  to anyone who receives a copy. Do not remove or reword those two lines.
- `LICENSE-MIT-HISTORICAL` — the record that 0.3.0 and earlier were MIT. Keep
  shipping it. It is what makes the boundary verifiable, and it costs nothing.

Also:

- **Never delete or re-tag the v0.1.0–v0.3.0 releases.** Those versions are MIT
  forever, and removing them would look like an attempt to revoke a grant that
  cannot be revoked.
- `dist/THIRD_PARTY_NOTICES.txt` is generated by `scripts/build.mjs` from the
  bundled packages' own license files. Third-party notices are never removed or
  edited, and the license change does not touch them.
- The Homebrew formula uses `license :cannot_represent` and the Scoop manifest
  names `PolyForm-Shield-1.0.0` with its URL, because PolyForm Shield has no
  SPDX identifier. A personal tap and bucket are fine for this; **homebrew-core
  and the main Scoop buckets require an open-source license and would reject
  GitRoll**, so do not submit it there.
- npm accepts the package: `license` is `SEE LICENSE IN LICENSE`, npm's
  convention for non-SPDX terms. npm does not require an open-source license.

## Checklist

- [ ] `CHANGELOG.md` updated and `package.json` version bumped
- [ ] Tag `vX.Y.Z` pushed; the release workflow passed on all platforms
- [ ] Tap formula updated from the release; `brew install jimhoyd-com/tap/gitroll` works on a clean Mac
- [ ] (When supported) bucket manifest updated and verified on Windows
- [ ] `LICENSE` and `LICENSE-MIT-HISTORICAL` both present in the tarball, notice lines intact
