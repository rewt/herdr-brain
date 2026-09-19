#!/bin/sh
# Open a fresh executive session now, with no finished run to settle: it acts on
# pending decisions and ready work within its authority (see SETTLE.md), then stops.
# Usage: continue.sh ["what to focus on"] [--dry-run]
set -eu
BASTIAN=/Users/rewt/development/bastian
HERE=$BASTIAN/bch-cloak
FOCUS=""
case "${1:-}" in --*|"") ;; *) FOCUS=$1; shift ;; esac
exec node /Users/rewt/development/rewt/herdr-brain/contrib/settle-watch.mjs --open \
  ${FOCUS:+--focus "$FOCUS"} \
  --org "$BASTIAN/.org" \
  --cwd "$HERE" \
  --lane-config "$BASTIAN/.lane.json" \
  --checklist "$HERE/.lane/supervisor/SETTLE.md" \
  --add-dir "$BASTIAN" \
  --add-dir "$HOME/.herdr/worktrees/bch-cloak" \
  "$@"
