#!/bin/sh
# Arms the one worker watcher. It validates the stopped worker's report and
# tells the long-running supervisor; SETTLE.md tells that supervisor how to
# open a fresh settle session as a separate action.
# Usage: arm-watch.sh R-n [--dry-run]
set -eu
RUN=${1:?usage: arm-watch.sh R-n [--dry-run]}
shift
REWT=/Users/rewt/development/rewt
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
HERE=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
set -- "$RUN" --org "$REWT/.org" --to supervisor-herdr --cwd "$HERE" "$@"
case " $* " in
  *" --dry-run "*) exec node "$HERE/watch/watch.mjs" "$@" ;;
  *)               exec node "$HERE/watch/watch.mjs" "$@" --spawn ;;
esac
