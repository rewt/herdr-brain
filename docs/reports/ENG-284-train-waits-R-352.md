---
run: R-352
outcome: done
summary: |
  Rebased lane/train-waits onto main ef21d58ed7441cf6c7a0c90f66cd2abb5e08ddca. Resolved the validation and train conflicts by retaining the watchdog executor, canonical history key, limits and timeout outcomes alongside slot grant receipts, embedded command clocks and preparation intervals. Combined the bridge test changes into one bounded wait for both complete group records, retaining live-wrapper exclusion checks through each lock.
  All 205 requested focused promotion, slot and gate-profile tests passed, with no failures, cancellations or skips. Main remained ef21d58e after validation, so the parallel memory-before-locks lane had not landed and a second rebase was unnecessary. Rebased code is committed; this checked report and compressed test evidence are committed before the final focused fast-tier lane check, whose gate receipt records the final committed tree and result.
headline: The wait metrics lane is rebased and all requested tests pass.
blockers: []
proposals: []
learnings:
  - The watchdog and wait-metrics validation changes compose by passing the slot sidecar to the watchdog executor and copying slot grants before handling timeout outcomes.
  - Both lanes already waited for bridge group registration; the combined test additionally retains complete start and birth identities and verifies exclusion through each lock.
artifacts:
  - "Branch: lane/train-waits"
  - "Rebase base: ef21d58ed7441cf6c7a0c90f66cd2abb5e08ddca"
  - "Rebased validation/train integration commit: 63942794"
  - "Rebased combined bridge test commit: 19f21a18"
  - "Rebased reviewed lane head before this report: 3e95b28d"
  - lanes/validation.mjs
  - promote/train.mjs
  - test-slot/test/test-slot.test.mjs
  - docs/reports/evidence/R-352/focused.tap.gz
  - docs/reports/ENG-284-train-waits-R-352.md
  - /Users/rewt/development/rewt/.org/runs/R-352/report.md
  - ".lane/gate.json: final focused fast-tier lane-check receipt"
decisions: []
questions: []
challenges: []
---

The rebase preserves the gate watchdog's host envelope sizing, history-derived
limits, distinct timeout results, and test history isolation. Wait instrumentation
continues recording batch start before resource acquisition, external-lock and
slot grants, preparation intervals, and command start/end clocks. The slot
sidecar is written only after acquisition; waiting and refusal create none.

The bridge test keeps a single group-registration poll. It verifies both locks
exclude contenders using the live wrapper identity, then waits for both records
to name the command PID with start and birth identities and compares those
identities. The watchdog's load-scaled slot wait remains intact.

Focused validation:

```sh
NODE_OPTIONS="--import=$PWD/test/helpers/memory-fixture.mjs" node --test promote/test/*.test.mjs test-slot/test/test-slot.test.mjs test-slot/test/gate-profile.test.mjs
```

Result: 205 passed, zero failed/skipped/cancelled, 329.926 seconds. This includes
inner idle timeout, canonical history-derived limits, five-attempt red bisection
host-envelope sizing, two-lane host timeout wording, wait metrics, successful
slot grants, and no-receipt refusals. The shared-history diagnostic attributed
existing history to other origins; no test-origin history leak was reported.

The invocation ran outside the worker sandbox for offline scratch watcher,
localhost socket and PTY fixtures. It scrubbed live record/session identity,
pinned the fleet and slot paths to private scratch, and used the absolute memory
fixture preload. No host test slot or project-wide promotion/release tier ran.
`git diff --check main..HEAD` passed.

After report validation and commit, the final command is a fast-tier
`lane check --cmd` covering the slot grant receipts, both bridge migration cases,
the unchanged legacy-holder no-receipt refusal and unconfigured train timing.
It loads the existing bridge-delay preload to widen the post-spawn metadata
update interval. The outer fast check takes no slot and writes its watchdog
history to scratch. Its `.lane/gate.json` records the final report commit and
validation result; no subsequent work is scheduled by this run.
