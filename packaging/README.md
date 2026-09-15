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
3. **Publish.** The workflow creates build provenance for the package and publishes a GitHub Release with all four files. It only runs if every verification passed.

Placeholders are never committed as if they were real: the formula and manifest exist only as templates here and as generated files in each release.

## After the workflow publishes

- **Homebrew:** copy the release's `gitroll.rb` into the tap repository (`gitroll/homebrew-tap`, `Formula/gitroll.rb`). Users then run `brew install gitroll/tap/gitroll`.
- **Scoop:** copy `gitroll.json` into the bucket repository. Scoop isn't installed on the CI runners yet; verify it on a Windows machine before announcing Scoop support.
- **npm (optional):** `npm publish release/gitroll-X.Y.Z.tgz --provenance`.

Until the tap, bucket and npm package exist, users install from the release with `scripts/install.sh` (macOS/Linux, verifies the checksum) or `npm install -g <release tarball URL>`.

## Local dry run

```bash
make release
```

```bash
make verify-release
```

## Checklist

- [ ] `CHANGELOG.md` updated and `package.json` version bumped
- [ ] Tag `vX.Y.Z` pushed; the release workflow passed on all platforms
- [ ] Tap formula updated from the release; `brew install gitroll/tap/gitroll` works on a clean Mac
- [ ] (When supported) bucket manifest updated and verified on Windows
