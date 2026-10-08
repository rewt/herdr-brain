---
run: R-350
outcome: done
summary: |
  Rebased lane/train-waits onto main 0a3cf3a0 and committed the bridge-race correction in 122c8216. The test now verifies that both locks immediately exclude contenders through the live wrapper identity, then waits with the existing load-scaled deadline for both records to name the command group. The slot documentation describes that post-spawn update interval.
  Reproduced the original mismatch on both unmodified main and the lane under an outer scratch batch slot, four CPU workers, and a deliberately widened interval between atomic group updates. All 53 slot tests passed with that stress after the correction. All 200 focused promotion, slot and host-profile cases passed across the initial run and required retries: the initial sandbox run passed 176, with 23 watcher/host-capability failures and one retained inbox-lock failure; the host-capability retry passed all 35 cases and the isolated crash-notice retry passed.
  This checked report and evidence are committed before the final focused fast-tier lane check. Its gate receipt records validation of the final report commit.
headline: The bridge test now waits for group metadata while verifying both locks exclude contenders.
blockers: []
proposals: []
learnings:
  - A command readiness marker does not synchronize the wrapper's post-spawn group metadata updates across the legacy and workspace locks. Both locks already name the live wrapper, which excludes contenders during that interval.
  - The original bridge assertion also fails on main when the interval between its two atomic updates is widened. An ordinary passing main run does not establish a group-metadata-before-command guarantee.
  - Direct focused promotion checks need the absolute memory-fixture preload; watcher and host socket/PTY fixtures need host permissions and private scratch slots.
artifacts:
  - "Correction commit: 122c8216"
  - "Branch: lane/train-waits; rebased onto main 0a3cf3a05ddd2e2be03795e733a161c3290cd7dd"
  - test-slot/test/test-slot.test.mjs
  - test-slot/README.md
  - docs/reports/evidence/R-350/bridge-delay.mjs
  - docs/reports/evidence/R-350/bridge-reproduce.mjs
  - docs/reports/evidence/R-350/main-plain.tap.gz
  - docs/reports/evidence/R-350/main-loaded-before.tap.gz
  - docs/reports/evidence/R-350/lane-loaded-before.tap.gz
  - docs/reports/evidence/R-350/lane-loaded-after.tap.gz
  - docs/reports/evidence/R-350/plain-focused.tap.gz
  - docs/reports/evidence/R-350/promote-host-retry.tap.gz
  - docs/reports/evidence/R-350/train-host-retry.tap.gz
  - docs/reports/ENG-284-train-waits-R-350.md
  - /Users/rewt/development/rewt/.org/runs/R-350/report.md
  - ".lane/gate.json: final focused fast-tier lane-check receipt"
decisions:
  - text: Accept the intermediate group-metadata state and wait for both records in the test.
    category: design
    why: Both locks are acquired before spawn and their live wrapper identity excludes contenders during separate atomic group updates. The handoff explicitly permits this correction, and the revised test verifies exclusion through each path before checking eventual group metadata.
questions: []
challenges:
  - "Main passed the original test plainly, but unmodified main and the lane both failed the same pgid-versus-null assertion with a widened update interval under load. This demonstrates an existing observation race rather than a lane-specific lock exclusion failure; the correction follows the handoff's permitted test-wait option."
---

The product acquires the legacy and workspace locks in order before spawning
the command. Each initially contains the wrapper's PID and pinned start/birth
identity. `holderState` checks that identity first and regards the record as
live while the wrapper runs, even when `pgid` is null. `executeCommand` records
the command group after spawn, and `setGroup` updates the two records one after
the other. Command readiness cannot prove completion of those writes.

The revised migration test still checks legacy contention before acquisition,
one token and the actual command group in both locks, signal forwarding, and
release of both locks. Before waiting for metadata it additionally verifies
the live wrapper identity and a `TEST_SLOT_HELD` exit-75 refusal through each
lock path. Its metadata poll uses the existing `until` helper with
`loadTimeout`; a missing or wrong group still fails the bounded check. No
product acquisition, liveness, signal or receipt behavior changed.

Reproduction evidence:

- `main-plain`: original main test passes with ordinary scheduling.
- `main-loaded-before` and `lane-loaded-before`: original assertion fails with
  a numeric legacy pgid and a null workspace pgid.
- `lane-loaded-after`: all 53 slot cases pass, with no skips or cancellations,
  under the same widened interval and four CPU workers. The scratch outer
  legacy and workspace locks are released at completion.

The retained reproduction driver selects temporary outer legacy/workspace
paths and propagates `MONITOR_TEST_SLOT_PATH`,
`MONITOR_TEST_SLOT_COMPAT_PATH`, both Monitor and bch-cloak tokens, and both
600-second wait variables through the outer wrapper, as a batch does. It
scrubs live record/session identity and sets the fleet to scratch. Its loaded
mode adds four CPU workers and a preload that pauses for 1500 ms immediately
after the labelled workspace wrapper's first legacy group update. This models
descheduling or slow filesystem work between the actual atomic writes. It
does not delay commands, change lock contents, or alter product liveness.

To rerun against a source export or this lane:

```sh
node docs/reports/evidence/R-350/bridge-reproduce.mjs /absolute/repository /private/tmp/bridge.tap loaded bridge
node docs/reports/evidence/R-350/bridge-reproduce.mjs "$PWD" /private/tmp/slot-loaded.tap loaded all
```

Plain focused validation ran directly, without an outer slot:

```sh
NODE_OPTIONS="--import=$PWD/test/helpers/memory-fixture.mjs" node --test promote/test/*.test.mjs test-slot/test/test-slot.test.mjs test-slot/test/gate-profile.test.mjs
```

That run exercised 200 cases with no skips or cancellations. It passed all
53 slot cases plainly. Fourteen queue cases failed with sandbox `fs.watch`
EMFILE errors, nine profile cases failed because sandbox host socket/PTY
capabilities were unavailable, and one crash-notice recovery case failed on
a retained private inbox lock. The two affected host-capability files were
retried outside the worker sandbox and passed all 35 cases:

```sh
NODE_OPTIONS="--import=$PWD/test/helpers/memory-fixture.mjs" node --test promote/test/promote.test.mjs test-slot/test/gate-profile.test.mjs
```

The only other failure passed its isolated host retry:

```sh
NODE_OPTIONS="--import=$PWD/test/helpers/memory-fixture.mjs" node --test --test-name-pattern='^a crash with a train notice queued' promote/test/train.test.mjs
```

All these invocations scrubbed live `ORG_DIR` and `HERDR_AGENT_NAME`, pinned
`HERDR_MONITOR_FLEET` to scratch, and selected private slot paths. No host test
slot, project-wide suite, promotion/release tier, live harness or model was
used. `git diff --check` passed.

After `record check` and the report/evidence commit, the final command is
`node lanes/lane.mjs check --tier fast --cmd ...`. Its focused command loads
the absolute memory and bridge-delay preloads and runs the migration test,
slot grant-receipt tests, and unchanged legacy-holder refusal test from
`lanes/test/validation.test.mjs`. This verifies the final clean committed tree
without taking the host slot. The lane gate receipt supplies the final result.
