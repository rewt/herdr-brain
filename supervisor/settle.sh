#!/bin/sh
# Opens a fresh settle session for a stopped run after watch/watch.mjs has
# delivered its validated report notice to the long-running supervisor.
# Usage: settle.sh R-n [--dry-run]
set -eu
RUN=${1:?usage: settle.sh R-n [--dry-run]}
shift
REWT=/Users/rewt/development/rewt
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
HERE=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
exec node "$HERE/supervisor/open-session.mjs" "$RUN" "$@" \
  --org "$REWT/.org" \
  --cwd "$HERE" \
  --lane-config "$REWT/.lane.json" \
  --checklist "$HERE/supervisor/SETTLE.md" \
  --ledger-dir "$HERE/.lane/supervisor" \
  --add-dir "$REWT/.worktrees/herdr-brain" \
  --add-dir "$REWT/.org" \
  --max-sessions-per-day 30
