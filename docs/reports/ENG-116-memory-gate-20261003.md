---
run: R-150
outcome: done
summary: |
  Added dependency-free macOS and Linux memory measurements and pressure gates for dispatch, settle reviews, direct and queued promotions, and release. Waiting work retains its request or review stage and proceeds when pressure clears; release defers without cutting a candidate. Supervisor cold starts show memory reasons and the largest memory and CPU consumers with PID, parent PID and command evidence.
  Offline pressure regressions, fast validation and the lane suite passed. The complete npm test retry passed after the first after-change run encountered two fixture cleanup errors. Implementation is committed; this report is checked and committed before the final lane check.
headline: The cycle waits for memory pressure to clear and shows the largest process consumers
blockers: []
proposals: []
learnings:
  - Current swap use is measured, not cumulative swap-in or swap-out counters. Any nonzero swap use intentionally defers work, including cold swap, until the machine clears it.
  - Linux uses MemAvailable; macOS uses the reported page size and free, inactive and speculative pages without double counting purgeable pages.
  - Unavailable native measurements produce visible advisories. Unknown swap alone does not refuse work; macOS retains its available-page measurement when only the swap probe fails.
artifacts:
  - "Commit 6fa6e07480052f8616e2e2ddc791469d47ec3d42: Gate cycle work on host memory pressure and expose process usage"
  - "Branch lane/memory-gate"
  - "lib/memory.mjs"
  - "docs/reference/memory-gate.md"
  - "docs/reports/ENG-116-memory-gate-20261003.md"
  - "npm run test:fast: 140 passed; /tmp/R-150-fast.log"
  - "Touched offline suites: 107 passed; /tmp/R-150-touched.log"
  - "npm run test:lanes: 160 passed; /tmp/R-150-lanes.log"
  - "npm test, complete isolated lane retry: 861 passed, 11 skipped, zero failures; /tmp/R-150-after-alone.log"
  - "First after-change npm test evidence: /tmp/R-150-after.log"
  - "Final command after the report commit: node lanes/lane.mjs check; receipt .lane/gate.json"
decisions:
  - text: Defer for current swap use or available memory below the larger of 256 MiB and five percent of physical RAM, polling foreground waits every five seconds.
    category: design
    why: This supplies a deterministic default without project configuration and delays work without a refusal budget. The finite one-shot command retains its existing deferred-result protocol.
questions: []
challenges:
  - The first after-change complete test run failed only in two cleanup hooks with ENOTEMPTY while removing temporary plugin-install and promotion fixture directories. All touched suites had passed. One complete retry with no other test suite running in this lane passed, including both affected cases; no unrelated fixture or host-test-slot implementation was added.
---

The initial `npm test` invocation started before implementation and completed
successfully. After the change, the complete successful retry covered the copied
entry phase (2 passed), core/modules (706 passed, 11 skipped) and
settle/supervisor/release (153 passed).

Acceptance evidence includes a dispatch that waits before opening its lane under
simulated swap pressure, a queued promotion that waits before validation under
simulated low available memory, and a settle review that remains in its review
stage and launches exactly once after pressure clears. Release pressure tests
create no candidate, tag or gate receipt while deferred and proceed after clearing.
Native parser and process-ranking tests simulate both operating systems without
allocating pressure or calling a model.

Promotion waits again before fast-forward, then runs its existing fresh ref,
cleanliness and record guards. Host process diagnostics are read-only and do not
authorize process termination or infer work status. No live acceptance harness,
project-wide housekeeping loop, push or model call was run. ENG-118 remains the
parallel host-test-slot work.

Per the brief, the final lane check follows this report's check and commit; its
result is retained in the lane receipt rather than claimed ahead of execution.
