#!/bin/zsh
# usage: promote.sh TOPIC   (LANE_VALIDATE in the environment narrows the gate, as for lane.mjs promote)
# One promotion, start to finish (operator 2026-09-28): wait until no real gate or promotion is running, promote with
# the gate, and on success close the lane (archive-tagging nothing, since it is merged) and close finished agent tabs.
# The waiter patterns are bracketed so they never match this script's own command line (a 09-28 deadlock).
set -u
T=$1
ROOT=/Users/rewt/development/bastian; cd $ROOT/bch-cloak
# the gate of record runs on the repo's pinned Node (.nvmrc), never whatever the calling shell's PATH holds
# (2026-10-01: sessions ran gates on Node 20.19.4, 22.22.3 and 26 depending on PATH)
NV=$(cat .nvmrc 2>/dev/null); NB=$HOME/.nvm/versions/node/v$NV/bin
[ -n "$NV" ] && [ -x $NB/node ] || { echo "pinned Node v$NV not installed at $NB; refusing to promote"; exit 1; }
export PATH=$NB:$PATH; echo "gate Node $(node --version)"
# the host test slot (ENG-725) refuses a second full gate with exit 75 unless told to wait; the gate of record waits
# up to 2 h for the slot instead of failing the promotion (2026-10-01: ENG-776's promotion was refused by DC2's gate)
export BCH_CLOAK_TEST_SLOT_WAIT_SECONDS=7200
L=/private/tmp/$T-promote; mkdir -p $L
# promotions serialize strictly (fast-forward of main); other lanes' gates get a 15-minute wait at most (ORCH-39
# decision 2026-09-30 22:30: at ~10 lanes the host is never gate-free, and an uncapped wait starved promotions)
until ! pgrep -f 'lane.mjs [p]romote' >/dev/null; do sleep 30; done
w=0; while pgrep -f 'pnpm [v]alidate:all-safe' >/dev/null && [ $w -lt 900 ]; do sleep 30; w=$((w+30)); done
[ $w -ge 900 ] && echo "waited 900 s for other gates; promoting alongside them"
until ! pgrep -f 'lane.mjs [p]romote' >/dev/null; do sleep 30; done
node scripts/lane/lane.mjs promote $T > $L/promote.log 2>&1; rc=$?
tail -2 $L/promote.log | cut -c1-200
if [ $rc -ne 0 ]; then echo "promote $T failed (exit $rc); lane kept; log $L/promote.log"; exit $rc; fi
cp $L/promote.log $ROOT/archive/scratch-manifests/promote-$T-$(date +%Y%m%d-%H%M).log 2>/dev/null || true
node scripts/lane/lane.mjs close $T 2>&1 | tail -1
.lane/supervisor/close-finished-agents.sh | grep -c '^closed' | sed 's/^/closed finished agent tabs: /'
echo "main $(git rev-parse --short main)"
