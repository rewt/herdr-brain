---
run: R-108
outcome: done
summary: |
  Resolved the independent review finding. Conditional record completion now checks the existing closure history against the run's report-ingestion sequence under the record lock. Duplicate promotion queue and final report notices refuse to close explicitly reopened work, including with older promotion receipts and an unchanged done report.
  Expanded the real queue recovery, conditional record completion and full scripted supervisor acceptance cases. Ordinary duplicate completion stays idempotent, newer-run and integration guards remain enforced, and a newer run's report can complete reopened work. All 14 supervisor tests and the full host npm suite pass.
  Current main remains an ancestor of the lane. The read-only repository cold start is approximately 1485 tokens; its run and item bindings match the record. The checked report is committed separately, followed by the required final lane check.
headline: Duplicate completion notices now preserve explicitly reopened work
blockers: []
proposals: []
learnings:
  - Reopening clears item closure and outcome but retains the old run and its immutable done report; current-run and ready-status checks alone cannot distinguish replay from renewed completion.
  - Existing item.closed events after a run's report-ingestion sequence durably bind that report to its prior completion. Checking them inside the close transaction protects old receipts without adding fields or stored status.
  - Settle's reopening before the first closure must remain permitted. A newer report can complete reopened work because its ingestion follows the earlier closure; an explicit unconditional close remains available for a fresh supervisor judgment.
artifacts:
  - "Commit: Preserve reopened work against promotion completion replays"
  - "Commit: Report completion replay correction for run R-108"
  - bin/org.mjs
  - supervisor/test/supervisor.test.mjs
  - acceptance/supervisor.mjs
  - supervisor/README.md
  - supervisor/PROTOCOL.md
  - docs/reports/evidence/ENG-94-supervisor/R-108-validation.json
  - docs/reports/evidence/ENG-94-supervisor/R-108-cold-start.txt
  - "Validation: npm test before and after the change; all 14 supervisor tests; focused scratch-cleanup rerun; record check this report; final lane check after the report commit"
decisions:
  - text: Guard conditional completion with the existing closure events and immutable report-ingestion sequence, inside the record transaction.
    category: design
    why: A supervisor precheck or mutable receipt marker could race with reopening or miss older receipts. The record lock already serializes reopening and completion, and the log already contains the durable evidence.
  - text: Reject completion replay after reopening and retain the existing supervisor judgment handoff.
    category: design
    why: The later reopening must survive duplicate queue and final-report notices. An ordinary duplicate while still closed stays idempotent; renewed work can finish with a newer report or an explicitly judged unconditional close.
  - text: Run the full offline post-change suite and final gate outside the outer sandbox.
    category: tooling
    why: The macOS tests establish their own native sandbox boundaries, which the outer sandbox refused. Host execution permits those fixtures without invoking a model or live worker.
questions: []
challenges:
  - An additional host baseline hit one existing ENOTEMPTY detached-watcher cleanup hook race. Its focused rerun and the complete post-change host suite passed; no fixture or lifecycle safety checks were changed.
  - The nested post-change suite had 19 macOS sandbox fixture setup failures with sandbox_apply Operation not permitted. The complete host rerun passed with 611 tests passed, 11 explicitly skipped and zero failures or cancellations.
  - Live model behavior, actual operator chat clearing, the full release harness, bch-cloak cutover, the optional full lane suite and new filesystem-isolation proof are not claimed.
---

The sole finding in the review of the previous run is resolved. Its inherited
validation log has zero failures. Previous reports remain intact.

Both targeted regression cases reproduced the defect before the source change:
the late report handler and direct conditional close returned success after
explicit reopening. The fix reads the complete event history inside the same
transaction that verifies the current run and writes closure. A prior closure
after that run's report ingestion prevents another conditional close when the
item has been reopened. No receipt migration, new event type, stored status,
dependency or supervisor event-log writer is needed.

The recovery regression promotes through the real queue, removes the lane and
finishes the record, then explicitly reopens it while retaining the same run and
done report. Two rounds of queue notices, final report notices and direct run-ID
handling now return the reopening handoff and leave the item ready and open.
They append no events and create no transport calls or promotion jobs. Existing
receipt-binding, integrated-head and superseding-run refusal cases remain green.
The conditional-record regression also proves ordinary duplicate closure stays
idempotent and that a newer report can close explicitly reopened work.

The full acceptance case uses real discovery entry, record, watch, settlement,
review records, correction dispatch, queue validation, fast-forward and lane
removal with scripted transport. It repeats the queue, correction and original
report notices after reopening. The current completion refuses, the original
run reports supersession, and neither overrides the later reopening decision.

Validation evidence:

- Required baseline npm test before the source change passed 611 tests, with
  11 skips and zero failures.
- Both targeted regression reproductions failed before the fix.
- All 14 supervisor tests passed after the fix, including the full acceptance
  case; no tests were skipped in that focused suite.
- Final post-change host npm test passed 611 tests, with 11 explicit skips,
  zero failures and zero cancellations.
- The additional baseline cleanup failure passed on focused rerun; nested
  macOS fixture refusals passed in the complete host rerun.
- Current main remains an ancestor of this lane, so no rebase was needed.

The saved read-only cold start through event sequence 1284 has 5937 characters,
approximately 1485 tokens using ceil(characters/4). It shows four recorded
running runs, 23 report rows, one operator question and 384 decisions in JSON.
The displayed running and report rows' run/item bindings match the event fold
through that sequence. No shared record event or checkpoint was written.

The implementation is committed under the subject cited above. This report is
checked at the requested run path and committed separately with its evidence.
The final lane check follows that commit; its exact HEAD, validation command and
result are retained in local .lane/gate.json for settlement. No model, live pane,
shared configuration, active release, push or publication was used.
