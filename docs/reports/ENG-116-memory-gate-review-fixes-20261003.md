---
run: R-155
outcome: done
summary: |
  Resolved all four memory-gate review findings. Dispatch honors canonical supervisor STOP during both memory waits and returns a resumable stopped result, which settle preserves as its existing correction handoff. Idle stale swap no longer blocks work, failed macOS available-memory probes remain advisory, and promotion finishes its fast-forward without a second memory wait under the promotion lock.
  Offline validation passed before and after the changes. The fix is committed; this report is checked and committed before the final lane check, whose receipt records its result.
headline: Memory waits honor supervisor stops and no longer stall on idle swap
blockers: []
proposals: []
learnings:
  - Swap use of at least five percent of physical RAM defers work only when available memory is below twenty-five percent of RAM. The independent low-memory threshold remains the larger of 256 MiB and five percent of RAM.
  - A failed or malformed macOS vm_stat probe leaves available memory unknown. Raw os.freemem excludes reclaimable cache and must not establish macOS pressure in this fallback.
  - Dispatch checks STOP in the canonical checkout before each memory sample and after a clearing sample. Its open or worker stage and request journal remain resumable after STOP clears.
  - Settle captures nested dispatch stderr. Its offline STOP regression uses an adapter log to observe an actual pressure wait before placing STOP.
artifacts:
  - "Commit f46d0ca7bbcd886ca18101f4a73b418767bb9b88: Honor supervisor stops and avoid stale memory pressure waits"
  - "Branch lane/memory-gate"
  - "docs/reference/memory-gate.md"
  - "docs/reports/ENG-116-memory-gate-review-fixes-20261003.md"
  - "npm test before edits: 861 passed, 11 skipped, zero failures"
  - "npm run test:fast: 140 passed; /tmp/R-155-fast.log"
  - "npm run test:lanes successful retry: 161 passed; /tmp/R-155-lanes-retry.log"
  - "npm test after edits: 865 passed, 11 skipped, zero failures; /tmp/R-155-after.log"
  - "Focused correction STOP regression: passed; /tmp/R-155-stop-regression.log"
  - "Initial focused validation and test-observation corrections: /tmp/R-155-focused.log and /tmp/R-155-settle-retry.log"
  - "Initial lane validation timeout evidence: /tmp/R-155-lanes.log"
  - "Final command after the report commit: node lanes/lane.mjs check; receipt .lane/gate.json"
decisions:
  - text: Require substantial swap together with scarce available RAM to defer work, while retaining the separate low-memory check.
    category: design
    why: Cold swapped pages and swap files can linger after pressure clears. Work must resume on a recovered host without waiting for every old swap page to disappear.
  - text: Return a resumable stopped dispatch receipt under supervisor STOP and gate lane promotion only before acquiring the promotion lock.
    category: tooling
    why: STOP must prevent delayed worker launches. The expensive validation remains gated, while unrelated memory pressure cannot strand a validated fast-forward and queued promotions under the project lock.
questions: []
challenges:
  - The first lane suite exceeded its file and suite deadlines and reported an EPERM fixture cleanup refusal. Its new promotion pressure regression passed. One full retry passed all 161 tests; no unrelated fixture implementation was changed.
---

The four findings from review round 1 are addressed:

- Dispatch supplies STOP callbacks to both memory waits and resolves STOP against
  the canonical Git checkout. Offline tests place STOP during each pressure wait,
  assert no worker launch or prompt, check that the request lock is released, and
  resume the same request after clearing STOP. The open-stage test also confirms
  no lane was opened. A settle integration test confirms a stopped correction
  handoff and exactly one correction run after retry.
- The shared memory policy accepts idle stale swap with ample available RAM.
  Unit tests cover small and substantial cold swap, the combined pressure
  thresholds, and clearing a wait while some swap remains. Dispatch and release
  regressions also proceed with stale swap still allocated.
- Promotion waits before acquiring the lock. Its offline regression confirms
  that initial pressure leaves the lock free and validation unstarted, then
  raises pressure during validation and verifies successful integration and
  lock release. Existing freshness, cleanliness, validation and record guards
  still run before fast-forward.
- Failed and malformed macOS vm_stat fixtures produce unknown available memory
  and a visible advisory without calling raw freemem or waiting. A swap-only
  probe failure still retains measured available pages.

The complete after-change log includes both copied-entry tests, 709 passing
core/module tests with 11 explicit skips, and 154 passing settle/supervisor/release
tests. This supplies full validation evidence beyond the truncated inherited log.
All validation was offline with simulated measurements and scripted transport;
no model calls, live acceptance harness, project-wide housekeeping, promotion or
push were performed. The host-test-slot work remains outside this change.

The final lane check follows this report's check and commit. Its result is retained
in the lane receipt rather than claimed ahead of execution.
