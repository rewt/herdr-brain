#!/usr/bin/env bash
# The plugin's build step: console dependencies and reversible machine entry.
# Runs from `herdr plugin install`, and from herdr/release.sh for a local release.
# RELEASE_NO_NPM=1 skips it (tests).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$PATH:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin"
if [ "${RELEASE_NO_NPM:-}" != 1 ]; then
  command -v npm >/dev/null || { echo "install: npm not found; the console needs it (npm --prefix $ROOT/console ci)" >&2; exit 1; }
  npm --prefix "$ROOT/console" ci --no-audit --no-fund --prefer-offline >/dev/null
  echo "install: console dependencies installed in $ROOT/console"
fi
# A .partial archive will be renamed and made immutable. Only activate from
# its final path. Herdr's own plugin install invokes the complete build step.
if [ "${MONITOR_INSTALL_BUILD_ONLY:-}" != 1 ]; then
  node "$ROOT/herdr/entry-install.mjs"
fi
