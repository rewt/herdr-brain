#!/usr/bin/env bash
# The plugin's build step: console/MCP dependencies and reversible machine entry.
# Runs from `herdr plugin install`, and from herdr/release.sh for a local release.
# RELEASE_NO_NPM=1 skips dependency installation (tests).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$PATH:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin"
if [ "${RELEASE_NO_NPM:-}" != 1 ]; then
  command -v npm >/dev/null || { echo "install: npm not found; console and MCP dependencies need it" >&2; exit 1; }
  for module in console mcp; do
    # Older archives predate MCP; new distributions carry its pinned lockfile.
    if [ -f "$ROOT/$module/package.json" ]; then
      npm --prefix "$ROOT/$module" ci --no-audit --no-fund --prefer-offline >/dev/null
      echo "install: $module dependencies installed in $ROOT/$module"
    fi
  done
fi
# Herdr moves its temporary checkout after this build. Snapshot entry code into
# a stable machine directory; archive builds defer entry until activation.
if [ "${MONITOR_INSTALL_BUILD_ONLY:-}" != 1 ]; then
  node "$ROOT/herdr/entry-install.mjs" --snapshot
fi
