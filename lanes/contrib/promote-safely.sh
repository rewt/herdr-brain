#!/bin/bash
# Promote a lane from a supervisor process and report the REAL exit code plus a
# one-line outcome, even when the caller only sees the tail of a log. Never
# trust a trailing pipeline's status.
#   usage: promote-safely.sh <repo-checkout> <topic> <logfile>
# Note: this script exits with promote's status, but a caller that chains
# several promotions must test the OUTCOME line, and must never run two
# promotions in the same checkout at once — their prepare/build steps race.
set -u
repo="$1"; topic="$2"; log="$3"
lane="$(cd "$(dirname "$0")/.." && pwd)/lane.mjs"
cd "$repo" || { echo "OUTCOME: cannot cd to $repo"; exit 2; }
if pgrep -f "lane.mjs promote" >/dev/null; then echo "OUTCOME: another promotion is running; refused"; exit 3; fi
node "$lane" promote "$topic" > "$log" 2>&1
rc=$?                                  # captured BEFORE anything else runs
outcome=$(grep -E "^promoted lane/|nothing merged|validation failed|moved during validation|does not rebase cleanly|no such lane|has no worktree|is not clean|prepare step failed" "$log" | tail -1)
printf 'OUTCOME: rc=%s %s\n' "$rc" "${outcome:-<no outcome line found - read the log>}"
exit "$rc"
