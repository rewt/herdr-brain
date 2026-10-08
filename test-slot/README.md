# Host test slot

Herdr Monitor supplies a dependency-free foreground slot for heavy validation in
any project. Promotion-tier lane validation takes it before executing tests;
reused green evidence needs no slot. The release supervisor takes it before
cutting or claiming a candidate and keeps it through preparation and the gate.
Worker fast checks use the same watchdog without taking the slot. The installed entry runtime carries this
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

`run ... --wait-receipt-path PATH -- COMMAND` atomically writes one
`test-slot-wait/v1` grant receipt after acquisition, including `state: acquired`,
the wait start, grant time and encountered holder descriptions. Waiting and
refusal write no slot receipt. It also logs each new live
holder with `TEST_SLOT_WAIT`. Without this option the existing coded CLI output
stays unchanged. The promotion gate profile uses this receipt while holding the
slot across its pre-gate build and entire train invocation. The legacy bridge
and configured workspace slot share one deadline, so acquiring the bridge does
not grant a fresh wait allowance for the second lock.

A refusal exits **75**, with one coded line: `TEST_SLOT_HELD` for a live holder,
or `TEST_SLOT_HOLDER_UNKNOWN` when liveness cannot be established. Neither is a
test failure. Lane checks preserve exit 75 and write no failed gate receipt;
release returns a deferred result without cutting or claiming a candidate (its
CLI emits the coded refusal and exits 75). A command that starts and itself exits
75 supplies ordinary failed validation evidence; lane check and promote exit 1
while the receipt and check's GATE line preserve the command's exit 75. Inspect
unknown holder evidence;
never break a lock by age. Status exits 0 for free/gone, 1 for live, 2 for unknown,
and reports both paths when the legacy bridge differs from the workspace path.

Liveness uses PID and start time, never command-line patterns. Process reads use
`lib/processes.mjs`: bundled non-setuid Darwin kernel readers or Linux `/proc`.
Darwin identity reads use `sysctl KERN_PROC_PID`, so unprivileged callers can
recognize holder or group PID reuse across users, including root-owned processes.
An unreadable identity remains unknown and retains the lock.
New records additionally pin `processBirth` and `groupBirth` at kernel precision
(microseconds on Darwin, boot UUID plus start ticks on Linux), so same-second PID reuse is
distinguished. The existing `processStart`/`groupStart` UTC/C strings remain for
bch-cloak interoperability; old records retain their original second precision.
Linux converts legacy timestamps from `/proc/stat` and non-setuid
`/usr/bin/getconf CLK_TCK`. Missing or denied sources refuse clearly, including
before a new slot creates its lock. A new holder
executes the command in its own process group and forwards INT, TERM and HUP.
After a killed wrapper, a live command group still blocks takeover. A command
leaving background group members gets a one-second grace, then its remaining owned
processes are stopped. The slot is released after confirmed cleanup and the wrapper
exits **123** with `GATE_LEFTOVER_GROUP:`, a failure distinct from a gate timeout.
Known-stale removals serialize through a `.takeover` guard and recheck the exact
record. Unknown records and abandoned takeover guards stay in place. Nested
commands inherit Monitor and bch-cloak tokens, or recognize a live holder through
ancestry/group membership; they neither wait for themselves nor release the
outer slot. Nested commands remain in the holder command group: legacy bch-cloak readers
check only the holder PID and PGID, so separate nested groups would allow overlap
after wrapper death. Nested watchdogs stop only identity-confirmed descendants
via the parent walk, never signal the shared group. Group-registration guards
record their owner PID and birth identity; only a confirmed dead owner permits
recovery, with a coded diagnostic naming the guard path. Age never permits recovery. A stale inherited token cannot authorize nesting.

