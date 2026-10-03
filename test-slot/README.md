# Host test slot

Herdr Monitor supplies a dependency-free foreground slot for heavy validation in
any project. Promotion-tier lane validation takes it before executing tests;
reused green evidence needs no slot. The release supervisor takes it before
cutting or claiming a candidate and keeps it through preparation and the gate.
Worker fast checks remain available. The installed entry runtime carries this
module, and this project's `npm run test:promotion` also takes it directly.

```sh
node "$HERDR_PLUGIN_ROOT/test-slot/test-slot.mjs" run promotion --wait 600 -- npm test
node "$HERDR_PLUGIN_ROOT/test-slot/test-slot.mjs" status
```

The default lock is `/private/tmp/bch-cloak-test-slot.lock` on macOS and
`/tmp/bch-cloak-test-slot.lock` on Linux. It uses bch-cloak ENG-725's holder schema
and UTC/C process start identity, so existing bch-cloak gates exclude Monitor
runs and vice versa. No source changes in that project are needed.

Set `MONITOR_TEST_SLOT_PATH` to an absolute workspace-owned lock file path; its
parent directory must already exist. This is workspace configuration, shared by
all projects, rather than tracked project metadata. While migrating, Monitor
also acquires the default legacy lock, before the configured workspace lock,
with one token and the same command group in both records. This prevents overlap
even when bch-cloak still uses its old path. `MONITOR_TEST_SLOT_COMPAT_PATH` lets
the workspace relocate that bridge once legacy users migrate; set both paths to
the same file to converge on one lock. Never select separate paths per project.
`--lock-path PATH` selects a single explicit lock for isolated checks and tests.
The CLI propagates both selected paths to nested commands.

`MONITOR_TEST_SLOT_WAIT_SECONDS` (or `--wait SECONDS`) queues for a bounded number
of whole seconds; the default is immediate refusal. The legacy
`BCH_CLOAK_TEST_SLOT_WAIT_SECONDS` is accepted when the Monitor variable is unset.
Waiters poll for release; this is mutual exclusion, not a FIFO queue.

A refusal exits **75**, with one coded line: `TEST_SLOT_HELD` for a live holder,
or `TEST_SLOT_HOLDER_UNKNOWN` when liveness cannot be established. Neither is a
test failure. Lane checks preserve exit 75 and write no failed gate receipt;
release returns a deferred result without cutting or claiming a candidate (its
CLI emits the coded refusal and exits 75). Inspect unknown holder evidence;
never break a lock by age. Status exits 0 for free/gone, 1 for live, 2 for unknown,
and reports both paths when the legacy bridge differs from the workspace path.

Liveness uses PID and start time, never command-line patterns. A new holder
executes the command in its own process group and forwards INT, TERM and HUP.
After a killed wrapper, a live command group still blocks takeover. A command
leaving background group members retains the lock and cannot report success.
Known-stale removals serialize through a `.takeover` guard and recheck the exact
record. Unknown records and abandoned takeover guards stay in place. Nested
commands inherit Monitor and bch-cloak tokens, or recognize a live holder through
ancestry/group membership; they neither wait for themselves nor release the
outer slot. A stale inherited token cannot authorize nesting.

Promotion and release gate adapters enable `--retry-timeout-under-load`: a
nonzero timeout (exit 124, `ETIMEDOUT`, or the Node test runner's timeout marker)
under measured load above one per available CPU (capacity capped at four) is
re-run once, with the slot still held. The log includes
`TEST_SLOT_TIMEOUT_RETRY` and both attempts. A second timeout counts as failure.
Ordinary failures, signals and exit 75 never retry. The release claim and snapshot
are created once; only its gate command can retry, never preparation or the
release lifecycle. Gate commands must be safe to rerun after a timeout. This
isolates other participating heavy suites, rather than stopping unrelated host
work or relaxing any test deadline.

`npm run test:slot` exercises temporary locks and owned child groups offline;
`npm test` includes it. These tests need native `/bin/ps` and signal access and
run outside the fixture policy that disables detached processes. Other offline
fixtures receive a temporary slot per test file and never take the machine's
real slot. No model calls or live acceptance harness are involved.
