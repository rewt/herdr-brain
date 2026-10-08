# Bounded gate rebase

Run R-317 on ENG-267. Rebased `lane/bounded-gate` from `ba16c00d` onto local
main `071070fb1aaf8b0a4d5dd15cea8d89428b9d180c`; rebased implementation tip
`41f70f818e952b8c66f25ae657bf7b581d360178`.

The only conflict was in `promote/train.mjs`. The resolution retains main's
canonical-base planner and its trust-boundary comment, and passes this lane's
sorted, deduplicated union of bound required test files through that call.
`settle/test-plan.mjs` already forwards the options to `promotionTestPlan`, so
it needed no additional change.

`rebase-R-317-audit.log` records the main ancestry check, commit range comparison,
and byte-for-byte equality against the reviewed lane for the bounded planner,
duration inventory, promotion validator, settle evidence forwarding, affected
test regressions, and canonical planner tests. The three-argument compatibility
commit is unchanged apart from its rebased commit identity (`dabb681d`).
Main's two canonical planner trust regressions remain in the train suite.

Focused validation ran against the committed rebased tree:

```sh
node test/helpers/run.mjs promote/test/train.test.mjs promote/test/affected-tests.test.mjs settle/test/test-plan.test.mjs
```

`rebase-R-317-focused.log`: 44 passed, zero failures, cancellations or skips,
150.4 seconds, exit zero including the process-group cleanup audit. This covers
the resolved train call site, canonical planner trust, required-file union and
cap exceptions, bounded core and exact leaf selection, and legacy output shape.
No tests were changed for this round. No baseline, full promotion, release, lane
suite, or acceptance harness ran. The final `lane check` uses the default fast
tier after the report commit; its receipt is `.lane/gate.json`.
