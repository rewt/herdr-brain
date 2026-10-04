#!/bin/zsh
# usage: settle.sh R-n KIND(engineer|review) LANE-TOPIC [DESK=settle-desk]
# Dispatches one Codex settle agent (route settle) on the settle-desk lane for run R-n.
set -eu
RUNID=$1 KIND=$2 LANE=$3 DESK=${4:-}
# pick a free desk: a desk is busy while an agent in its worktree is working (a clash on 09-28 aborted R-659)
busy(){ herdr agent list 2>/dev/null | python3 -c "import sys,json
a=json.load(sys.stdin)['result']['agents']
sys.exit(0 if any(x.get('cwd','').endswith('/lane-'+sys.argv[1]) for x in a) else 1)" $1; }
if [ -z "$DESK" ]; then for d in settle-desk settle-desk-2 settle-desk-3; do busy $d || { DESK=$d; break; }; done; fi
[ -n "$DESK" ] || { echo "both settle desks are busy; retry when one reports (no org run started)"; exit 1; }
busy $DESK && { echo "$DESK is busy; pick the other desk or wait (no org run started)"; exit 1; }
ROOT=/Users/rewt/development/bastian; A=$ROOT/archive; cd $ROOT/bch-cloak
REP=$(org show $RUNID | sed -n 's/^report path: //p')
[ -n "$REP" ] || { echo "no report path for $RUNID"; exit 1; }
D=$(date +%Y%m%d)
BR=$A/BRIEF-SETTLE-$RUNID-$D.md
OUT=$A/SETTLE-$RUNID-$D.md
cat > $BR <<B
# Brief: settle $RUNID (org run **R-RUN**)

Follow \`$A/SETTLE-DESK-POOL-20260927.md\` exactly.

- RUN: $RUNID
- REPORT: $REP
- KIND: $KIND
- LANE: lane/$LANE, worktree /Users/rewt/.herdr/worktrees/bch-cloak/lane-$LANE

Your own worktree is the $DESK lane (use \`lane/$DESK\` wherever the protocol says \`lane/settle-desk\`). Its first command must print its HEAD and a clean tree.

Required output: an org report at \`$OUT\` with front matter \`run: R-RUN\`. Run \`org check\` on it until it passes,
then stop. Do not call herdr.
B
# SETTLE_POOL=claude routes the settle to Opus when Codex cannot start sessions (09-28 outage)
if [ "${SETTLE_POOL:-codex}" = claude ]; then set -- claude claude-opus-5-5 high; else set -- codex gpt-6.1-sol high; fi
.lane/supervisor/dispatch.sh ORCH-39 $DESK settle "$@" $BR $OUT main
