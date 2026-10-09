---
run: R-354
outcome: done
summary: |
  Corrected the watchdog regression by moving validation slot grant sidecars into lane-validation/slot-waits/, so existing receipt readers select the actual gate receipt. The train timeout-result branch and host envelope sizing already matched main exactly; wait instrumentation remains additive. Added wall/idle singleton and wall multi-lane regression cases proving timeout outcomes, correction reasons, no bisection, unchanged main and retained wait metrics.
  All 239 requested focused tests passed both plainly and inside an outer scratch slot with the batch slot paths and both inherited tokens verified. Main remained ef21d58e, already the lane's rebase base. The correction is committed in bb5deffe3e5742d2320fc876c34d7438cf94672f. This checked report and evidence are committed before the final fast-tier lane check; its .lane/gate.json records the final committed head and result.
headline: The timeout regression is fixed and both focused test runs pass.
blockers: []
proposals: []
learnings:
  - Validation slot grant sidecars must remain outside the top-level lane-validation JSON receipt namespace; existing readers exclude watchdog execution sidecars but otherwise treat JSON files as validation receipts.
artifacts:
  - "Correction commit: bb5deffe3e5742d2320fc876c34d7438cf94672f"
  - "Branch: lane/train-waits"
  - "Rebase base: ef21d58ed7441cf6c7a0c90f66cd2abb5e08ddca"
  - lanes/validation.mjs
  - promote/test/wait-timing.test.mjs
  - promote/README.md
  - docs/reports/evidence/R-354/repro.tap.gz
  - docs/reports/evidence/R-354/plain.tap.gz
  - docs/reports/evidence/R-354/nested.tap.gz
  - docs/reports/evidence/R-354/outer-wait.json
  - docs/reports/evidence/R-354/outer-execution.json
  - docs/reports/ENG-284-train-waits-R-354.md
  - /Users/rewt/development/rewt/.org/runs/R-354/report.md
  - ".lane/gate.json: final fast-tier timeout and timing lane-check receipt"
decisions: []
questions: []
challenges:
  - "The handoff attributed watchdog.test.mjs:142's undefined outcome to a dropped train per-job timeout path. The unchanged test reproduces that failure before this correction, but line 142 inspects a direct lane validation receipt. The new .log.slot.json sidecar sorts before the gate receipt and is selected by its existing enumeration. The train timeout branch and host envelope region compare byte-for-byte equal to main; the regression is the additional file in the receipt namespace."
---

The fix preserves the existing watchdog test unchanged. Each promotion execution
still records an immutable slot grant sidecar, now under
`lane-validation/slot-waits/<execution-log-basename>.json`. Gate receipts retain
`slot_receipt`; train recovery and metrics read that explicit path, including
paths in older receipts. Fast validation creates no slot sidecar directory.

Compared every lane difference against main in `promote/train.mjs` and
`lanes/validation.mjs`. The additions are preparation clocks/history, slot grant
recovery, the slot sidecar argument and embedded command clocks. The timeout
phase, per-job outcome/reason, no-bisection branch, canonical history key,
watchdog executor and limits are retained. The host envelope calculation remains
`max(1, 2 * jobs - 1) * (wall_seconds + 600) + 60`, with idle timeout and retry
both disabled on the envelope. A direct source comparison verified the train
timeout branch and host envelope region exactly match main.

The added regression cases assert wall and idle singleton isolation wording,
wall multi-lane re-enqueue wording, one attempt without replay/bisection,
unchanged main, released scratch slot, a discoverable timeout gate receipt,
and retained slot, preparation and command clocks and metrics.

Focused checks used the absolute memory fixture preload and these full files:

```sh
node --test test-slot/test/watchdog.test.mjs test-slot/test/test-slot.test.mjs test-slot/test/gate-profile.test.mjs promote/test/*.test.mjs
```

Plain: 239 passed, zero failed/cancelled/skipped; 186.379 seconds.
Nested: 239 passed, zero failed/cancelled/skipped; 188.795 seconds.

The nested command ran through `test-slot.mjs run` with an explicit private
`--lock-path`, private `--project-common`, a 1800-second outer watchdog, idle
timeout disabled and no retry. Its bootstrap verified both selected paths,
both inherited Monitor/bch-cloak tokens, and the matching held scratch lock.
The persisted outer execution receipt reports exit zero, and the scratch lock
was gone after completion. Each file's ordinary fixture isolation remained in
place. Live record/session identity was scrubbed, fleet and watchdog history
were pinned to scratch, and native process/socket/PTY fixtures ran outside the
worker sandbox. No host slot, promotion/release tier, model call or live harness
was used. Shared-history diagnostics named other origins; no test-origin leak
was reported. `git diff --check` passed.

After report validation and commit, the final fast-tier `lane check --cmd`
runs the three unchanged watchdog lane/queue/fast timeout cases, the three new
timeout/timing cases and the existing unconfigured train timing case. It uses
scratch watchdog history and takes no host slot. Its gate receipt records the
final report commit and result; this run stops after that check.