The lane promotion adapter holds the slot with timeout retry disabled, so it
never replays a command chain, including when a leaf declines to retry. Leaf
wrappers and the release gate command may enable `--retry-timeout-under-load`: a
nonzero timeout (exit 124, `ETIMEDOUT`, or the Node test runner's timeout marker)
under measured load above one per available CPU (capacity capped at four) is
re-run once, with the slot still held. The log includes
`TEST_SLOT_TIMEOUT_RETRY` and both attempts. A second timeout counts as failure.
The retry scope is the wrapped command. This project's promotion command holds
the slot for the whole chain and wraps `test:promotion:core`, the focused
`test:promotion:lanes` and mixed-file `test:promotion:logic` separately, so only
the timed-out step reruns. The complete
former chain (`test:core`, `test:cycle`, `test:lanes`, `test:acceptance`) now runs
in `test:release`, retaining the same bounded leaf retries.
Containing wrappers recognize a child's retry marker and do not retry the chain
again. When a containing wrapper initiates the retry, it passes
`MONITOR_TEST_SLOT_TIMEOUT_RETRIED=1` so descendants cannot add another attempt.
Ordinary failures, signals and exit 75 never retry. The release claim and snapshot
are created once; only its gate command can retry, never preparation or the
release lifecycle. Gate commands must be safe to rerun after a timeout. This
isolates other participating heavy suites, rather than stopping unrelated host
work or relaxing any test deadline.

`npm run test:slot` exercises temporary locks and owned child groups offline;
`npm test` includes it. These tests need kernel process reads and signal access and
run outside the fixture policy that disables detached processes. Other offline
fixtures receive a temporary slot per test file and never take the machine's
real slot. No model calls or live acceptance harness are involved.

Every `run` also has a gate watchdog. Its monotonic wall clock starts when the
command starts inside the acquired slot; slot waits consume none of it. On an
overrun it prints `GATE_TIMEOUT: wall limit Ns exceeded; elapsed Ms`, sends TERM
to its owned command group, waits one second, then sends KILL. A kernel snapshot
before signalling walks the command's parent chain to include descendants that
created separate groups; each such PID is confirmed against its kernel birth
identity immediately before signalling. It waits for the group and those
children to disappear before releasing the slot, and exits **124**. Descendants
double-forked to init before observation are outside the parent walk; ENG-275
provides the reclaim backstop for that accepted boundary. Unrelated
processes receive no signal. Identity failures retain the lock.

Set `validation.timeout_seconds` in canonical lane configuration or
`.lane.validation.json` to a positive number of seconds, either for all tiers
or as a map such as `{"promotion":4500,"release":7200}`. A promotion host profile
may override it with `.promote.json`'s `gate.timeout_seconds`. CLI callers can
pass `--timeout-seconds SECONDS`, `--project-common GIT_COMMON_DIR`, and
`--tier TIER`; otherwise the CLI discovers the Git common directory and uses
its label as the tier. Fast and other non-slot validation tiers use the same process-group watchdog through `runGateSync` and never acquire the host slot (`run --no-slot` on the CLI). Their healthy history is recorded under their own tier.

Without an explicit limit, successful command durations in
`GIT_COMMON_DIR/gate-watchdog/` supply twice the maximum of the last 20 healthy
runs for that project, tier and command fingerprint, **only after three usable
samples**. Samples below 180 seconds for `promotion`, 300 seconds for `release`,
and 30 seconds for other tiers do not influence either wall or idle limits.
This sanity filter also excludes legacy subsecond fixture samples; short genuine
commands retain the conservative default or use an explicit project override.
The wall floor is **1200 seconds for promotion**, **3600 seconds for release**,
and **600 seconds for other tiers**. Full promotion and release commands can
select bounded extras, so these floors preserve twice the observed healthy
10-minute promotion and 30-minute release durations even after narrower runs.

Tests set `MONITOR_GATE_HISTORY_ROOT` to a disposable absolute directory in the
process calling product code and in child environments. History then lives at
`ROOT/SHA256(GIT_COMMON_DIR)/KEY.json`, preserving project isolation without
writing shared Git metadata. The shared offline and slot fixture helpers create
this override for direct test-file runs as well as bounded runs. They also install
an inherited `MONITOR_GATE_HISTORY_ORIGIN` token, which healthy samples retain
as `origin`. Nested test helpers preserve the token. Their exit guard fails only
if the real repository history contains a sample from that test process tree;
other writers' samples produce a non-failing diagnostic. Locks and concurrent
pruning do not count as leaks. The watchdog regression runs a fixture against
the actual Git common directory and checks only its unique command fingerprint
and scratch file. Concurrent-writer and deliberate-leak controls use independent
disposable Git repositories. A scratch slot lock alone
is insufficient: linked worktrees share their canonical Git common directory.

Train plans use an explicit history key (`--history-key` JSON: tier and declared
base command fingerprint), so affected file lists share history. Release gates
use their declared argv before candidate substitution. Both host envelopes
resolve from the same key as their inner gate. Recording keeps at most 128
command history files per project, pruning the least recently updated files. With fewer
than three usable matching samples (including older tier-only records),
the **4500-second (75-minute) default** bounds unfamiliar full gates
conservatively. Healthy promotion runs of 7–10 minutes train a **20-minute**
limit; release adapter runs of 20–30 minutes train a **60-minute** limit;
bch-cloak full runs up to 39 minutes train a **78-minute** limit. The 75-minute
warm-up default leaves 65, 45 and 36 minutes respectively above those maxima;
trained limits leave at least 2× room. Earlier bch-cloak clocks of 31m05s,
31m40s, 30m55s, 30m53s, 34m27s and 35m58s trained **71m56s**; their slot waits are never
recorded as command time. Only successful executions add samples; reuse,
refusals, overruns, and failures do not. Receipts and live slot records name the
resolved limits. The promotion host lifecycle allows up to `2 * jobs - 1`
sequential gates for batch bisection, each with its full inner wall allowance
and ten minutes for preparation, plus a final minute for bookkeeping and cleanup.
The release host allows the resolved prepare wall limit (when declared), twice
the resolved gate wall limit for its permitted load retry, and ten minutes for
snapshotting and bookkeeping. Both backstops let inner watchdogs persist their
exact outcomes first. A failed descendant snapshot still stops an owned child
group, but records a cleanup failure and retains the slot for inspection.

Output from both streams is observed and forwarded without buffering a suite
log. Each healthy sample also records its longest silence, including the final
stretch before exit. `validation.idle_timeout_seconds` or
`gate.idle_timeout_seconds` enables a no-output limit (`0` disables it); the CLI
accepts `--idle-timeout-seconds`. With three usable samples it defaults to three times
the longest recorded silence, with a **300-second floor**. With fewer than three usable samples it is
**off**: an unmeasured build may legitimately be silent for a long time.

Wall and idle overruns, including a nested gate's timeout marker, never spend
the timeout-under-load retry. Lane promotion exits 124 and keeps the lane for a
fix round. The merge train records `timeout` and isolates singleton candidates
for correction. Multi-lane timeouts report a batch timeout and permit plain
re-enqueue individually, without blaming each lane. Nothing replays automatically
and main stays unchanged.
The timeout receipt distinguishes this from ordinary test failures and a slot
wait refusal. Tests use scratch slot paths and never take the real host slot.
