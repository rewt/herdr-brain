---
run: R-340
outcome: done
summary: |
  Fixed both review findings: instrumented attempts that never prepared contribute zero with an explicit reason, including lanes whose jobs were removed during rebase refusal; legacy receipts now leave queue wait unknown even when queued and started_at clocks exist.
  The correction is committed in ccc5912c. All five requested files passed on the lane (50 tests) and with the pending watchdog changes in a disposable integration checkout (54 tests). Rebased onto current local main da07cc67; the watchdog has not landed there yet. Its overlapping conflicts were resolved and tested separately, with the resolution retained for the eventual promotion rebase.
  This checked report is committed before the final focused fast lane check. The final gate receipt records the report commit and actual validation result.
headline: Train metrics now distinguish skipped preparation from unknown legacy waits.
blockers: []
proposals: []
learnings:
  - All-replay-refused attempts retain no jobs, so per-lane metrics must also handle an empty attempt selection as known zero preparation in instrumented receipts.
  - The external_lock_required boolean identifies receipts with pre-resource-wait batch start semantics; legacy started_at plus queued clocks cannot prove queue-only wait.
  - Watchdog integration must preserve its validation history key, limits and timeout outcome while adding the slot wait receipt and embedded command clocks; copy slot grants before handling timeout outcomes.
artifacts:
  - "Correction commit: ccc5912c5c0ca1982ca3f8687f7823543308e29b"
  - "Branch: lane/train-waits"
  - promote/metrics.mjs
  - promote/test/metrics.test.mjs
  - promote/test/wait-timing.test.mjs
  - promote/README.md
  - docs/reports/evidence/R-340/watchdog-overlap.patch
  - docs/reports/ENG-284-train-waits-R-340.md
  - /Users/rewt/development/rewt/.org/runs/R-340/report.md
  - ".lane/gate.json: final focused fast lane-check receipt, written by the final command"
decisions: []
questions: []
challenges:
  - "Current local main remains da07cc67 and does not contain ENG-274. Its promotion batch b47d8ed8-bc9a-478e-9612-4874aeaefd6c was still validating. Verified the combined code separately against lane/gate-watchdog at 45da1bc0; the eventual rebase after it lands will conflict in lanes/validation.mjs and promote/train.mjs. The retained patch supplies the tested resolution against that watchdog commit."
---

The metrics use `external_lock_required` as the new-receipt marker. Queue wait
is unknown without it because legacy profiled batches started their clock after
the external-lock and slot waits. The legacy-profile fixture includes queued
clocks and a host receipt, and verifies batch, lane, summary and text behavior.

New stale, invalid and complete attempts without preparation or gate evidence
contribute zero preparation. `timing.prepare_skipped` records their attempt
index and reason, also shown in text. No retained lane attempts similarly means
zero preparation with a reason. Executed, unfinished, reversed and legacy
preparation evidence keeps its existing unknown semantics. Regression fixtures
cover both stale reasons, capture refusal and all-replay refusal beside a timed
attempt. A real train fixture verifies complete rebase refusal and empty lane
membership. Gate or preparation history prevents an incorrect skipped result.

Validation before reporting:

- `node --test test-slot/test/gate-profile.test.mjs promote/test/metrics.test.mjs promote/test/metrics-profile.test.mjs promote/test/wait-timing.test.mjs promote/test/conformance.test.mjs`: 50 passed, zero failed/skipped on the lane.
- The same five files on a disposable checkout of watchdog commit `45da1bc0`, with the original train-waits implementation and this correction applied: 54 passed, zero failed/skipped. Retained watchdog timeout/history handling together with slot grant recovery and command clocks in both conflicts. The disposable checkout was removed after preserving the overlap patch.
- `git diff --check` passed. Final `git rebase main` was clean and up to date at `da07cc67`.

Host-capability fixture checks used approved execution outside the sandbox,
disposable repositories, private slots/locks, localhost sockets and PTYs. No
host test slot, project-wide suite, promotion/release tier or live acceptance
harness was used.

After checking and committing this report, the final command is:

```sh
node lanes/lane.mjs check --cmd 'node --test test-slot/test/gate-profile.test.mjs promote/test/metrics.test.mjs promote/test/metrics-profile.test.mjs promote/test/wait-timing.test.mjs promote/test/conformance.test.mjs'
```

This is a fast-tier lane check with a focused command; the outer check takes no
host test slot. Its receipt supplies validation against the final report commit.
