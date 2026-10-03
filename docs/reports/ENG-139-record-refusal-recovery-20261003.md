---
run: R-192
outcome: done
summary: |
  Resolved the independent review's remaining settlement recovery finding. Temporary record readiness refusals retain their originating stage, and existing completed refusal receipts recover through the saved review and dispatch evidence. Clearing an older overlapping run now permits exactly one review, including after main moves; completed reviews and existing correction runs are reused. The two primary regression cases failed before implementation, then all 28 targeted recovery tests passed. The fix, documentation and test evidence are committed in 2844bb0. This report precedes its record check, report commit and final lane check.
headline: Settlement now resumes after temporary record blockers clear.
blockers: []
proposals: []
learnings:
  - Completed settlement receipts include refusals as well as promotable results; transient record readiness refusals need an explicit continuation stage.
  - Legacy refusal receipts retain enough review and dispatch evidence to resume without repeating a completed review or starting another correction run.
artifacts:
  - "Commit 2844bb0: fix: resume settlement after transient record refusals"
  - "settle/settle.mjs"
  - "settle/test/record-recovery.test.mjs"
  - "settle/README.md"
  - "docs/reports/evidence/R-192/record-recovery-red.tap"
  - "docs/reports/evidence/R-192/record-recovery-green.tap"
  - "docs/reports/evidence/R-192/recapture-green.tap"
decisions: []
questions: []
challenges: []
---

Addressed the Moderate finding in `docs/reviews/train-recovery/e0da4e3-r1.md`.
New transient readiness escalations save `resume_stage` before completion. A
retry or fresh handle restores that stage before normal recapture and settlement
checks. Only known record readiness refusals qualify; supersession, report
mismatches, unresolved review claims and replay conflicts retain their existing
refusal behavior.

For legacy completed refusals, captured review evidence and matching correction
dispatch journals select validate, rebase, ready, fix or dispatching as appropriate.
Recovery rechecks the immutable recorded report, project/lane identity, lane
state, supersession and record readiness. Validation also checks unresolved
blockers before launching a reviewer. Dispatch recovery keeps the exemption for
only its own existing correction run. The actual R-189 receipt was inspected
read-only: its completed `Another run is open: R-182` refusal has no review or
correction evidence and matches the legacy validate-stage recovery case.

The two primary cases were written first and reproduced the defect:

```sh
node --import ./test/helpers/fixture-policy.mjs --test --test-name-pattern='recovery: older' settle/test/record-recovery.test.mjs
```

Before implementation: **2 failed, 0 passed, 12 excluded by the name filter**.
Each failure returned the saved escalation after the older run was abandoned.

Focused validation after implementation:

```sh
node test/helpers/run.mjs settle/test/record-recovery.test.mjs
node test/helpers/run.mjs settle/test/recapture.test.mjs
```

**28 passed, 0 failed, 0 cancelled, 0 skipped** (14 per file). The new cases cover
fresh handles, legacy receipts after main advances, retained completed reviews,
fix and dispatch recovery, and identity/head/dirty-tree/report/supersession/blocker
guards. They prove one review after an older overlapping run clears, one correction
delivery when required, and no duplicates on repeated retry. The existing recapture
cases still cover explicit capped corrections, interrupted report intake, lost
review commits, terminal replay conflicts and dispatch recovery after main moves.
Syntax and diff whitespace checks passed. Test fixture process inspection and
cleanup required execution outside the filesystem sandbox; all transport/model
behavior was scripted and offline.

The inherited R-190 validation log was read and contains 148 passes and no failures;
that is historical evidence, not a fresh test claim. The earlier four train recovery
fixes and the previous report remain unchanged. No baseline, full project suite,
promotion suite, lane suite, release acceptance harness or live cycle mutation ran.
Promotion's combined-tree validation and fast-forward guarantees remain intact.

The required finishing sequence is this report's record check, its report commit,
then `node lanes/lane.mjs check` as the final action. This report makes no advance
claim about that final fast check; its result will be in `.lane/gate.json` and the
referenced validation log.
