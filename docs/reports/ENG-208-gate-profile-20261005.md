---
run: R-255
outcome: done
summary: |
  Added canonical project gate profiles for pinned Node, project environment, pre-gate preparation, host socket/PTY access, nested host-slot inheritance, bounded external kernel-lock waits and competing-process refusal. Implementation, documentation and proof are committed in 0f009ed. All 66 existing promotion tests passed unchanged, and all 67 host tests passed, including 11 new profile regressions. The real bch-cloak validate:all-safe gate passed on a scratch clone under Node 22.22.3; a legacy promoter that started during that gate correctly blocked the scratch fast-forward and left its green checkpoint intact. The original project was read-only. This report precedes its record check, report commit and final lane check.
headline: Project gates now run with pinned tooling and bounded lock waits.
blockers: []
proposals: []
learnings:
  - zsystem flock uses fcntl record locks, not flock(2). Its -e flag retains the descriptor through exec; opening and closing the same file in its owning process would release that process's record lock.
  - A detached child inherits the caller's sandbox. Profile promotion must start from the supervisor's host shell; denied socket or PTY access now leaves a coded refusal before building.
  - The existing bch-cloak wrapper uses the legacy host-slot path and BCH_CLOAK_TEST_SLOT_TOKEN. The Monitor bridge holds that path and propagates both tokens, allowing the unmodified wrapper to nest.
  - A capped guard wait while resuming cannot overwrite earlier integration checkpoints. A lost fast-forward response must remain reconcilable without another gate.
artifacts:
  - "Implementation commit 0f009ed: feat: support project promotion gate profiles"
  - "Branch lane/gate-profile"
  - "promote/gate-profile.mjs"
  - "promote/host-gate.mjs"
  - "promote/README.md"
  - "test-slot/test/gate-profile.test.mjs"
  - "docs/reports/evidence/R-255/promote-green.tap"
  - "docs/reports/evidence/R-255/host-green.tap"
  - "docs/reports/evidence/R-255/rehearsal-result.json"
  - "docs/reports/evidence/R-255/bch-cloak-gate.json"
  - "docs/reports/evidence/R-255/bch-cloak-gate.log.gz"
  - "docs/reports/evidence/R-255/bch-cloak-train.json"
  - "docs/reports/evidence/R-255/bch-cloak-host-gate.json"
  - "docs/reports/evidence/R-255/bch-cloak-slot-wait.json"
  - "docs/reports/evidence/R-255/competing-promoter-refusal.json"
  - "docs/reports/evidence/R-255/rehearsal.mjs"
decisions: []
questions: []
challenges: []
---

The promotion command remains declared through `.lane.validation.json` or the
existing `.promote.json` validation override. `.promote.json` now accepts a
`gate` object with `node_version_file`, literal `env`, scratch `prepare` steps,
`external_lock`, `refuse_processes` regular expressions and `wait_seconds`.
The README supplies the bch-cloak declaration, including its exact build filters.
Missing or malformed Node pins refuse before preparation. Environment values
are hashed into validation inputs rather than written to receipts.

The queue host adapter takes the external lock before the host slot, preserving
legacy promotion's acquisition order. It retains both guards through the train's
preparation, bisection gates, integration and scratch cleanup. Preparation runs
with the pinned PATH and project environment under the slot. The project's own
unmodified wrapper inherits the held legacy slot. Socket listening and
`/dev/ptmx` are checked before building; an inherited restrictive sandbox gets
`PROMOTE_HOST_REQUIRED` with the host launch instruction. Direct `lane promote`
retains its existing behavior.

Waits have a project-declared cap, defaulting to 7200 seconds. Atomic host and
slot receipts expose the wait, holder or lock path, cap and refusal reason.
The queue's outcome and notice link to the host receipt. A cap before the first
train attempt creates per-lane refusals without red gate evidence or bisection.
A cap on an interrupted resume retains its checkpoints. Process checks run
before and after the slot wait and under the Git lock before integration.

Focused validation ran outside the worker sandbox with offline transports:

```sh
env -u ORG_DIR -u HERDR_AGENT_NAME -u LANE_CONFIG -u LANE_VALIDATE \
  node test/helpers/run.mjs promote/test/promote.test.mjs \
  promote/test/train.test.mjs promote/test/workflow-engine.test.mjs \
  promote/test/workflow-train.test.mjs
env -u ORG_DIR -u HERDR_AGENT_NAME -u LANE_CONFIG -u LANE_VALIDATE \
  node --test test-slot/test/*.test.mjs
```

Results: **66 + 67 passed, zero failed, cancelled or skipped**. Every existing
promotion and slot test remains unchanged. New cases cover real kernel-lock
retention and contention, visible bounded waits, exact-commit integration,
environment and Node selection, pre-gate build slot ownership, process arrival
during a slot wait, host capability refusal, malformed declarations, queue
refusal receipts and a capped lost-fast-forward resume without another gate.
The new file runs through the existing `test:slot` promotion step, preserving
the real process groups required by slot tests. An initial raw invocation of
the promotion files omitted their required memory fixture; the corrected
repository runner passed all unchanged cases. No root baseline, full suite,
promotion tier, lane tier or acceptance harness was run.

The real-project rehearsal cloned bch-cloak commit
`f359730b832ab2d5d563f8b9af0b39e0972f7009` into
`/private/tmp/eng208-bch-rehearsal-R255`. Its existing pnpm cache was copied for
offline installation. Only scratch declarations and a proof lane were added;
the gate, package scripts, slot wrapper, build filters and tests were not stubbed
or changed. The profile used `.nvmrc`'s Node **22.22.3**,
`BCH_CLOAK_TEST_SLOT_WAIT_SECONDS=7200`, the exact two-filter pre-build, and the
real `/private/tmp/bch-cloak-test-slot.lock`. Its external lock was a
scratch-owned file using the same kernel primitive as legacy promotion.

`pnpm validate:all-safe` exited **0** in **1576.841 seconds**. Its saved log hash
and validated Git tree were independently checked. The validated head is
`9b35efa5a118dfb6831512aa670ec5d4d7868a63`. The initial invocation refused a
live `pool-wallet-design` legacy promoter. After that cleared, the gate ran;
before integration it detected another live legacy promoter, `pool-wallet-host`,
and refused the fast-forward. Scratch main stayed at
`1246b250602334c0f6b2e0a5cc62c649c10ca0a2`, and the attempt stayed `validated`.
This is the required transition guard working against real processes, not a red
gate. The real-copy fast-forward was therefore not performed; successful exact
integration and recovery are separately proved by the focused fixtures.

The scratch clone, its reusable green checkpoint and compressed logs are retained
for inspection. The original bch-cloak checkout, its configuration and its live
promotions were not changed. Its supervisor still owns the cutover and first
production batch. Metrics and dispatch work are outside this change.

The last action after this report is checked and committed is
`node lanes/lane.mjs check --tier fast`. Its result is not claimed in advance;
the lane receipt will be in `.lane/gate.json` and its referenced validation log.
