#!/bin/zsh
# usage: apply-settle.sh SETTLE-REPORT SETTLE-RUN [--dry-run]
# Applies a settle report whose next_action is dispatch-review (operator 2026-09-28):
#   1. runs its org_commands (ingest, reopen, add the review item),
#   2. ingests the settle report itself under SETTLE-RUN,
#   3. extracts the draft brief for the new review item and removes commit rights,
#   4. dispatches the review on the route that routing.json selection_policy names:
#      the reviewer runs on the other provider from the engineer of the settled run.
# Any other next_action (dispatch-fix, escalate, park) is refused: those need a supervisor decision.
set -eu
REP=$1 SRUN=$2 DRY=${3:-}
ROOT=/Users/rewt/development/bastian; A=$ROOT/archive; cd $ROOT/bch-cloak
export ORG_DIR=$ROOT/.org
O(){ org "$@"; }  # the org launcher on PATH (2026-10-01: herdr-monitor releases, not the herdr-brain checkout)
field(){ sed -n "s/^$1: *//p" $REP | head -1 | tr -d '"'; }
[ "$(field next_action)" = dispatch-review ] || { echo "next_action is '$(field next_action)', not dispatch-review: decide by hand"; exit 1; }
SETTLED=$(field settled_run)
HARN=$(python3 -c "
import json,sys
for l in open('$ORG_DIR/events.jsonl'):
    e=json.loads(l)
    if e.get('type')=='run.started' and e.get('id')=='$SETTLED': print(e['meta'].get('harness','')); break")
EMODEL=$(python3 -c "
import json,sys
for l in open('$ORG_DIR/events.jsonl'):
    e=json.loads(l)
    if e.get('type')=='run.started' and e.get('id')=='$SETTLED': print(e['meta'].get('model','')); break")
# 2026-10-02 (Claude weekly budget ~25%): Codex-engineered work is reviewed cross-model within Codex (Astra <-> Sol);
# set CLAUDE_REVIEWS=1 to restore Opus reviews. Backup: apply-settle.sh.bak-20261002-claude-budget
if [ "$HARN" = codex ] && [ "${CLAUDE_REVIEWS:-0}" != 1 ]; then
  case $EMODEL in gpt-6-astra*) HARN=codex-astra ;; *) HARN=codex-sol ;; esac
fi
case $HARN in
  codex-sol)   ROUTE=review-critical-astra HK=codex MODEL=gpt-6-astra EFF=max ;;
  codex-astra) ROUTE=review-critical HK=codex MODEL=gpt-6.1-sol EFF=xhigh ;;
  codex)  ROUTE=review-critical-opus HK=claude MODEL=claude-opus-5-5 EFF=xhigh ;;
  claude) ROUTE=review-critical HK=codex MODEL=gpt-6.1-sol EFF=xhigh ;;
  *) echo "cannot find the harness of settled run $SETTLED"; exit 1 ;;
esac
DC=$(field dispatch_command | sed "s/^['\"]//; s/['\"]$//")
LANE=$(echo $DC | awk '{print $3}')      # the review lane topic
BASE=$(echo $DC | awk '{print $NF}')     # the engineer lane ref
echo "settled $SETTLED ($HARN) -> review on $ROUTE ($HK), lane $LANE from $BASE"
[ "$DRY" = --dry-run ] && exit 0
ID=
python3 - $REP <<'PY' > /private/tmp/apply-settle-cmds.$$
import sys,re
s=open(sys.argv[1]).read()
blk=s[s.index('org_commands:'):s.index('dispatch_command:')]
flow=blk[len('org_commands:'):].strip()
if flow.startswith('['):   # flow-style list (a settle desk wrote one on 09-30): JSON-compatible double-quoted strings
    import json
    for c in json.loads(flow): print(c)
    sys.exit(0)
