# Changelog

All notable changes to GitRoll are documented here. GitRoll follows [semantic versioning](https://semver.org). The Roll file format has its own version, documented in [SPEC.md](SPEC.md).

## 0.1.0 (unreleased)

First public release.

### Added
- **Rolls:** plain Markdown-and-YAML records with attachments named by their SHA-256 hash, specified in SPEC.md.
- **Local web app:** timeline, search with quick filters, projects, logging with photos and files, editing with history, and a sync button.
- **CLI:** `setup`, `log`, `find`, `sync`, `rolls`, `switch`, `new`, `join`, `share`, `backup`, `rename`, `remove`, `projects`, `types`, `template`, `export`, `import`, `check`, `doctor`, `ask`, `ai`.
- **Event types:** Log, Expense, Maintenance, Decision, Issue and Milestone, plus custom types with fields and defaults.
- **Syncing:** with a private GitHub repository using your own Git credentials, with automatic merging when the same entry was edited in two places.
- **Templates and themes:** reusable Roll templates and per-Roll themes.
- **`@gitroll/core`:** the format as a platform-free library.
- **Release artifacts:** a versioned package tarball with `SHA256SUMS`, build provenance, and generated Homebrew and Scoop definitions, each verified by installing on clean Linux, macOS and Windows machines.

### Experimental (hidden)
- **"Ask your Roll":** local AI answers with citations. Off unless `GITROLL_EXPERIMENTAL=ai` is set.

### Security
- Every read and write stays inside the Roll folder, and symbolic links are refused and reported.
- The local app binds to loopback only, with a per-session access key, CSP, CSRF and DNS-rebinding protection.
- Attachments are never cached by the browser, and active content is always downloaded rather than rendered.
- GPS location is removed from photos, and text that looks like a password, key or card number triggers a warning.
- Sync checks the real push destinations before every upload, and refuses public, unconfirmable, or untrusted non-GitHub destinations.
- Distributed builds include third-party license notices.
