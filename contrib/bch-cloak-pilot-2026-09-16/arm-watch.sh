#!/bin/sh
# Arm a visible settle watcher for one org run: when that run's worker stops with
# a report, a fresh orchestrator session opens to settle it (see SETTLE.md).
# Usage: arm-watch.sh R-n [--dry-run]
set -eu
RUN=${1:?usage: arm-watch.sh R-n [--dry-run]}
shift
BASTIAN=/Users/rewt/development/bastian
HERE=$BASTIAN/bch-cloak
set -- "$RUN" \
  --org "$BASTIAN/.org" \
  --cwd "$HERE" \
  --lane-config "$BASTIAN/.lane.json" \
  --checklist "$HERE/.lane/supervisor/SETTLE.md" \
  --add-dir "$BASTIAN" \
  --add-dir "$HOME/.herdr/worktrees/bch-cloak" \
  "$@"
case " $* " in
  *" --dry-run "*) exec node /Users/rewt/development/rewt/herdr-org/contrib/settle-watch.mjs "$@" ;;
  *)               exec node /Users/rewt/development/rewt/herdr-org/contrib/settle-watch.mjs "$@" --spawn ;;
esac
