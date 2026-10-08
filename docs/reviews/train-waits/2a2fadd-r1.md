**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: 2a2faddbca0110e878311e982d5de7c03c918709
Topic: train-waits
Round: 1
Review ID: lr-79a7a6afcdc36d4dd81538491fcec6e2
Base branch: main
Base commit: da07cc67d049f0bb44f02ffcf136c3b6c47b53d8

## Findings
- [Moderate] promote/metrics.mjs:46 - prepare\_time\_s adds a null entry for every attempt without a prepare object, but new train receipts legitimately keep such attempts when preparation never ran (prepareAttempt marks an attempt stale when main moves after rebase at promote/train.mjs:234 or after an earlier plan at :178, invalid when capture refuses at :241, or complete when every lane fails rebase replay), so a fully instrumented new batch that hit any of these paths reports batch and lane preparation as unknown even though every executed preparation interval was recorded; Fix: skip attempts that never entered validateAttempt (for example attempts in a receipt with external\_lock\_required defined whose phase is stale, invalid or complete and that have no gate, prepare or prepare\_history) instead of mapping them to null, and add a fixture with a stale or rebase-refused attempt beside a timed attempt asserting the known preparation total
- [Moderate] promote/metrics.mjs:45 - queue\_wait\_s is computed for legacy receipts because job.queued and plan.started\_at both predate this change, but legacy started\_at was the first train invocation, which for profiled trains came after the external-lock and host-slot waits, so old bch-cloak style batches report a numeric queue wait that silently includes lock and slot waits, contrary to the ask that older receipts without the new fields report the new splits as unknown; Fix: report queue\_wait\_s as null (or flag it) when the receipt lacks the new-semantics marker such as external\_lock\_required, or at minimum for receipts with a host\_receipt and no slot\_granted\_at, and add a legacy profiled-receipt fixture asserting queue wait is unknown and a limitations line describing it

## Re-executed
```json
[]
```

## Non-claims
- The supplied gate is inherited evidence; this review does not claim tests passed.
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.

## Unverified
- Test evidence not re-executed: test-slot/test/gate-profile.test.mjs
- The report claims seven gate-profile host reruns covering host-gate grant persistence and external-lock retry pairing; those tests are absent from the inherited validation log (32 tests from the four focused promote files only), so host-gate.mjs behaviour has no inherited execution evidence in this settle.
- Interaction with ENG-274 gate-watchdog changes to promote/train.mjs is not verified; lane/gate-watchdog is not an ancestor of main at the base commit, so the lane was rebased onto current main as asked but the eventual promotion rebase must re-check the overlapping train.mjs edits.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
