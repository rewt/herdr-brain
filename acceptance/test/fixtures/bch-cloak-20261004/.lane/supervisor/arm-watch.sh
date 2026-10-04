#!/bin/sh
# Arm a visible settle watcher for one org run: when that run's worker stops with
# a report, a fresh orchestrator session opens to settle it (see SETTLE.md).
# Usage: arm-watch.sh R-n [--route settle|settle-critical] [--dry-run]
set -eu
RUN=${1:?usage: arm-watch.sh R-n [--dry-run]}
shift
ROUTE=settle
if [ "${1:-}" = "--route" ]; then
  ROUTE=${2:?--route requires settle or settle-critical}
  shift 2
fi
BASTIAN=/Users/rewt/development/bastian
HERE=$BASTIAN/bch-cloak
set -- "$RUN" \
  --org "$BASTIAN/.org" \
  --cwd "$HERE" \
  --checklist "$HERE/.lane/supervisor/SETTLE.md" \
  --add-dir "$BASTIAN" \
  --add-dir "$HOME/.herdr/worktrees/bch-cloak" \
  --max-sessions-per-day 100 \
  "$@"
case " $* " in
  *" --dry-run "*) exec node "$HERE/scripts/lane/launch-supervisor.mjs" --route "$ROUTE" -- "$@" ;;
  *)               exec node "$HERE/scripts/lane/launch-supervisor.mjs" --route "$ROUTE" -- "$@" --spawn ;;
esac
