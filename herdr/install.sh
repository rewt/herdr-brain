#!/usr/bin/env bash
# The plugin's build step: console/MCP dependencies and reversible machine entry.
# Runs from `herdr plugin install`, and from herdr/release.sh for a local release.
# RELEASE_NO_NPM=1 skips dependency installation (tests).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$PATH:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin"
command -v node >/dev/null || { echo "install: install Node.js 20+ (including npm) and put node on PATH" >&2; exit 1; }
node "$ROOT/herdr/prerequisites.mjs"
# Discover harnesses and preflight every machine destination before npm writes.
if [ "${MONITOR_INSTALL_BUILD_ONLY:-}" != 1 ]; then
  node "$ROOT/herdr/entry-install.mjs" --snapshot --check
fi
if [ "${RELEASE_NO_NPM:-}" != 1 ]; then
  node "$ROOT/herdr/dependencies.mjs"
fi
# Herdr moves its temporary checkout after this build. Snapshot entry code into
# a stable machine directory; archive builds defer entry until activation.
if [ "${MONITOR_INSTALL_BUILD_ONLY:-}" != 1 ]; then
  node "$ROOT/herdr/entry-install.mjs" --snapshot
fi
