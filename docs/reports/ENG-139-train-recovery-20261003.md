---
run: R-190
outcome: done
summary: |
  Fixed all four train recovery paths, including both incomplete settlement stages named in the review. Explicit capped-findings corrections survive main moving; record-stage replay waits for report ingestion; lost review commits are proved before recapture; failed velocity notes do not suppress cleanup; validated tips already contained in later main are adopted without another gate or replay. The six failure-path regression cases were written and failed before implementation, then passed; all 61 tests in the three changed test files passed. Changes, documentation and test evidence are committed in 161a036. This report precedes its record check, report commit and final lane check.
headline: Train recovery now survives advancing main and failed velocity notes.
blockers: []
proposals: []
learnings:
  - The second incomplete stage cited by the review is commit-review after a successful Git commit loses its response.
  - Record-stage recapture must defer lane mutation until the captured report is ingested and its immutable record hash is checked.
  - A validated train tip can remain integrated after later batches advance main; ancestry proves adoption without replaying already landed work.
artifacts:
  - "Commit 161a036: fix: recover settle and promotion trains after main advances"
  - "settle/settle.mjs"
  - "settle/test/recapture.test.mjs"
  - "promote/promote.mjs"
  - "promote/train.mjs"
  - "promote/test/train.test.mjs"
  - "promote/test/promote.test.mjs"
  - "settle/README.md"
  - "promote/README.md"
  - "docs/reports/evidence/R-190/recovery-red.tap"
  - "docs/reports/evidence/R-190/touched-green.tap"
  - "docs/reports/evidence/R-190/runner-sandbox-blocked.tap"
decisions: []
questions: []
challenges: []
---

The implementation follows the four findings in `docs/reviews/train/a93bd1d-r2.md`:

- `--retry --fix-findings` bypasses recapture and tolerates moving main in the completed-stage readiness checks. It still checks lane identity, branch, head, cleanliness, report hash, current run and record readiness. The correction owns subsequent recapture under its new run. Tests move main both without conflict and with a conflicting change and prove one correction dispatch across repeated retries.
- At `record`, recapture persists the target while retaining the last successful base. Replay begins after report intake and readiness checks. The regression interrupts intake twice, advances main twice, proves the lane stays untouched while intake is pending, then checks that the recorded report authorizes one replay onto the latest main.
- At `commit-review`, recovery proves the exact single parent, sole changed review path and captured review-byte hash before accepting the committed head. The same proof is used by recapture and ordinary commit recovery. Tests cover a lost successful commit response followed by moved main, and refuse unrelated work, altered review bytes and a forged merge commit without modifying the lane or launching another reviewer.
- Promotion cleanup gates on the train's integration warnings. Velocity-note failures remain visible in the result warnings but allow finished-tab cleanup and conditional lane close. The offline transport fixture fails the actual velocity-note call and proves only the recorded finished tab and promoted lane are closed; the operator tab and other lane remain.
- A saved `validated` attempt checks `merge-base --is-ancestor` against main. A contained tip advances to integration bookkeeping even after another batch lands; an unrelated moved main still follows the existing stale/replan path. The crash test interrupts after a real fast-forward, lets a separate later batch advance main, then proves resume keeps main unchanged, adds no attempt or duplicate commits, runs no third gate and closes the recovered lane.

Test-first command:

```sh
node --import ./test/helpers/fixture-policy.mjs --test --test-name-pattern='recovery:' settle/test/recapture.test.mjs promote/test/train.test.mjs promote/test/promote.test.mjs
```

Before implementation: **6 failures**, zero passes, with the other 52 existing tests excluded by the name filter. Each failure reproduced its cited recovery defect. After implementation the same six cases passed. Three additional refusal cases were then included in the changed-file run.

Final focused validation:

```sh
node test/helpers/run.mjs settle/test/recapture.test.mjs promote/test/train.test.mjs promote/test/promote.test.mjs
```

**61 passed, 0 failed, 0 cancelled, 0 skipped**, in 78.898 seconds. The initial sandboxed runner attempt could not obtain the macOS process snapshot required for fixture ownership and cleanup. Its coordinator was stopped through a fresh verified identity; a subsequent inspection confirmed no surviving fixtures in its group. The identical three-file run succeeded with process-inspection access. The partial diagnostic and final TAP evidence are committed. Diff whitespace checks passed.

Promotion's combined-tree green gate, clean replay, shared lock, conditional close and fast-forward-only integration remain in place. This lane ran no baseline, full project suite, promotion suite, lane suite or release acceptance harness, and performed no live dispatch, settlement, promotion, push or housekeeping loop. All model/transport behavior in the tests is offline and scripted.

The required sequence is code commit, this report, record check, report commit, then `node lanes/lane.mjs check` as the final action. This report makes no advance claim about that final fast lane check; its result will be in `.lane/gate.json` and the referenced validation log.
