---
run: R-338
outcome: done
summary: |
  Added durable slot and external-lock grant clocks, per-attempt preparation intervals, and embedded gate command clocks. Metrics now report queue, slot, external-lock, preparation and gate durations per batch and lane, preserving unknown values for missing evidence and retaining the v1 schemas.
  Focused offline fixture, conformance and host-adapter checks passed. The implementation is committed in 25255230 and rebased onto current main da07cc67. This checked report is committed before the final focused fast lane check; its gate receipt supplies the final validation result.
headline: Train metrics now separate queue and resource waits from preparation and gate execution.
blockers: []
proposals: []
learnings:
  - Profiled trains acquire the external lock and host slot before runTrain; batch start must be recorded before invoking the host adapter to measure those waits.
  - Unconfigured train validation durations include slot waiting; command execution clocks provide gate time without that wait.
  - Slot wait from batch start to first grant overlaps external-lock wait and unconfigured preparation; shared batch preparation and gate costs must not be summed across lane rows.
artifacts:
  - "Implementation commit: 25255230"
  - "Branch: lane/train-waits"
  - promote/metrics.mjs
  - promote/train.mjs
  - promote/host-gate.mjs
  - promote/test/wait-timing.test.mjs
  - docs/reports/ENG-284-train-waits-R-338.md
  - /Users/rewt/development/rewt/.org/runs/R-338/report.md
  - ".lane/gate.json: final focused fast lane-check receipt, written by the final command"
decisions: []
questions: []
challenges:
  - "Rebased onto current local main da07cc67 before reporting. ENG-274 remains on lane/gate-watchdog and is not yet in main; a later promotion rebase must include it once it lands."
---

The queue saves `started_at` when creating a batch receipt, before host waits.
The host adapter saves `slot_granted_at`, `external_lock_required`, and applicable
external-lock start/grant timestamps before starting the train child. First
successful grants survive resumes; a capped external-lock retry pairs the grant
with that successful invocation's wait start, excluding idle time after a cap.
Slot wait receipts add `acquired_at` while retaining `finished_at`.

Attempts retain `prepare.started_at` and `prepare.finished_at` around commands
and test planning, including failed preparation. Earlier resumed intervals move
to `prepare_history`. Validation retains a durable slot sidecar and embeds
`command_started_at` / `command_finished_at` in completed gate evidence. An
unconfigured train copies the grant after validation and recovers it from retained
sidecars before replacing gate evidence after a lost caller response.

`train-metrics/v1` adds `batches[].timing`, `lanes[].timing`, per-gate
`command_time_s`, and `summary.phase_time_s`. Each timing row has
`queue_wait_s`, `slot_wait_s`, `external_lock_wait_s`, `prepare_time_s`, and
`gate_time_s`. Batch queue wait is the oldest member wait; each lane uses its own
queued timestamp. Preparation and executed gate costs follow attempt membership,
including bisection and resume history. Reused and duplicate proofs do not add
gate execution time. Shared costs appear in full for each participating lane.

Missing, reversed and unfinished intervals produce null / unknown, and incomplete
totals remain unknown. A known absent external lock has null timing and
`external_lock_required: false`; legacy applicability is unknown. Existing gate
summary fields retain their original measurement semantics; new gate phase time
uses actual command clocks to exclude waits. All schemas remain v1 because the
changes are additive. No older clocks are backfilled.

Validation completed before the report:

- `node --test promote/test/metrics.test.mjs promote/test/metrics-profile.test.mjs promote/test/wait-timing.test.mjs`: 20 passed, including exact timestamp splits, old receipt unknowns, bisection totals, failed preparation, command-clock durability and resume grant recovery (the last recovery correction also passed all three timing tests separately).
- `node --test promote/test/wait-timing.test.mjs promote/test/conformance.test.mjs`: 15 passed, covering commit/tree guards, immutable execution evidence and resume history.
- Seven focused tests in `test-slot/test/gate-profile.test.mjs` passed across host reruns: ordinary profile, released external lock, live slot wait, capped slot, external-lock retry, queue slot cap, and capped integration recovery. New assertions check grant persistence, preparation ordering and retry clock pairing. The initial sandbox run failed its socket/PTY capability probe; approved host reruns used only disposable repositories and private slot/kernel-lock paths.
- `git diff --check` passed; `git rebase main` was clean and up to date.

No project-wide tests, promotion/release tiers, live acceptance harness, or host
test slot were used. The final command after the checked report commit is:

```sh
node lanes/lane.mjs check --cmd 'node --test promote/test/metrics.test.mjs promote/test/metrics-profile.test.mjs promote/test/wait-timing.test.mjs promote/test/conformance.test.mjs'
```

This is a fast-tier check of the focused files. Its fixtures use private slot
paths; the outer lane check takes no test slot. The final gate receipt records
the validated report commit and actual exit code.
