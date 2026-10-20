#!/bin/sh
# Arms the one worker watcher. It validates the stopped worker's report and
# tells the long-running supervisor; supervisor/PROTOCOL.md tells that supervisor how to
# open a fresh settle session as a separate action.
# External Brain launch: record start -> record claim R-n --controller brain
# -> dispatch/record-worker.mjs -> arm-watch.sh. For an existing own worker with
# no operation receipts, explicitly claim with --admit-worker before re-arming.
# Old Brain receipts use --adopt-brain-receipt FILE; see PROTOCOL.md. This script
# never implicitly claims an ambiguous legacy run.
# Usage: arm-watch.sh R-n [--org RECORD] [--cwd PROJECT] [--to NAME]
#                     [--detach --log FILE | --dry-run]
set -eu
RUN=${1:?usage: arm-watch.sh R-n [--org RECORD] [--cwd PROJECT] [--to NAME]}
shift
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
HERE=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd -P)
# Discovery uses the caller's project, never this installed release's checkout.
MODE=--spawn
for ARG in "$@"; do
  case "$ARG" in --detach|--dry-run|--spawn) MODE= ;; esac
done
exec node "$HERE/herdr/releases.mjs" run watch/watch.mjs "$RUN" "$@" ${MODE:+"$MODE"}
