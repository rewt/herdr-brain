#!/usr/bin/env bash
# The release build step: reversible machine entry. The product has no npm
# dependencies. Runs from herdr/release.sh (build-only) and for a direct install.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$PATH:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin"
command -v node >/dev/null || { echo "install: install Node.js 20+ (including npm) and put node on PATH" >&2; exit 1; }
# Discover harnesses and preflight every machine destination before any write.
if [ "${MONITOR_INSTALL_BUILD_ONLY:-}" != 1 ]; then
  node "$ROOT/herdr/prerequisites.mjs"
  node "$ROOT/herdr/entry-install.mjs" --snapshot --check
fi
# The build checkout may move after this step. Snapshot entry code into a
# stable machine directory; archive builds defer entry until activation.
if [ "${MONITOR_INSTALL_BUILD_ONLY:-}" != 1 ]; then
  node "$ROOT/herdr/entry-install.mjs" --snapshot
fi
