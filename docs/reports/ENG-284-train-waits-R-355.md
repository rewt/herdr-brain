---
run: R-355
outcome: done
summary: |
  Rebased lane/train-waits onto main 1cc09185, resolving the host-gate conflict while retaining memory and fresh-batch STOP waits before the external lock and slot, bounded held memory rechecks and resumed checkpoint recovery. Wait instrumentation preserves actual external-lock and slot grant clocks alongside preparation and command clocks; watchdog limits, timeout outcomes and envelope sizing remain intact.
  All 263 requested focused tests passed plainly and all 263 passed inside an outer scratch slot, with no failures, cancellations or skips. The nested bootstrap verified both batch slot paths, wait variables, inherited tokens and held locks; both scratch locks were released. Rebased implementation is committed in 0d2681b4 and verification evidence in 522df23. This report is written and checked before its commit and the final focused fast-tier lane check, whose gate receipt records the final committed tree and result.
headline: The rebased wait metrics preserve memory and timeout safeguards and pass both focused test runs.
blockers: []
proposals: []
learnings:
  - Record the actual host slot grant before its bounded held memory recheck, so a subsequent memory refusal retains acquisition evidence without inventing preparation or gate execution.
artifacts:
  - "Branch: lane/train-waits"
  - "Rebase base: 1cc09185a440f9988a7530d2eb8cea39f45566d9"
  - "Rebased implementation and conflict resolution: 0d2681b439381cbb77d5f55d8092b7db01a9f788"
  - "Verification evidence commit: 522df23"
  - promote/host-gate.mjs
  - docs/reports/evidence/R-355/checks.mjs
  - docs/reports/evidence/R-355/source-checks.json
  - docs/reports/evidence/R-355/plain.json
  - docs/reports/evidence/R-355/plain.tap.gz
  - docs/reports/evidence/R-355/nested.json
  - docs/reports/evidence/R-355/nested.tap.gz
  - docs/reports/evidence/R-355/outer-wait.json
  - docs/reports/evidence/R-355/outer-execution.json
  - docs/reports/ENG-284-train-waits-R-355.md
  - /Users/rewt/development/rewt/.org/runs/R-355/report.md
  - ".lane/gate.json: final committed-tree fast-tier lane-check receipt"
decisions: []
questions: []
challenges: []
---

The sole rebase conflict was in `promote/host-gate.mjs`. The resolution combines
the external-lock acquisition timestamp with `execute(profile, memoryOptions)`
and records the actual slot grant before the existing held memory recheck.
Fresh batches retain early STOP refusal; resumed batches retain memory waits
and reach the train's existing STOP reconciliation. The held rechecks retain
their five-second bound and coded `PROMOTION_MEMORY_PRESSURE` refusal.

Source comparisons verified that the train timeout branch, host limits/history
key and complete bisection envelope, and `promote/memory-gate.mjs` match main
exactly. Validation slot grants remain under `lane-validation/slot-waits/`.
The grant writer still publishes only after acquisition. No tests were edited.

Both focused runs executed these complete files, including the memory-before-locks
and profiled STOP recovery coverage from the landed work:

```sh
node --test test-slot/test/watchdog.test.mjs test-slot/test/test-slot.test.mjs test-slot/test/gate-profile.test.mjs test/memory.test.mjs promote/test/*.test.mjs
```

Plain: 263 passed, zero failed/cancelled/skipped; 235.968 seconds.
Nested: 263 passed, zero failed/cancelled/skipped; 227.986 seconds.

The retained driver scrubs live record/session and slot identity, pins fleet and
watchdog history to scratch, and loads the absolute native-memory fixture.
The nested wrapper has a private project common directory, separate private
workspace and legacy slot paths, both 600-second wait variables, a 1800-second
wall envelope, disabled idle timeout and no retry. Its bootstrap verifies both
tokens and lock records before the test command. The outer execution receipt
reports exit zero and no timeout. Neither run reported a test-origin history
leak; shared-history diagnostics named other origins. Host execution supports
the offline socket, PTY and process-group fixtures. Main remained `1cc09185`.
`git diff --check` passed. No host test slot, npm test, promotion/release tier,
live acceptance harness, model call or promotion ran.

After report validation and commit, the final operation is a focused
`lane check --tier fast --cmd` covering the three original lane/queue/fast
watchdog timeout cases, the three timeout/timing cases, unconfigured train
timing, fresh/resumed profiled STOP and the three held memory-pressure stages.
The check uses scratch fleet/history/slot paths and the memory preload. Its
outer fast validation takes no host slot; `.lane/gate.json` records the final
report commit and result. Then this run stops.
