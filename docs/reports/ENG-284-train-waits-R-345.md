---
run: R-345
outcome: done
summary: |
  Rebased lane/train-waits cleanly onto main 74547285 and committed the correction in 636e93d166a727b9fd1627a4f6cfe2f39063d73f. Slot timing sidecars are now written once after acquisition; waiting and refusal write none, while successful grants retain the full bounded-wait evidence.
  Exercised every requested promotion and slot test plus all host-profile tests: 199 of 200 passed together; the unrelated load-sensitive Git-show timeout assertion passed on an isolated retry. The existing promotion-refusal expectation remains unchanged. Added regression coverage for a grant, a capped refusal and an unknown-holder refusal, and updated host-profile evidence checks and documentation.
  This checked report and validation evidence are committed before the final focused fast-tier lane check. Its gate receipt records the final report commit and validation result.
headline: Refused slots no longer create grant receipts.
blockers: []
proposals: []
learnings:
  - Slot fixture tests need their normal process groups; the generic test runner containment policy overrides detached groups and prevents their signal-forwarding fixtures from releasing normally.
  - Direct promotion tests need the absolute memory-fixture preload in NODE_OPTIONS so memory-pressure scenarios also control native inputs in temporary child repositories.
  - Without a refused slot sidecar, host-profile queue results retain a generic slot refusal and the train log retains the detailed TEST_SLOT_HELD diagnostic.
artifacts:
  - "Correction commit: 636e93d166a727b9fd1627a4f6cfe2f39063d73f"
  - "Branch: lane/train-waits"
  - test-slot/test-slot.mjs
  - test-slot/test/test-slot.test.mjs
  - test-slot/test/gate-profile.test.mjs
  - promote/host-gate.mjs
  - test-slot/README.md
  - promote/README.md
  - docs/reports/evidence/R-345/focused.tap.gz
  - docs/reports/evidence/R-345/settings-retry.tap.gz
  - docs/reports/ENG-284-train-waits-R-345.md
  - /Users/rewt/development/rewt/.org/runs/R-345/report.md
  - ".lane/gate.json: final focused fast lane-check receipt"
decisions: []
questions: []
challenges: []
---

The slot runner accumulates wait clocks and holder observations in memory and
atomically writes its `test-slot-wait/v1` receipt only after both required locks
are granted. The receipt preserves `state: acquired`, `started_at`,
`acquired_at`, `finished_at`, the wait cap, holder observations and nesting.
A held or unknown slot exits 75 without a receipt or command execution.

The grant regression waits for a real `TEST_SLOT_WAIT` diagnostic, checks that
no receipt exists while waiting, releases its private holder and verifies that
exactly one acquired receipt exists. Refusal cases cover both an exhausted
wait for a live holder and an unknown holder. The unchanged
`bch-cloak-compatible holder refuses promotion with 75 and supplies no failed receipt`
test is included in the final lane check. Host-profile tests cover queue refusal,
grant recovery and a successful slot grant followed by a competing-process
refusal; that last case correctly retains the grant receipt.

Focused validation:

```sh
NODE_OPTIONS='--import=/Users/rewt/development/rewt/.worktrees/herdr-brain/lane-train-waits/test/helpers/memory-fixture.mjs' node --test promote/test/*.test.mjs test-slot/test/test-slot.test.mjs test-slot/test/gate-profile.test.mjs
```

This exercised 200 tests with no skips. One unrelated settings timeout test
failed its comparison between a child's sampled timeout and the parent's later
`loadTimeout(2000)` sample. The isolated retry passed:

```sh
NODE_OPTIONS='--import=/Users/rewt/development/rewt/.worktrees/herdr-brain/lane-train-waits/test/helpers/memory-fixture.mjs' node --test --test-name-pattern='^a settings git show timeout releases' promote/test/train.test.mjs
```

Earlier attempts used the generic runner, which changes process groups, or
lacked the absolute native-input preload. Those fixture setup failures were
resolved before the retained validation above. Host-capability fixtures used
approved host execution, private repositories and locks, localhost sockets
and PTYs. No host test slot, project-wide suite, promotion/release tier or live
acceptance harness was used. `git diff --check` passed.

After checking and committing this report, the final command is a fast-tier
`lane check --cmd` covering the original no-receipt refusal expectation, all
new slot-grant cases, both busy-host-slot cases and the competing-process
case. The outer lane check takes no host test slot.
