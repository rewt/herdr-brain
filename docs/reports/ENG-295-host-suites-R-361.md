---
run: R-361
outcome: done
summary: |
  Rebased lane/host-suites onto main 2dfdaa76, resolving the validation wrapper conflict while preserving main's gate limits/history, timeout outcomes, memory-before-locks safeguards and train wait metrics. Declared host suites retain own-slave PTY confinement, /dev/null stdin, protected writes, private temp cleanup and the documented wildcard TCP limit; host checks now also preserve grant receipts and command clocks under fast-tier host execution.
  All 83 requested focused tests passed plainly and all 83 passed inside an outer scratch slot, with zero failures, cancellations or skips. The nested bootstrap verified both batch slot paths, wait variables, tokens and held locks; both scratch locks were released. Rebased implementation is in 1465a742 and 5c5a0bfe; regression assertions and verification evidence are committed in c868096.
  This report is written and checked before its commit and the final focused fast-tier lane check. That final check records the report commit's exact tree in .lane/gate.json; this run then stops.
headline: The host suites are rebased and pass both focused validation runs.
blockers: []
proposals: []
learnings:
  - Host suites selected by a fast-tier check still acquire the host slot, so their grant sidecars and command clocks must follow slot use rather than the promotion tier alone.
artifacts:
  - "Branch: lane/host-suites"
  - "Rebase base: 2dfdaa76ef77598f53db6d66890f89d74c69d7b2"
  - "Rebased implementation and conflict resolution: 1465a742"
  - "Rebased PTY correction: 5c5a0bfe"
  - "Regression assertions and evidence commit: c868096"
  - lanes/validation.mjs
  - discovery/test/host-suites.test.mjs
  - docs/evidence/ENG-295-R-361/source-checks.json
  - docs/evidence/ENG-295-R-361/plain.json
  - docs/evidence/ENG-295-R-361/plain.tap
  - docs/evidence/ENG-295-R-361/nested.mjs
  - docs/evidence/ENG-295-R-361/nested.json
  - docs/evidence/ENG-295-R-361/nested.tap
  - docs/evidence/ENG-295-R-361/outer-wait.json
  - docs/evidence/ENG-295-R-361/outer-execution.json
  - docs/reports/ENG-295-host-suites-R-361.md
  - /Users/rewt/development/rewt/.org/runs/R-361/report.md
  - ".lane/gate.json: final committed-tree fast-tier lane-check receipt"
decisions: []
questions: []
challenges: []
---

The sole rebase conflict was in `lanes/validation.mjs`. The resolution combines
host-plan scratch ownership and execution environment with main's watchdog,
slot-grant sidecars, execution clocks and timeout receipts. A single `usesSlot`
condition includes promotion and declared host suites, retaining grant evidence
for named fast checks as well. Grant sidecars remain under `slot-waits/`, outside
the ordinary validation receipt namespace. The PTY correction rebased cleanly.

Source comparisons verify that `promote/host-gate.mjs`, `promote/memory-gate.mjs`,
`promote/gate-profile.mjs`, `test-slot/run.mjs`, `test-slot/test-slot.mjs` and
`test-slot/limits.mjs` match main exactly. The only train change from main adds
its declared host suites to validation; memory ordering, wait metrics, limits,
history keys and timeout handling remain intact. Main is an ancestor of the lane.

Both complete focused runs used:

```sh
node --test --test-concurrency=1 discovery/test/host-suites.test.mjs lanes/test/validation.test.mjs test-slot/test/watchdog.test.mjs test-slot/test/gate-profile.test.mjs
```

Plain: 83 passed, zero failed/cancelled/skipped; 111.545 seconds.
Nested: 83 passed, zero failed/cancelled/skipped; 145.242 seconds.

The automatic host probe ran without opt-in. Native own-slave/foreign-terminal
probes, the sandboxed-worker/session-parent request, raw PTYs, loopback TCP and
Unix listeners, /dev/null stdin, protected writes, outbound denial, receipt reuse,
watchdog timeout and private-temp cleanup all passed. Added assertions prove that
successful and timed-out host checks retain acquired grants and finite command
clocks, with the timeout check retaining its configured two-second wall limit.
The accepted wildcard-listener limitation remains documented in receipts.
Existing follow-ups on listener audits, external allowlists and PTY witness
strength are unchanged; this narrow rebase adds no duplicate proposals.

The nested driver isolates its fleet, project common directory and watchdog
history, uses separate scratch workspace and legacy lock paths, carries both
600-second batch waits and both inherited tokens, and verifies held lock records
before starting tests. Its outer watchdog reports one successful attempt, no
timeout and release of both locks. There was no test-origin history leak; shared
history diagnostics identify other origins. `git diff --check` passed. No host
slot, npm test, promotion/release tier, live acceptance harness or model was run.

After report validation and commit, the final operation is:

```sh
node lanes/lane.mjs check --tier fast --cmd "node --test --test-name-pattern='^(sandboxed worker asks the host parent|host watchdog binds)' discovery/test/host-suites.test.mjs"
```

It uses private fleet/history/slot paths. The fast wrapper takes no host slot;
its test fixtures use only scratch slots. `.lane/gate.json` records the final
committed report tree and result. This run then stops.
