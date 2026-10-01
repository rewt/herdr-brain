#!/bin/zsh
# usage: promote-queue.sh [AFTER-FILE AFTER-PATTERN]
# One long-running promotion worker (2026-10-01): pops the first topic from promote-queue.txt and runs promote.sh on it,
# one at a time, so promotions never race (two promote.sh instances starting in the gap between chain items was a
# real hazard). The supervisor reorders by editing the file; a line is consumed only when its promotion starts.
# Optional AFTER-FILE/AFTER-PATTERN: wait until that file contains the pattern (a running chain's last line) first.
set -u
ROOT=/Users/rewt/development/bastian; cd $ROOT/bch-cloak
Q=.lane/supervisor/promote-queue.txt; LOG=.lane/supervisor/watch-logs/promote-queue.log
touch $Q
if [ $# -eq 2 ]; then until grep -q "$2" "$1" 2>/dev/null; do sleep 30; done; fi
while :; do
  T=$(grep -v '^\s*\(#\|$\)' $Q | head -1)
  if [ -z "$T" ]; then sleep 60; continue; fi
  # consume the line before promoting, so an edit during the gate cannot re-run it
  python3 - "$Q" "$T" <<'PY'
import sys
p,t=sys.argv[1:3]; lines=open(p).read().splitlines(); out=[]; done=False
for l in lines:
    if not done and l.strip()==t: done=True; continue
    out.append(l)
open(p,'w').write('\n'.join(out)+('\n' if out else ''))
PY
  echo "$(date '+%Y-%m-%d %H:%M:%S') start $T" >> $LOG
  .lane/supervisor/promote.sh "$T" >> $LOG 2>&1; rc=$?
  echo "$(date '+%Y-%m-%d %H:%M:%S') done $T rc=$rc main=$(git rev-parse --short main)" >> $LOG
  # tell the supervisor every outcome (2026-10-01: a silent queue left the night idle from 02:20 to 07:49)
  why=$(tail -3 /private/tmp/$T-promote/promote.log 2>/dev/null | grep -E 'lane:|failed|promoted' | head -1 | cut -c1-160)
  M="[promote-queue] $T rc=$rc main=$(git rev-parse --short main) ${why} -- next: $(grep -v '^\s*\(#\|$\)' $Q | head -1)"
  for i in 1 2 3 4 5 6; do env -u HERDR_PANE_ID herdr agent prompt supervisor-opus "$M" >/dev/null 2>&1 && break; sleep 30; done
done
