#!/usr/bin/env bash
# The plugin's build step: console/MCP dependencies and reversible machine entry.
# Runs from `herdr plugin install`, and from herdr/release.sh for a local release.
# RELEASE_NO_NPM=1 skips dependency installation (tests).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$PATH:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin"
command -v node >/dev/null || { echo "install: install Node.js 20+ (including npm) and put node on PATH" >&2; exit 1; }
# Discover harnesses and preflight every machine destination before npm writes.
if [ "${MONITOR_INSTALL_BUILD_ONLY:-}" != 1 ]; then
  node "$ROOT/herdr/prerequisites.mjs"
  node "$ROOT/herdr/entry-install.mjs" --snapshot --check
fi
if [ "${RELEASE_NO_NPM:-}" != 1 ]; then
  if [ "${MONITOR_INSTALL_BUILD_ONLY:-}" = 1 ]; then
    # Candidate preparation is a standalone, clean build. It needs no machine
    # entry helpers or installed Herdr, and inherits the private offline cache.
    command -v npm >/dev/null || { echo "install: npm not found; console and MCP dependencies need it" >&2; exit 1; }
    for module in console mcp; do
      # Older archives predate MCP; new distributions carry its pinned lockfile.
      if [ -f "$ROOT/$module/package.json" ]; then
        npm --prefix "$ROOT/$module" ci --no-audit --no-fund --prefer-offline >/dev/null
        echo "install: $module dependencies installed in $ROOT/$module"
      fi
    done
  else
    node "$ROOT/herdr/dependencies.mjs"
  fi
fi
# Herdr moves its temporary checkout after this build. Snapshot entry code into
# a stable machine directory; archive builds defer entry until activation.
if [ "${MONITOR_INSTALL_BUILD_ONLY:-}" != 1 ]; then
  node "$ROOT/herdr/entry-install.mjs" --snapshot
fi