for m in re.finditer(r'^\s*-\s*(["\'])(.*)\1\s*$', blk, re.M): print(m.group(2).replace('\\"','"') if m.group(1)=='"' else m.group(2).replace("''","'"))
PY
# refuse before running anything if a command carries a placeholder other than the known spellings (09-30: the
# settle's own ITEM-SERVERS-NEW/ITEM-DEPLOY-NEW were normalised to the review id and blocked it on itself)
odd=$(grep -oE '\b[A-Z]+(-[A-Z]+)*-(NEW|PROPOSAL)(-[A-Z]+)*\b|\bFOLLOWON-[A-Z-]+\b' /private/tmp/apply-settle-cmds.$$ | grep -vxE 'ITEM-NEW|NEW-ITEM-ID|ITEM-PROPOSAL|NEW-PROPOSAL-ID' | sort -u)
[ -z "$odd" ] || { echo "custom placeholders ($odd): apply by hand"; rm -f /private/tmp/apply-settle-cmds.$$; exit 1; }
while IFS= read -r c; do
  # settle desks spell placeholders several ways (ITEM-NEW, NEW-ITEM-ID, ITEM-PROPOSAL, NEW-PROPOSAL-ID...): normalise
  c=$(print -r -- "$c" | python3 -c 'import re,sys; t=sys.stdin.read().rstrip("\n"); t=re.sub(r"\b(?:[A-Z]+-)*PROPOSAL(?:-[A-Z]+)*\b","ITEM-PROPOSAL",t); t=re.sub(r"\b(?![A-Z]+-\d)(?:[A-Z]+-)*NEW(?:-[A-Z]+)*\b","ITEM-NEW",t); t=re.sub(r"\bITEM-(?!NEW\b|PROPOSAL\b)[A-Z]+\b","ITEM-PROPOSAL",t); print(t)')
  [ -n "$ID" ] && c=${c//ITEM-NEW/$ID}   # later commands may name the review item just added
  if [[ "$c" == *ITEM-PROPOSAL* ]]; then   # the item the settled run's report proposed (created on its ingest)
    PROP=$(grep "\"by\":\"run:$SETTLED\"" $ORG_DIR/events.jsonl | grep '"type":"item.added"' | sed 's/.*"id":"\([A-Z]*-[0-9]*\)".*/\1/')
    # an engineer report often proposes its own review too; the settle adds the review item, so prefer the non-review one
    [ $(echo "$PROP" | grep -c .) -gt 1 ] && PROP=$(echo "$PROP" | grep -v '^REV-')
    [ $(echo "$PROP" | grep -c .) = 1 ] || { echo "ITEM-PROPOSAL is ambiguous ($PROP): decide by hand"; exit 1; }
    c=${c//ITEM-PROPOSAL/$PROP}
  fi
  out=$(eval "$c" 2>&1) || { echo "org command failed: $c"; echo "$out"; exit 1; }
  echo "$out" | grep -v '^note' | tail -1
  case "$c" in *" add "*) ID=$(echo "$out" | head -1 | awk '{print $1}') ;; esac
done < /private/tmp/apply-settle-cmds.$$
rm -f /private/tmp/apply-settle-cmds.$$
[ -n "$ID" ] || { echo "no review item was added"; exit 1; }
O ingest $REP --run $SRUN | grep -v '^note' | tail -1
D=$(date +%Y%m%d); UP=${(U)LANE}
B=$A/BRIEF-$ID-$UP-$D.md; R=$A/$ID-$UP-$D.md
python3 .lane/supervisor/extract-brief.py $REP $ID $B $R $LANE | tail -1
sed -i '' "s/Commit on \`lane\/$LANE\`; no push\./Reviewers do not commit; no push./" $B
grep -q 'Reviewers do not commit' $B || printf '\n## Supervisor addition\n\nReview only: reviewers do not edit, fix or commit; no push.\n' >> $B
# host-quiet waits starve at ~10 lanes (ORCH-39 decision 2026-09-30 22:30): every review brief carries the current rule
printf '\n## Waiting rule (ORCH-39, 2026-09-30 22:30; overrides any waiting rule above)\n\nDo not wait for an empty host. One test suite at a time per session, no synthetic load. Targeted suites, mutations and probes run with `--testTimeout=30000 --maxWorkers=4 --minWorkers=1` and record the load average; a timeout under load is re-run alone once before it counts. A review needs no full gate. Only validate:all-safe and the full simulator suite (validate:pool-multiparty-sim, or p0-gate.test.ts / sandbox-boundary.test.ts) use the host test slot; every other suite runs directly with no test-slot wrapper.\n' >> $B
# reviews run on a fixed review desk detached at the engineer commit, never on a new lane (operator 2026-09-28)
SHA=$(git rev-parse --short "$BASE")
DESK=$(.lane/supervisor/review-desk.sh $BASE) || exit 1
sed -i '' "s|lane/$LANE|the review desk worktree /Users/rewt/.herdr/worktrees/bch-cloak/lane-$DESK, detached at $SHA ($BASE)|g" $B
printf '\n## Review desk\n\nYou review in /Users/rewt/.herdr/worktrees/bch-cloak/lane-%s. First command: `git checkout --detach %s` (%s), then print HEAD and a clean tree. Make no edits or commits. Last command: `git checkout lane/%s`, leaving the desk clean.\n' $DESK $SHA $BASE $DESK >> $B
.lane/supervisor/dispatch.sh $ID $DESK $ROUTE $HK $MODEL $EFF $B $R 2>&1 | tail -1
