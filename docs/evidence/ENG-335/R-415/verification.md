# Safe retirement recovery and full-file verification

Run: R-415. Product commit: `4f8e379a`; plain fixture setup: `6238ff4b`.
Starting lane commit: `90e42338`.

The three reported failures were product regressions. R-413 added an unconditional
full observation at the start of apply for callback receipt pruning. That inserted
an agent/record read ahead of the executor and ahead of housekeeping recovery.
The third record observation therefore happened before clearing the composer,
instead of after it. Recovery does not compare record-directory timestamps.

Apply now skips that bookkeeping observation when no callback receipts exist.
Housekeeping supplies its current tick snapshot for receipt pruning, including
when receipts do exist. That snapshot never authorizes a close: the executor still
observes the record, topology, identities, processes, Git and references afresh
before each close. The three original tests are unchanged. The late occupants
still appear on the real final observation, and both two-read assertions pass.

A new test prunes an actual absent callback receipt while retaining exactly the
observe, pre-input and post-clear record checks. It sends the clearing keys and
suppresses the prompt after the report arrives. `receipt-negative.tap` proves this
test fails against the starting product code in a disposable copy: expected
send-keys, actual no input. No production source was reverted for the check.

Before editing, the original three failing tests were run unchanged against main
`1a663c791afa182b4364cba77d9bf9bd52c7664f` in a disposable archived copy. All three
passed (`main-housekeeping.tap`); the same lane cases failed (`before.tap`).
`targeted.tap` records all three plus the added receipt regression passing.

The first full twelve-file run exposed one additional product regression and two
native inspection failures (`gate-initial.tap`):

- Settle-watch had lost its early canonical-workspace check when session pruning
  moved to retirement. A missing cwd reached account lookup first. The unchanged
  test passes on main (`main-settle.tap`). Restoring the workspace preflight before
  retirement/account lookup fixes it; newTab still resolves the workspace again
  immediately before use. No settle-watch assertion was changed.
- The queue cleanup and dequeued-job tests passed their assertions, but their
  teardown hooks received EPERM from the native process snapshot. Both passed
  unchanged in isolation (`inbox-targeted.tap`). The final complete runs use native
  inspection permission. No ownership guard, teardown helper or assertion was
  relaxed, and the initial group audit reported no surviving fixture.

The first plain run revealed a pre-existing memory-fixture setup problem: the
pressure case set TEST_MEMORY_FILE but relied on the guarded runner's preload to
read it. The unchanged case also fails on main (`main-memory.tap`). The fixture now
explicitly loads the existing native-memory adapter for its child processes;
all pressure, lock and fast-forward assertions remain unchanged. It passes in
plain Node (`memory-targeted.tap`). Production memory handling is unchanged.

The supervisor interrupted that first plain run during a memory-sensitive host
check. Its exact owned test group was stopped with a fresh PID/birth/argv/group
check, and a native snapshot confirmed no survivors. `node-test-interrupted.tap`
is incomplete and is not a passing check. Both complete modes are rerun after
the supervisor's hold release.

Full verification commands (no name filters):

```sh
node test/helpers/run.mjs --file-timeout=480000 --suite-timeout=540000 housekeeping/test/auto-tidy.test.mjs housekeeping/test/housekeeping.test.mjs lanes/test/lane.test.mjs promote/test/promote.test.mjs supervisor/test/entry.test.mjs test/retire-lock.test.mjs test/retire-paths.test.mjs test/retire.test.mjs test/tidy-tabs.test.mjs verify/test/verify.test.mjs test/settle-watch.test.mjs test/bch-cloak-contract.test.mjs
node --test --test-concurrency=4 housekeeping/test/auto-tidy.test.mjs housekeeping/test/housekeeping.test.mjs lanes/test/lane.test.mjs promote/test/promote.test.mjs supervisor/test/entry.test.mjs test/retire-lock.test.mjs test/retire-paths.test.mjs test/retire.test.mjs test/tidy-tabs.test.mjs verify/test/verify.test.mjs test/settle-watch.test.mjs test/bch-cloak-contract.test.mjs
```

Both complete runs finished after the supervisor released the hold, against
the final source and fixture setup, with no name filters:

- `gate.tap`: 461 passed, 0 failed, 0 cancelled, 0 skipped; 465.674 seconds; exit 0.
- `node-test.tap`: 459 passed, 0 failed, 0 cancelled, 2 skipped; 460.976 seconds;
  exit 0. The two existing skips are canonical/installed-copy schedule startup
  checks requiring the guarded runner's owned process group. Both run and pass
  in the complete guarded check above.

Syntax and source diff checks passed. No surviving fixture was reported by the
final runner's group audit. The disposable main/negative comparison copies were
removed after their results were saved. Whitespace-only TAP lines are normalized;
diagnostic text and test results are preserved. All Herdr interactions used offline
fixtures. No live cleanup, project housekeeping start, model call, release,
integration of this lane or push was performed. The optional generic reference contract and
the remaining live sources are unchanged.
