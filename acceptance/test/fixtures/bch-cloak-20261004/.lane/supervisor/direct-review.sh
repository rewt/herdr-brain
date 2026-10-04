#!/bin/zsh
# usage: [REVIEWED=<sha> REVIEWED_BY=<REV-n>] direct-review.sh ENGINEER-RUN [--dry-run]
# REVIEWED marks a fix round: commits up to that sha were already reviewed by REVIEWED_BY; the brief asks for a delta review.
# Routine engineer reports go straight to review, with no settle hop (operator 2026-10-02, to shorten review cycles).
# The reviewer takes over the settle desk's checks (scope against the brief, evidence checksums, rerun of the named suites and every claimed
# control) in addition to the review. Refuses anything not routine; those still go through settle.sh:
#   outcome other than done, any blocker, a missing or failing report, a dirty engineer lane, or no commit ahead of main.
# Routine is also a supervisor judgement: send to settle.sh instead when the report claims chain, proving, funding or approval work, changes a
# frozen contract or pin, or asks for a decision. Review routing is the same as apply-settle.sh (cross-model within Codex unless CLAUDE_REVIEWS=1).
set -eu
RUN=$1 DRY=${2:-}
ROOT=/Users/rewt/development/bastian; A=$ROOT/archive; cd $ROOT/bch-cloak
export ORG_DIR=$ROOT/.org
O(){ org "$@"; }
meta=$(python3 - $RUN <<'PY'
import json,sys
run=sys.argv[1]; m=None; item=''
for l in open('/Users/rewt/development/bastian/.org/events.jsonl'):
    e=json.loads(l)
    if e.get('id')==run and e.get('type')=='run.started':
        m=dict(e.get('meta',{})); item=e.get('item') or m.get('item','')
        for k in ('report_path','brief_path'): m[k]=e.get(k) or m.get(k,'')
    if e.get('id')==run and e.get('type')=='run.updated': m.update(e.get('meta',{}))
if m is None: sys.exit('no run '+run)
print('\t'.join([item, m.get('harness',''), m.get('model',''), m.get('lane',''), m.get('report_path',''), m.get('brief_path','')]))
PY
)
IFS=$'\t' read -r ITEM HARN EMODEL ELANE REP EBRIEF <<<"$meta"
[ -n "$ITEM" ] || ITEM=$(O show $RUN | head -1 | awk '{print $3}')
[ -n "$REP" ] || REP=$(O show $RUN | sed -n 's/^report path: //p')
[ -n "$ELANE" ] || ELANE=$(O show $RUN | sed -n 's/.* lane: \([^ ]*\) .*/\1/p' | head -1)
EBRIEF=${EBRIEF:-$(O show $RUN | sed -n 's/^brief: \([^ ]*\).*/\1/p')}
field(){ sed -n "1,/^---$/{s/^$1: *//p;}" $REP | head -1 | tr -d '"'; }
[ -f "$REP" ] || { echo "no report at $REP"; exit 1; }
# ALLOW_BLOCKED=1: supervisor override for a finished, committed slice whose only blocker is an outside dependency (say why in the item note)
if [ "${ALLOW_BLOCKED:-0}" != 1 ]; then
  [ "$(sed -n '2,40{s/^outcome: *//p;}' $REP | head -1 | tr -d '"')" = done ] || { echo "outcome is not done: use settle.sh"; exit 1; }
  grep -qE '^blockers: *\[\] *$' $REP || { echo "report has blockers: use settle.sh"; exit 1; }
fi
O check $REP >/dev/null 2>&1 || { echo "org check fails on the report: use settle.sh"; exit 1; }
WT=/Users/rewt/.herdr/worktrees/bch-cloak/lane-$ELANE
[ -d $WT ] || { echo "no engineer worktree $WT"; exit 1; }
[ -z "$(git -C $WT status --porcelain)" ] || { echo "engineer lane $ELANE is dirty: use settle.sh"; exit 1; }
HEAD=$(git -C $WT rev-parse HEAD); MB=$(git merge-base main $HEAD)
N=$(git rev-list --count $MB..$HEAD); [ $N -gt 0 ] || { echo "no commit ahead of main on $ELANE"; exit 1; }
FILES=$(git diff --name-only $MB..$HEAD)
if [ "$HARN" = codex ] && [ "${CLAUDE_REVIEWS:-0}" != 1 ]; then case $EMODEL in gpt-6-astra*) HARN=codex-astra ;; *) HARN=codex-sol ;; esac; fi
case $HARN in
  codex-sol)   ROUTE=review-critical-astra HK=codex MODEL=gpt-6-astra EFF=max ;;
  codex-astra) ROUTE=review-critical HK=codex MODEL=gpt-6.1-sol EFF=xhigh ;;
  codex)  ROUTE=review-critical-opus HK=claude MODEL=claude-opus-5-5 EFF=xhigh ;;
  claude) ROUTE=review-critical HK=codex MODEL=gpt-6.1-sol EFF=xhigh ;;
  *) echo "cannot find the harness of $RUN"; exit 1 ;;
