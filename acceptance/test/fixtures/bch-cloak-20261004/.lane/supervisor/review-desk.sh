#!/bin/zsh
# usage: review-desk.sh ENGINEER-REF
# Picks a free review desk (review-desk, review-desk-2), makes sure its worktree exists and is clean, and leaves it
# on its branch (the lane dispatcher needs the branch checked out); the reviewer detaches at ENGINEER-REF as its
# first command and returns the desk to its branch as its last. Prints the desk topic. Reviews never get their own lane (operator 2026-09-28): reviewers do not
# commit, so a per-review lane only accumulates. Refuses (no org run started) when both desks are busy or dirty.
set -eu
REF=$1
ROOT=/Users/rewt/development/bastian; cd $ROOT/bch-cloak
SHA=$(git rev-parse --verify -q "$REF^{commit}") || { echo "unknown ref $REF" >&2; exit 1; }
busy(){ herdr agent list 2>/dev/null | python3 -c "import sys,json
a=json.load(sys.stdin)['result']['agents']
sys.exit(0 if any(x.get('cwd','').endswith('/lane-'+sys.argv[1]) for x in a) else 1)" $1; }
for d in review-desk review-desk-2 review-desk-3 review-desk-4 review-desk-5 review-desk-6; do
  busy $d && continue
  WT=/Users/rewt/.herdr/worktrees/bch-cloak/lane-$d
  if [ ! -d $WT ]; then node scripts/lane/lane.mjs open $d main >/dev/null 2>&1 || { echo "cannot open $d" >&2; continue; }; fi
  [ -z "$(git -C $WT status --porcelain)" ] || { echo "$d is dirty; skipping" >&2; continue; }
  git -C $WT checkout -q lane/$d 2>/dev/null || true
  echo $d; exit 0
done
echo "all review desks are busy or dirty (no org run started)" >&2; exit 1
