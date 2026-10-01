#!/usr/bin/env bash
# The plugin's build step: install the console's dependencies into this copy.
# Runs from `herdr plugin install`, and from herdr/release.sh for a local release.
# RELEASE_NO_NPM=1 skips it (tests).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ "${RELEASE_NO_NPM:-}" = 1 ] && exit 0
export PATH="$PATH:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin"
command -v npm >/dev/null || { echo "install: npm not found; the console needs it (npm --prefix $ROOT/console ci)" >&2; exit 1; }
npm --prefix "$ROOT/console" ci --no-audit --no-fund --prefer-offline >/dev/null
echo "install: console dependencies installed in $ROOT/console"
