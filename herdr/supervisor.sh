#!/usr/bin/env bash
# Opened only by the explicit supervisor pane. The adapter verifies canonical
# checkout identity and delivers housekeeping startup through supervisor policy.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$PATH:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin"
exec node "$ROOT/herdr/supervisor.mjs" "$@"
