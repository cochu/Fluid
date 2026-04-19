#!/usr/bin/env bash
# Stamp the current short git SHA into src/version.js.
#
# Usage:
#   tools/stamp-version.sh             # stamp current HEAD (lags 1 commit)
#   tools/stamp-version.sh --amend     # stamp HEAD then amend the commit
#                                      # so the file references its own SHA
#
# `--amend` is the recommended mode: commit your work normally, then run
# `tools/stamp-version.sh --amend` to fold the version stamp into that
# same commit. The script is idempotent — running it twice in a row
# leaves the file unchanged when the SHA hasn't moved.
set -euo pipefail
cd "$(dirname "$0")/.."

MODE="${1:-}"
SHA=$(git rev-parse --short HEAD)
DATE=$(date -u +%Y-%m-%d)
VER="${SHA}-${DATE}"

sed -i -E "s/^export const BUILD_VERSION = ['\"][^'\"]*['\"];/export const BUILD_VERSION = '${VER}';/" src/version.js

echo "Stamped version: ${VER}"

if [[ "$MODE" == "--amend" ]]; then
  if git diff --quiet -- src/version.js; then
    echo "(no change to amend)"
  else
    git add src/version.js
    git commit --amend --no-edit --no-verify
    echo "Amended HEAD with version stamp."
  fi
fi
