---
run: R-245
outcome: done
summary: |
  The train atomically persists its current batch phase and the check command and start time before synchronous validation blocks. Completed gates retain their full finish, duration, exit and proof fields. Recovery checkpoints, interrupted batches, cached green evidence and cleanup crash recovery remain covered by unchanged existing assertions. Six new regressions cover live phases, a paused check, interrupted resumes, resumed validated checkpoints, red exits and validation exceptions. All 34 focused checks passed. Code, documentation and test evidence are committed in 62afedd. This report precedes its record check, report commit and final lane check.
headline: The merge train now records its running check and elapsed time.
blockers: []
proposals: []
learnings:
  - The receipt's batch phase shows current activity; attempt.phase remains the durable recovery checkpoint. Console readers should use batch phase and the latest attempt's gate for live check telemetry.
  - Revalidating a saved validated attempt must checkpoint prepared before replacing its completed gate with an unfinished clock; validated must always imply completed green evidence.
  - A reused green validation receipt retains its original clock and duration, while the batch started_at stays fixed across resumes.
artifacts:
  - "Commit 62afedd: feat: persist running merge train telemetry"
  - "Branch lane/train-telemetry"
  - "promote/train.mjs"
  - "promote/test/train.test.mjs"
  - "promote/README.md"
  - "docs/reports/evidence/R-245/train-green.tap"
  - "docs/reports/evidence/R-245/cleanup-green.tap"
  - "docs/reports/evidence/R-245/proof-green.tap"
decisions: []
questions: []
challenges: []
---

The `promotion-train/v1` receipt now writes batch `phase` before preparing,
rebasing, validating, fast-forwarding and closing work. The existing atomic
replacement helper saves every transition. Batch `started_at` is initialized
once and preserved on resume.

Before `validateTree` runs, the latest attempt's `gate` contains `command` and
`started_at`, with no exit or completion fields. Readers can calculate elapsed
time while the check runs. When validation returns, the complete existing gate
receipt replaces this clock, preserving `finished_at`, `duration_s`,
`exit_code`, signal, tree/head, environment fingerprint and log/hash evidence.
Cached green evidence keeps its original timestamps and `reused: true`.
Validation exceptions close the unfinished clock with finish, duration and
error fields; an unknown exit is not fabricated.

The display phase does not replace recovery checkpoints. A running check is
`prepared`, a fast-forward is `validated`, and post-integration bookkeeping is
`integrated`. A resumed validated attempt returns to `prepared` atomically
with the new unfinished clock. This preserves the invariant that a validated
checkpoint has completed green evidence. The existing lost-fast-forward
ancestry proof, stale replanning, main/lane guards and cleanup checkpoints stay
in place. Documentation describes these fields for the separately tracked
console work.

Final focused validation:

```sh
node test/helpers/run.mjs promote/test/train.test.mjs
node test/helpers/run.mjs --test-name-pattern='^(crash during batch cleanup|direct gate overlapping queued cleanup)' promote/test/promote.test.mjs
node test/helpers/run.mjs --test-name-pattern='^(queued integration records|batch rechecks current-run|a batch holds one shared)' settle/test/train.test.mjs
```

Results: **29 + 2 + 3 passed, zero failed or cancelled**. The train file retains
all 23 existing tests unchanged and adds six tests. Separate processes read
receipts at real Git boundaries and during a paused check. Resume tests prove
the prepared scratch candidate is reused, the batch start stays fixed, and
completed identical-tree evidence survives a second interrupted invocation.
Existing tests continue to prove interruption delivery, bisection, cached
gates, moving-main replanning, lost fast-forward adoption and cleanup crashes.
The three integration cases prove authorization rechecks and receipt verification.
Whitespace checks passed; the final TAP files are committed.

The two cleanup tests initially hit macOS `fs.watch` `EMFILE` inside the sandbox,
reproduced with one watcher on the workspace. The identical unchanged tests
passed with the required filesystem access. All fixtures use disposable Git
repositories and offline scripted transports.

The final action after this report is checked and committed is
`node lanes/lane.mjs check`. This report makes no advance claim about that
result; its evidence will be in `.lane/gate.json` and the referenced validation
log.
