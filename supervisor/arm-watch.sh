#!/bin/sh
# Arms the watcher that opens a fresh settle session when one run stops; the
# operator runs it directly, and SETTLE.md tells settle sessions to run it.
# Usage: arm-watch.sh R-n [--dry-run]
set -eu
RUN=${1:?usage: arm-watch.sh R-n [--dry-run]}
shift
REWT=/Users/rewt/development/rewt
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
HERE=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
set -- "$RUN" \
  --org "$REWT/.org" \
  --cwd "$HERE" \
  --lane-config "$REWT/.lane.json" \
  --checklist "$HERE/supervisor/SETTLE.md" \
  --ledger-dir "$HERE/.lane/supervisor" \
  --add-dir "$REWT/.worktrees/herdr-brain" \
  --add-dir "$REWT/.org" \
  --max-sessions-per-day 30 \
  "$@"
case " $* " in
  *" --dry-run "*) exec node "$HERE/contrib/settle-watch.mjs" "$@" ;;
  *)               exec node "$HERE/contrib/settle-watch.mjs" "$@" --spawn ;;
esac
