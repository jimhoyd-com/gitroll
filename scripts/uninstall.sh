#!/bin/sh
# Removes the GitRoll app on macOS or Linux. Your Rolls (logbooks) are never deleted.
# Use this if the gitroll command itself is broken; otherwise `gitroll uninstall` does the same.
#   curl -fsSL https://raw.githubusercontent.com/jimhoyd-com/gitroll/main/scripts/uninstall.sh -o uninstall.sh
#   sh uninstall.sh                     remove the app, keep settings
#   sh uninstall.sh --remove-settings   also remove GitRoll's settings (the list of Rolls, trusted backups)
set -eu

has() { command -v "$1" >/dev/null 2>&1; }
REMOVE_SETTINGS=0
for arg in "$@"; do
  case "$arg" in
    --remove-settings) REMOVE_SETTINGS=1 ;;
    -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

SETTINGS="${GITROLL_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/gitroll}"
removed=0

if has brew && brew list --formula gitroll >/dev/null 2>&1; then
  echo "Removing GitRoll installed with Homebrew…"
  brew uninstall gitroll
  removed=1
fi
if has npm && npm ls --global --depth=0 gitroll >/dev/null 2>&1; then
  echo "Removing GitRoll installed with npm or the installer…"
  npm uninstall --global gitroll
  removed=1
fi
[ "$removed" = 1 ] || echo "GitRoll isn't installed with Homebrew or npm, so there was no app to remove."

if [ "$REMOVE_SETTINGS" = 1 ] && [ -d "$SETTINGS" ]; then
  [ -f "$SETTINGS/config.json" ] || [ -z "$(ls -A "$SETTINGS")" ] || { echo "$SETTINGS doesn't look like GitRoll's settings; leaving it alone." >&2; exit 1; }
  rm -rf "$SETTINGS"
  echo "Removed GitRoll's settings ($SETTINGS)."
elif [ -d "$SETTINGS" ]; then
  echo "Kept GitRoll's settings in $SETTINGS (remove them with --remove-settings)."
fi

echo
echo "Your Rolls were not touched. They're ordinary folders (by default in ${GITROLL_ROLLS:-$HOME/GitRoll}) and private GitHub repositories."
echo "Delete them yourself only if you no longer want your logbooks."
