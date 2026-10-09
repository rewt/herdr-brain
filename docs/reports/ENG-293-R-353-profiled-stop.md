---
run: R-353
outcome: done
summary: |
  Fixed the review's Moderate finding in commit 344d5c2. The host adapter checks STOP during its initial and held memory waits only when the train receipt has no attempts. Resumed profiled batches retain all memory waits and reach runTrain's existing guards, which reconcile integrated members and refuse unfinished members under STOP. All 36 memory/gate-profile tests and all 128 promote tests pass without skips. This report precedes its record check, report commit and final fast lane check; that check records its result in the lane gate receipt.
headline: Resumed profiled batches now recover integrated work while STOP is active.
blockers: []
proposals: []
learnings:
  - A profiled batch's resumed STOP rule must apply at every host memory check, before the external lock, after that lock and after the test slot. Otherwise runTrain cannot reconcile saved integration checkpoints.
artifacts:
  - "Implementation commit 344d5c2: Let resumed profiled trains reconcile STOP checkpoints"
  - "Branch lane/memory-before-locks"
  - "promote/host-gate.mjs"
  - "promote/memory-gate.mjs"
  - "test-slot/test/gate-profile.test.mjs"
  - "docs/reference/memory-gate.md"
  - "docs/reports/evidence/ENG-293-R353/checks.json and compressed TAP logs"
  - "docs/reports/ENG-293-R-353-profiled-stop.md"
  - "/Users/rewt/development/rewt/.org/runs/R-353/report.md"
decisions:
  - text: Skip only the host adapter's STOP checks for receipts with attempts, retaining initial memory waits and bounded held rechecks.
    category: tooling
    why: The train's existing guards can refuse unfinished members and reconcile integrated members without another gate or fast-forward.
questions: []
challenges: []
---

The correction addresses only the review's Moderate finding. Fresh batches keep
the early STOP refusal before acquiring any promotion resource. For resumed
batches, the host adapter carries the receipt's attempt-based STOP rule through
all three memory checks. Memory-pressure timeouts, lock handling, host capability
checks, competing-process checks and watchdog limits remain intact.

The new coverage exercises a fresh STOP with healthy memory and both saved
`validated` (lost fast-forward response) and `integrated` checkpoints under STOP.
Each resumed case starts with low memory, proves the external lock, slot and
project lock remain available, clears pressure, then reconciles the integrated
member and refuses the unfinished member. Both queue outcomes are delivered;
the receipt completes with no interrupted batch, additional gate or Git change.

Validation:

- The unchanged main test `a capped resume preserves a lost fast-forward checkpoint and reconciles it without another gate` passed in a scratch main archive before editing tests, following lesson L-5. Existing tests were retained.
- New STOP regression cases: 3 passed, 22 unselected cases skipped.
- `env -u ORG_DIR -u HERDR_AGENT_NAME NODE_OPTIONS=--import=$PWD/test/helpers/memory-fixture.mjs node --test test-slot/test/gate-profile.test.mjs test/memory.test.mjs promote/test/memory-gate.test.mjs`: 36 passed, no failures or skips.
- `env -u ORG_DIR -u HERDR_AGENT_NAME NODE_OPTIONS=--import=$PWD/test/helpers/memory-fixture.mjs node test/helpers/run.mjs --file-timeout=180000 --suite-timeout=300000 promote/test/*.test.mjs`: 128 passed, no failures or skips; suite process audit passed.
- `git diff --check`: passed before the implementation commit.

The initial sandboxed main control test could not open a local socket; approved
host execution passed. New fixture development also corrected Git exclusion of
scratch STOP state and supplied an idle offline delivery adapter. Tests use fake
native memory, scratch Git projects, fleet data, slots and external locks. No
host test slot, baseline, promotion/release tier or live acceptance harness ran.

After validating and committing this report, the final operation is
`env -u ORG_DIR -u HERDR_AGENT_NAME node lanes/lane.mjs check --tier fast`.
Its gate receipt and log retain validation of the final report commit. Then stop.
