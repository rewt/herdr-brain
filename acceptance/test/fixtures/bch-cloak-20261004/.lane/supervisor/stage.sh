#!/bin/sh
# stage.sh [STAGE]: print the items of one stage, highest priority first.
# No argument: the open stage (G-1 meta.stage_now) plus the standing keys track.
set -eu
ORG_DIR=${ORG_DIR:-/Users/rewt/development/bastian/.org}
export ORG_DIR
here=$(cd "$(dirname "$0")" && pwd)
org status --json | python3 "$here/stage.py" "$@"
