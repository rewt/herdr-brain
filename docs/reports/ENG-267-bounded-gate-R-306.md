---
run: R-306
outcome: done
summary: |
  Bounded promotion extras to changed tests and release tests with direct references to changed modules, with a recorded 300-second estimated budget and ten-file ceiling. Receipts retain selected and deferred files, reasons, duration provenance and required-test exceptions.
  Bound required test evidence bypasses both caps. Settle forwards scoped requirements, and the train plans their union using the canonical base planner while retaining the strict coverage check.
  All 54 focused offline tests passed; two further canonical-planner tests passed after the implementation commit. Replanning the problem batch selects five extras instead of 88, estimated at 263 seconds, with two deferred to release validation. Implementation and evidence are committed as ce73a12; this checked report is committed next, followed by the final lane fast check.
headline: Merge gates now cap extra tests while preserving required evidence
blockers: []
proposals: []
learnings:
  - The latest tracked whole-file duration inventory is docs/reports/ENG-135-suite-pass-evidence-20261003/measurements.json; its after inventory measures lanes/test/lane.test.mjs at 342215 milliseconds, already beyond a five-minute allowance.
  - Canonical planner tests materialize Git HEAD, so testing again after the implementation commit is necessary to verify the new planner and its data assets.
artifacts:
  - 'Implementation commit: ce73a12'
  - 'Branch: lane/bounded-gate'
  - docs/evidence/ENG-267/README.md
  - docs/evidence/ENG-267/planner.log
  - docs/evidence/ENG-267/focused.log
  - docs/evidence/ENG-267/committed-canonical.log
  - docs/evidence/ENG-267/batch-replan.json
  - test/helpers/test-durations.json
  - docs/reports/ENG-267-bounded-gate-R-306.md
  - /Users/rewt/development/rewt/.org/runs/R-306/report.md
  - '.lane/gate.json (final lane fast-check receipt)'
decisions:
  - text: Cap optional extras at an estimated 300000 milliseconds and ten files, prefer changed tests and then cheaper direct references, and record the remainder for the candidate's complete offline validation.
    category: design
    why: Cheap merge regression coverage must not expand into the complete offline suite; measured per-file cost and a conservative fallback bound selection without altering existing execution deadlines.
  - text: Pass scoped required evidence to both planners before selection and run it even when it exceeds the extra-test caps.
    category: prover
    why: Bound escalations must remain closable only through actual whole-file coverage; the train still refuses a planner that omits required evidence.
  - text: Use the existing canonical-base planner materialization in the train as well as settle.
    category: prover
    why: This lane starts before the queued planner-integrity change; preserving that binding prevents candidate planner edits from shrinking required coverage.
questions: []
challenges: []
---

Focused validation: `node test/helpers/run.mjs promote/test/affected-tests.test.mjs promote/test/train.test.mjs settle/test/test-plan.test.mjs settle/test/test-evidence.test.mjs` passed 54/54 in 114.2 seconds, with no failures, cancellations or skips. After committing, `node --test settle/test/test-plan.test.mjs` passed 2/2 using the committed snapshot and symlinked temporary-directory checks. The direct planner file also passed 7/7.

The batch comparison uses the original changed-path list against this lane's current tree and performs planning only. It selected five files at 263141 estimated milliseconds and deferred two with time-budget reasons; it did not execute, mutate or interrupt the running batch.

Duration estimates are the latest tracked per-file measurements, with timestamps and source provenance. Unmeasured files cost 60000 milliseconds. These are selection estimates, so machine load and changed test behavior can exceed them; the ten-file cap and existing runner deadlines also remain in force. The full offline release suites remain the candidate's final validation.

No baseline, full promotion suite, full lane suite, release suite, acceptance harness or housekeeping loop ran. Tests remain offline and use scratch fleet and slot identities. No push, release or live pane mutation occurred.
