#!/bin/sh
# Opens a fresh executive session to act on answers and start ready work; the
# operator runs it directly.
# Usage: continue.sh ["what to focus on"] [--dry-run]
set -eu
REWT=/Users/rewt/development/rewt
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
HERE=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
FOCUS=""
case "${1:-}" in --*|"") ;; *) FOCUS=$1; shift ;; esac
if [ -n "$FOCUS" ]; then
  set -- --open --focus "$FOCUS" "$@"
else
  set -- --open "$@"
fi
exec node "$HERE/contrib/settle-watch.mjs" "$@" \
  --org "$REWT/.org" \
  --cwd "$HERE" \
  --lane-config "$REWT/.lane.json" \
  --checklist "$HERE/supervisor/SETTLE.md" \
  --ledger-dir "$HERE/.lane/supervisor" \
  --add-dir "$REWT/.worktrees/herdr-org" \
  --add-dir "$REWT/.org" \
  --max-sessions-per-day 30