esac
TITLE=$(O show $ITEM | head -1 | sed "s/^$ITEM  *//")
echo "$RUN ($ITEM, $HARN) lane/$ELANE $MB..$HEAD ($N commits, $(echo $FILES | wc -w | tr -d ' ') files) -> direct review on $ROUTE"
[ "$DRY" = --dry-run ] && { echo "$FILES"; exit 0; }
# session cap (operator 2026-10-02 evening): refuse before creating anything; dispatch.sh enforces the same count
INFLIGHT=$(ps -axo command | sed -n 's/.*notify-watch\.sh \(R-[0-9]*\) --to supervisor-opus.*/\1/p' | sort -u | wc -l | tr -d ' ')
if [ "${FORCE_DISPATCH:-0}" != 1 ] && [ $INFLIGHT -ge ${MAX_SESSIONS:-3} ]; then echo "session cap: $INFLIGHT runs in flight (max ${MAX_SESSIONS:-3}); review of $RUN not started"; exit 3; fi
# pick a free desk before creating anything, so a full desk set cannot leave an orphan review item
DESK=$(.lane/supervisor/review-desk.sh lane/$ELANE) || exit 1
# REVIEW_ID=REV-n: reuse a review item an earlier attempt already created (it ingested the report too), e.g. after no desk was free
if [ -n "${REVIEW_ID:-}" ]; then ID=$REVIEW_ID; else
O ingest $REP --run $RUN | grep -v '^note' | tail -1
ID=$(O add "Independently review $ITEM (direct, no settle): ${TITLE:0:120}" --role reviewer --parent $ITEM --priority 1 | head -1 | awk '{print $1}')
O block $ITEM --by $ID >/dev/null 2>&1 || true
fi
D=$(date +%Y%m%d); UP=${(U)ELANE}
B=$A/BRIEF-$ID-$UP-REVIEW-$D.md; R=$A/$ID-$UP-REVIEW-$D.md; EV=${R%.md}-evidence
SHA=${HEAD:0:8}
cat > $B <<EOF
# Brief: independent review of $ITEM (direct review: no settle step)

Date $(date +%Y-%m-%d). Org run **R-RUN**, item **$ID**, parent $ITEM. Route \`$ROUTE\`. Review only: never edit, fix or commit. No herdr, OpenSpec,
tasks.md, proving, approval, funding, spend, broadcast or Chipnet.

- Engineer run $RUN on \`lane/$ELANE\`. Exact range **$MB..$HEAD**, $N commit(s). Files changed:
$(echo "$FILES" | sed 's/^/  - `/; s/$/`/')
- You review in \`/Users/rewt/.herdr/worktrees/bch-cloak/lane-$DESK\`. First command: \`git checkout --detach $SHA\`, then print HEAD (must be
  **$HEAD**) and a clean tree. Last command: \`git checkout lane/$DESK\`, leaving the desk clean.

$( [ -n "${REVIEWED:-}" ] && printf '%s\n\n' "**Fix round (delta review).** Commits up to \`${REVIEWED}\` were reviewed by ${REVIEWED_BY:-the previous review}, whose findings this round fixes. Review the delta **${REVIEWED}..$HEAD** in full and confirm each finding is fixed with a firing regression; re-check the earlier range only where the delta interacts with it. Parts 1 and 2 apply to the delta." )
## Read

- The engineer's brief: \`$EBRIEF\` (its task, file scope and controls are the acceptance criteria).
- The engineer's report: \`$REP\` and its evidence folder; \`org show $ITEM\` for notes and decisions.

## Part 1: the checks the settle desk used to do (operator 2026-10-02: routine engineer reports skip settle)

1. Scope: every changed file is inside the brief's file scope; name any file outside it. The range is exactly the commits above.
2. Evidence: verify the report's \`SHA256SUMS\`; every claimed artifact exists; report HEAD equals the reviewed HEAD.
3. Rebuild sibling \`dist\` for the touched packages first, then rerun every suite the report names, separately, with
   \`--testTimeout=30000 --maxWorkers=4 --minWorkers=1\`. Record raw exits and executed test counts, and compare them with the report.
4. Rerun each claimed control and mutation witness; a control counts only if you see it fire.

## Part 2: the review

5. Check each acceptance item of the engineer's brief against the code (file:line) and your executed witnesses. Look for vacuous assertions
   (self-comparisons, bounded counts, detectors never seen to fire) and palindromic or all-zero identifiers.
6. At least three independent probes of your own at the boundaries the change creates.
7. Privacy invariants: no seed, key, nullifier material, opening or private amount in logs, argv, stdout, evidence or committed files.
8. No full gate is required (operator 2026-10-02: the one full gate runs at promotion). Do not run \`validate:all-safe\`.

## Report: REQUIRED OUTPUT (the only report path)

Write \`$R\` with front matter \`run: R-RUN\`. State **PASS, NEEDS-WORK or FAIL** in summary and headline. Each finding needs severity,
file:line and an executed witness. Include the part-1 results (scope, checksums, reruns with raw exits) as their own section. Evidence in
\`$EV/\` with SHA256SUMS. Scratch under \`/private/tmp/$ELANE-review-R-RUN/\`. Run \`org check\` on the report until it passes, then stop. No
self-acceptance or promotion.

## Waiting rule (ORCH-39)

Run one test suite at a time, with at most 4 workers (`--maxWorkers=4 --minWorkers=1`), and no synthetic load. Do not wait for an empty host. Record the load average with each suite; a timeout under load is re-run alone once before it counts. Only \`validate:all-safe\` and the full simulator suite (\`validate:pool-multiparty-sim\`, or its SysV files \`p0-gate.test.ts\` and
\`sandbox-boundary.test.ts\`) use the host test slot; every other suite runs directly with no test-slot wrapper. Run everything else first; if the
full simulator suite is needed and the slot is held (a holder whose start time cannot be read is live), end your turn with a final line exactly
\`WAITING-FOR-SLOT\` and do not poll. Never write the report before a WAITING line.
EOF
# report dispatch.sh's own exit status: a pipe into tail always returned 0 (10-02: a capped dispatch looked like success to the retry loop)
rc=0; out=$(.lane/supervisor/dispatch.sh $ID $DESK $ROUTE $HK $MODEL $EFF $B $R 2>&1) || rc=$?
print -r -- "$out" | tail -1
[ $rc = 0 ] || echo "dispatch failed (rc $rc); the review item $ID exists: retry with REVIEW_ID=$ID"
exit $rc
