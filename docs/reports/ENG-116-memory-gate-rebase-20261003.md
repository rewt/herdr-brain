---
run: R-172
outcome: done
summary: |
  Rebased the accepted memory-gate lane onto main and resolved dispatch and release conflicts without adding features. Dispatch retains STOP-aware memory waits and visible reasons while deferring workspace creation for main's one-tab launch. Release retains memory preflight, the host test slot and retryable setup preflight; lane promotion merged cleanly.
  Existing offline dispatch and release suites passed all 51 tests, and 12 focused lane integration regressions passed. The rebase commits contain the resolutions. This report is checked and committed before the final fast lane check, whose result is retained in the lane receipt.
headline: The rebased memory gate preserves one-tab dispatch and the host test slot
blockers: []
proposals: []
learnings:
  - Coordinated dispatch must open the Git worktree with --git-only after its STOP-aware memory wait so native lane dispatch can reuse the newly created workspace's initial pane.
  - Release samples memory before acquiring the host test slot and again under the project promotion lock; main's retryable setup preflight remains before candidate creation.
artifacts:
  - "Branch lane/memory-gate rebased onto main 61be51b51911b1b713434071d5989585c40b5ecc"
  - "Rebased implementation commit 5577785: Gate cycle work on host memory pressure and expose process usage; dispatch and release conflict resolutions"
  - "Rebased fix commit 1cf8c01: Honor supervisor stops and avoid stale memory pressure waits; STOP-aware dispatch conflict resolution"
  - "Rebased tip before report: 41c58893dd57fd8bcb733a282f9c7424388ce933"
  - "dispatch/dispatch.mjs; release/release.mjs; lanes/lane.mjs"
  - "/private/tmp/R-172-conflicted-tests.log: 51 passed, zero failures"
  - "/private/tmp/R-172-lane-integration-tests.log: 12 passed, zero failures, 146 intentionally skipped by name filter"
  - "git range-diff 31ed0c3..14767d3 main..HEAD: only the intended conflict resolutions alter the accepted patch series"
  - "git diff --check main..HEAD and git merge-base --is-ancestor main HEAD: passed"
decisions: []
questions: []
challenges: []
---

Rebase round only. The accepted review fixes remain in the rebased history. The
actual conflicts were in `dispatch/dispatch.mjs` and `release/release.mjs`;
`lanes/lane.mjs` merged without a conflict.

The dispatch resolution combines `waitForMemory({ label: 'dispatch', check:
checkStop })` with main's `lane open --git-only`. The worker-stage wait,
coordinated `--memory-checked` launch, stopped request recovery and visible
diagnostics remain intact. Native lane dispatch retains main's initial-pane
reuse and private environment verification.

The release resolution keeps both the test-slot and memory imports. Memory
deferral remains before slot acquisition, while slot acquisition still precedes
candidate creation and claiming. Main's setup preflight and once-only gate
semantics remain intact.

Validation used only existing offline tests:

```sh
node test/helpers/run.mjs dispatch/test/dispatch.test.mjs release/test/release.test.mjs

NODE_OPTIONS="--import=$PWD/test/helpers/fixture-policy.mjs" node --test \
  --test-concurrency=1 \
  --test-name-pattern='promote waits|promote rebases|dispatch opens a single|dispatch leaves earlier|dispatch retains initial|dispatch refreshes|open creates|promotion checks in different|compatible holder|dispatch child boundary|direct lane dispatch' \
  lanes/test/lane.test.mjs lanes/test/validation.test.mjs \
  settle/test/memory-boundaries.test.mjs
```

The targeted tests cover pressure clearing, canonical STOP at both coordinated
dispatch waits and the real child boundary, visible direct-lane waits, promotion
fast-forward, one-tab dispatch and failure preservation, nested test slots, slot
contention, and release setup preflight. No baseline, full project suite, model
call or live acceptance harness was run.

The final `node lanes/lane.mjs check` follows the report check and commit. It uses
the configured fast tier; its result belongs in `.lane/gate.json` and the Git
common-directory validation receipt rather than being claimed before execution.
