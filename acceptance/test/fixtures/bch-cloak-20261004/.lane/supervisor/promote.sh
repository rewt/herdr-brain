#!/bin/zsh
# usage: promote.sh TOPIC   (LANE_VALIDATE in the environment narrows the gate, as for lane.mjs promote)
# One promotion, start to finish (operator 2026-09-28): refuse (exit 75) while another promotion runs, promote with
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
# promotions serialize strictly (fast-forward of main). The supervisor runs this by hand, one topic at a time (2026-10-03: no daemon
# runs promotions). No polling: exit 75 when another promotion runs; run it again after that one reports, never in a retry loop.
# The kernel lock covers this whole script, including the close and tab housekeeping after lane.mjs promote; the pgrep (this repo's scripts/lane/lane.mjs only: herdr-brain runs its own lanes/lane.mjs promote) also refuses
# while a lane.mjs promote started outside this script runs. Other lanes' gates are not waited for here: the gate of record waits for
# the host test slot itself (BCH_CLOAK_TEST_SLOT_WAIT_SECONDS above).
zmodload zsh/system
PLOCK=/private/tmp/bch-cloak-promote.flock; : >> $PLOCK
zsystem flock -t 0 -f PROMOTE_LOCK_FD $PLOCK 2>/dev/null || { echo "another promote.sh is running; $T not started (exit 75)"; exit 75; }
if pgrep -f 'scripts/lane/lane.mjs [p]romote' >/dev/null; then echo "another promotion is running; $T not started (exit 75)"; exit 75; fi
node scripts/lane/lane.mjs promote $T > $L/promote.log 2>&1; rc=$?
tail -2 $L/promote.log | cut -c1-200
if [ $rc -ne 0 ]; then echo "promote $T failed (exit $rc); lane kept; log $L/promote.log"; exit $rc; fi
cp $L/promote.log $ROOT/archive/scratch-manifests/promote-$T-$(date +%Y%m%d-%H%M).log 2>/dev/null || true
node scripts/lane/lane.mjs close $T 2>&1 | tail -1
.lane/supervisor/close-finished-agents.sh | grep -c '^closed' | sed 's/^/closed finished agent tabs: /'
echo "main $(git rev-parse --short main)"
