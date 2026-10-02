---
run: R-114
outcome: done
summary: |
  Resolved all three independent-review findings: Git removal refusals preserve
  the lane's running workspace, forbidden focus attempts fail acceptance even
  when the caller suppresses the refusal, and slow completed calls retain late
  focus-event attribution. Applied the supervisor's revised focus rule: external
  changes are recorded and re-baselined; owned or call-correlated changes fail.
  Full acceptance passed all 27 cases with 1,372 samples, zero harness focus
  changes, zero forbidden attempts, and one recorded external change.
headline: Acceptance passed without stealing the operator's focus
blockers: []
proposals: []
learnings:
  - A clean worktree can still refuse Git removal because it is locked; verify and retain its Herdr workspace ID before removal, but close that workspace only after Git succeeds.
  - A refused focus operation needs an independent typed receipt because a caller can suppress its failure and successfully fall back to Git.
  - Completed-call attribution must expire after the completion timestamp, including when overlapping calls finish out of start order.
  - External operator or unrelated-project navigation requires a new baseline; fail moves into owned panes or workspaces and moves correlated with candidate or harness calls.
artifacts:
  - "Commit: Preserve locked lanes and reject swallowed focus attempts"
  - "Commit: Rebaseline acceptance focus after external navigation"
  - "Commit: Report corrected operator focus acceptance"
  - "Branch: lane/operator-focus"
  - "docs/reports/ENG-98-operator-focus-r2-evidence-20261002/candidate/summary.json"
  - "docs/reports/ENG-98-operator-focus-r2-evidence-20261002/candidate/focus-summary.json"
  - "/private/tmp/eng98-r114-rerun/herdr-acceptance-48M06Q/evidence/focus-trace.jsonl"
  - "/private/tmp/eng98-r114-rerun/herdr-acceptance-48M06Q/evidence/focus-calls.jsonl"
  - "/private/tmp/eng98-r114-rerun/herdr-acceptance-48M06Q/evidence/discovery-usage.json"
  - "/private/tmp/eng98-r114-rerun/herdr-acceptance-48M06Q/evidence/implicit-source-cleanup/verification.json"
  - "/private/tmp/eng98-r114-rerun/herdr-acceptance-48M06Q/evidence/implicit-source-cleanup/focus-summary.json"
  - "/private/tmp/eng98-r114-full-gate/herdr-acceptance-mWnxtN/evidence/summary.json"
  - "/private/tmp/eng98-r114-regressions-before.log; /private/tmp/eng98-r114-regressions-after.log"
  - "/private/tmp/eng98-r114-before-tests.log; /private/tmp/eng98-r114-external-after-tests.log"
  - "/private/tmp/eng98-r114-lanes-tests.log; /private/tmp/eng98-r114-external-acceptance-tests.log"
  - "Final validation command: node lanes/lane.mjs check; exact committed-HEAD receipt: .lane/gate.json"
decisions:
  - text: Preserve the verified workspace's running panes when Git refuses to close the lane.
    category: design
    why: A locked-worktree refusal must preserve its running panes and branch; successful unmerged closure continues to retain archive-tag recovery.
  - text: Retain typed forbidden-focus receipts and give them precedence over caller success or monitor limitations.
    category: prover
    why: The existing capability refusal must remain a failing gate witness even if the caller suppresses the error and completes its Git fallback.
  - text: Record and re-baseline unrelated focus changes while failing owned or call-correlated moves.
    category: prover
    why: The supervisor explicitly revised the rule after identifying the first destination as an unrelated bch-cloak lane using an older lane implementation. Operator and other-project activity must not be attributed to this acceptance run.
