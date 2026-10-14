**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: d7bfe7214a6eebd5eb0eb19abeb5a61e072d323f
Topic: reconcile-delta-refresh
Round: 1
Review ID: lr-7f62ced80e2f45f47dc7c107ea2c0b40
Base branch: main
Base commit: 0cd14bcad10df9c613c41c1461b883cca1c52e43

## Findings
- [Moderate] lib/completion.mjs:83 - With new receipts that carry prepared\_seq, completionDelta lists every member whose signature changed at any point after preparation, even when the current signature equals the prepared one, so a change made and then reverted before finish (a question asked and answered, an auto-category ask that is added and closed in one transaction, or a link added then removed) yields an acceptance-relevant delta that finish refuses and refresh can never accept; at the base commit, and still for older receipts through the early matches(state) return, the same finish succeeds, so this regresses into exactly the new-batch-only recovery the task set out to remove; Fix: only treat an entry as changed (and refuse) when its current signature differs from its signature at the preparation boundary, keeping the per-event listing for explanation, and add a regression test where a question on a member is asked and answered (or a link added and removed) after prepare and the original finish still reconciles

## Re-executed
```json
[]
```

## Non-claims
- The supplied gate is inherited evidence; this review does not claim tests passed.
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.

## Unverified
- Test evidence not re-executed: supervisor/test/reconcile.test.mjs
- Test evidence not re-executed: promote/test/completion.test.mjs
- Runtime cost of the older-receipt historical rescan on a large production record was assessed by reading only; no timing was measured against the 30 second complete-batch spawn timeout.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
