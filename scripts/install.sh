#!/bin/sh
# Installs the latest GitRoll release on macOS or Linux.
# Downloads the release package from GitHub, verifies its SHA-256 checksum, and installs it with npm.
# Read before running:
#   curl -fsSL https://raw.githubusercontent.com/gitroll/gitroll/main/scripts/install.sh -o install.sh
#   sh install.sh
set -eu

REPO="${GITROLL_REPOSITORY:-gitroll/gitroll}"
has() { command -v "$1" >/dev/null 2>&1; }
fail() { echo "$1" >&2; exit 1; }

has git || fail "GitRoll needs Git. Install it from https://git-scm.com/downloads and run this again."
has node || fail "GitRoll needs Node.js 20 or newer. Install it from https://nodejs.org and run this again."
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || fail "GitRoll needs Node.js 20 or newer (you have $(node -v))."
has npm || fail "npm wasn't found. It's included with Node.js."
has curl || fail "curl is needed to download GitRoll."

if has sha256sum; then sha() { sha256sum "$1" | cut -d' ' -f1; }
elif has shasum; then sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
else fail "sha256sum or shasum is needed to verify the download."; fi

TAG="${GITROLL_VERSION:-$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)}"
[ -n "$TAG" ] || fail "Couldn't find the latest GitRoll release."
VERSION="${TAG#v}"
BASE="https://github.com/$REPO/releases/download/$TAG"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "Downloading GitRoll $VERSION…"
curl -fsSL "$BASE/gitroll-$VERSION.tgz" -o "$TMP/gitroll-$VERSION.tgz"
curl -fsSL "$BASE/SHA256SUMS" -o "$TMP/SHA256SUMS"

EXPECTED="$(grep " gitroll-$VERSION.tgz\$" "$TMP/SHA256SUMS" | cut -d' ' -f1)"
ACTUAL="$(sha "$TMP/gitroll-$VERSION.tgz")"
[ -n "$EXPECTED" ] && [ "$EXPECTED" = "$ACTUAL" ] || fail "The download didn't match its checksum. Nothing was installed."
echo "Checksum verified."

npm install --global --no-audit --no-fund "$TMP/gitroll-$VERSION.tgz"
echo
echo "GitRoll $VERSION is installed. Start with: gitroll setup"