questions: []
challenges:
  - premise: Every observed global focus move is evidence of this candidate stealing focus.
    evidence: The first run moved to w252:p1 without a correlated harness call or ownership receipt. The supervisor identified that workspace as bch-cloak's lane-pool-scale-state using release v0.1.2. The successful rerun separately witnessed an unowned move from wFN:pY6 to wHD:pR with no correlated call.
    resolution: Apply the supervisor's revised ownership and correlation rule; retain external changes in both trace and summary and re-baseline on them.
  - premise: A green receipt-owned cleanup audit accounts for implicit source workspaces.
    evidence: Each live run left one implicit default-cycle source workspace outside its ownership ledger, the existing ENG-99 gap. Both were independently verified against successful creation receipts, pre-run absence, native workspace IDs and canonical Git identities.
    resolution: Close only those verified run-created source workspaces under separate zero-change focus traces. ENG-99 remains the existing follow-on; no duplicate proposal was created.
---

All three round-1 findings are resolved, and the prior R-113 report is unchanged.
The three added regression controls failed against the reviewed implementation
before the fixes and passed afterward.

The locked-worktree control proves that refusal leaves the worktree, branch and
workspace intact, then unlocks it and proves successful archived closure. The
swallowing-caller control actually removes a scratch worktree through Git and
exits successfully after suppressing the adapter refusal; the focus case still
returns a product failure from its typed receipt. The slow-call control runs for
over one second, completes after a later-started overlapping call, and verifies
that a subsequent focus event names both the requested and transported calls.

The revised monitor serializes event observations, resolves destination workspace
IDs through read-only native receipts, and retains lifetime ownership through
cleanup. Offline controls also cover sampled external navigation, transient
external events, an unlisted pane in an owned workspace after the ledger is
removed, a correlated move to a foreign pane, broken monitoring, and forbidden
attempts with unchanged samples. It never restores or directly changes focus.

| Validation | Result |
| --- | --- |
| Baseline npm test | 683 pass, 0 fail, 11 skip |
| Post-change npm test, including the supervisor correction | 683 pass, 0 fail, 11 skip |
| npm run test:lanes | 151 pass, 0 fail, 0 skip |
| npm run test:acceptance after the supervisor correction | 75 pass, 0 fail, 0 skip |
| Full acceptance of the committed corrected candidate | 27 pass, 0 fail, 0 pending |

The successful full run lasted **420 seconds**. Its read-only monitor retained
**1,372 samples over 419,735 ms**, zero harness focus changes, zero forbidden
attempts, zero monitoring errors and one external change. At the routing case,
focus moved from **wFN:pY6** to **wHD:pR** with an empty call correlation and an
unowned destination workspace. The trace records that change and re-baselines;
the candidate preserved the new baseline through cleanup. All four measured
discovery sessions used **gpt-5.6-luna / low** and exited successfully.

```sh
ACCEPTANCE_TMPDIR=/private/tmp/eng98-r114-rerun node acceptance/run.mjs \
  --candidate HEAD \
  --bch-cloak /Users/rewt/development/bastian/bch-cloak \
  --npm-cache /Users/rewt/.npm \
  --discovery-model gpt-5.6-luna --discovery-effort low --keep
```

The snapshot resolved to the commit with subject **Rebaseline acceptance focus
after external navigation**. Only summaries and the result screen are tracked;
raw calls, traces and measured usage remain in scratch. The first attempt is
retained as diagnostic evidence: 24 pass, 1 focus failure and 2 harness-pending
results caused by an externally closed scripted canary workspace. All ten copied
switch/rollback checks passed on the rerun.

Authentication copies were removed, and the receipt-owned cleanup audit retained
no workspace residue or errors. Each run's implicit source workspace was then
closed only after independent ownership proof. The successful rerun's separate
cleanup monitor retained **three samples, zero harness changes, zero external
changes and zero errors**, with **wHD:pR** preserved. The existing implicit-source
ownership gap remains tracked as ENG-99.

All changes are on this lane. Live bch-cloak, shared lane configuration, releases
and the operator's bin remain untouched; no push or publish was performed. The
report is checked and committed before the final configured lane check, which
records the exact committed HEAD in `.lane/gate.json`.
