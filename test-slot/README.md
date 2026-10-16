# Host test slot

Herdr Monitor supplies a dependency-free foreground slot for heavy validation in
any project. Promotion-tier lane validation takes it before executing tests;
reused green evidence needs no slot. The release supervisor takes it before
cutting or claiming a candidate and keeps it through preparation and the gate.
Worker fast checks use the same watchdog without taking the slot. The validation module carries this
module, and this project's `npm run test:promotion` also takes it directly.

```sh
node /path/to/herdr-monitor/test-slot/test-slot.mjs run promotion --wait 600 -- npm test
node /path/to/herdr-monitor/test-slot/test-slot.mjs status
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

Both locks name the live wrapper before it spawns the command. The wrapper then
records the command's group in each lock with separate atomic updates, so group
metadata can briefly differ after the command starts. The wrapper's PID and
start identity keep both locks live during those updates; readers need not wait
for matching group metadata to exclude another run. Group metadata consumers
must wait for both records rather than treating command readiness as proof that
the updates have finished.

`MONITOR_TEST_SLOT_WAIT_SECONDS` (or `--wait SECONDS`) queues for a bounded number
of whole seconds; the default is immediate refusal. The legacy
`BCH_CLOAK_TEST_SLOT_WAIT_SECONDS` is accepted when the Monitor variable is unset.
Waiters publish protocol v1 tickets in a private sibling directory named
`<lockPath>.queue` and take each path in filename arrival order. The queue reader
follows v1.1: a gone PID (ESRCH) or changed start/birth stops blocking immediately;
an unknown PID is honored until its ticket's `expiresAt`, with no shorter cap.
Tickets expire at their wait allowance even if their process is still live.
Nested commands and zero-wait takers publish no tickets. Deleting a queue directory
lets live waiters republish their original names and arrival times on the next poll.
Old pollers still interoperate through the unchanged lock record and may take a
free slot ahead of queued waiters; full arrival order requires both copies to queue.
The compatibility path is acquired first, then the workspace path with its own
queue; equal paths use one queue. Status lists each path's queue head first,
including live, gone, unknown, expired and unreadable classifications. Unreadable
tickets do not block and may be pruned only after their filename arrival is over
24 hours old. Hidden publication files are ignored.

`run ... --wait-receipt-path PATH -- COMMAND` atomically writes one
`test-slot-wait/v1` grant receipt after acquisition, including `state: acquired`,
the wait start, grant time and encountered holder descriptions. Waiting and
refusal write no slot receipt. It also logs each new live
holder with `TEST_SLOT_WAIT`. Without this option the existing coded CLI output
stays unchanged. The promotion gate profile uses this receipt while holding the
slot across its pre-gate build and entire train invocation. The legacy bridge
and configured workspace slot share one deadline, so acquiring the bridge does
not grant a fresh wait allowance for the second lock.

A refusal exits **75**, with one coded line: `TEST_SLOT_HELD` for a live holder or earlier waiter,
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

## Resource profiles and measurements (exclusive migration step)

Admission remains **EXCLUSIVE** for every command. There is no capacity ledger,
shared admission, named-claim enforcement, new lock record, or new ticket format.
The v1.1 protocol and token aliases above are unchanged. Resource metadata never
chooses admission, retries, deadlines, cleanup, or a validation verdict.

Profiles live with existing recipes: `package.json.resources` binds each named
test script by its JSON-string SHA-256; `test-slot/validation-resources.json` binds
validation commands exactly. Lane validation looks up the command it executes in
that separate file. `.lane.validation.json` retains its pre-profile schema and
bytes so older lane CLIs and installed validators can still read it; it carries
no resource metadata. `gate.resource` in a committed `.promote.json` may
carry a stanza for a project's train; otherwise the train derives its stanza
from a matching validation recipe. Its binding also includes preparation and the
existing gate fingerprint. A configured arbitrary command does not inherit a
nearby profile. Extra arguments or changed script bytes fall back to the legacy
serialized path with `resource.reason: unprofiled`. Metadata is execution evidence,
not authorization. The synchronous adapter can pass an exact-command `resource`
stanza (`--resource JSON` on the CLI) for an owned recipe.

Each stanza contains `id`, `revision`, exact command or script digest,
`admission_class: EXCLUSIVE`, `M_bytes: null`, `C: null`, worker caps,
`named_claims: []`, and evidence references. Memory envelopes and transitive
simultaneous CPU-worker demand are **unknown**, awaiting necessary runs. The
helper's `max(1, floor(4/loadFactor))` is a cap on simultaneous **test files**,
not on the threads, subprocesses or CPU workers those files create. `test:slot`
uses Node's default test-file concurrency instead. The release and promotion
composites include that step. No worker settings are changed by profiling.
Bindings record actual argv, recipe, real cwd, tree (or `.release-commit` in an
archive), Node executable/version, platform, worker declarations and an environment
hash; environment values are not copied into the profile receipt.

Only the foreground top-level profiled slot owner samples. Nested receipts say
`nested; sampling owned by top-level holder if profiled` and do not start another
sampler or release the parent's hold. This neutral status also applies when the
top-level holder or the nested command is unprofiled; it does not assert that
sampling happened. Unslotted validation still runs unslotted; its receipt says
`unslotted`. While holding the slot, the owner samples every 2,000 ms and at
phase boundaries. The owned set consists of the birth-confirmed command, its
parent-walk descendants, same-group members while group ownership is established,
and previously observed descendants with the same birth. After leader exit,
extending group ownership requires a retained member with a matching birth.
RSS is queried with `/bin/ps -o pid=,rss= -p <owned-pids>` only for that set;
births are rechecked after the read. Unrelated PIDs are never RSS query inputs.
Exited/reused PIDs are omitted. Double-forked descendants lost before observation,
short-lived spikes, shared pages, GPU/VM/kernel allocations and other host work
remain outside exact accounting. This is sampled evidence, not physical memory
accounting or an OS limit.

Execution receipts include `resource`, `measurement`, and `measurement_attempts`
(one phase per permitted retry inside the same hold). Metrics deliberately stay
separate:

- `sampled_sum_owned_rss_peak_bytes`: maximum sampled sum of owned RSS.
- `per_process_peak_rss` and `individual_peak_rss_bytes`: per-birth process peaks
  and the largest individual peak; summing these peaks is not a family peak.
- `host_available_min_bytes`: Linux `MemAvailable`, or macOS free + inactive +
  speculative pages; purgeable is not added again. Advisory raw-free fallbacks
  are recorded as unavailable, never as this metric.
- `host_available_drawdown_bytes`: first available reading minus the minimum,
  floored at zero. It includes other host work and is not the job's allocation.
- Phase start/end, nominal interval, sample counts, `load1_max`, sampled worker
  settings, missing/changed processes, failure details, and cold/warm notes.
  Worker settings reflect the formula at observation time; individual runners
  choose their own factor at startup. No inference of a transitive CPU cap follows.

`--measurement-notes TEXT` (adapter `measurementNotes`) supplies known cold/warm
context; the default explicitly says it is unknown. Sampling and telemetry-write
failures are retained as `partial-or-unavailable` evidence and do not change
exclusive command results, timeout retries, or cleanup. No memory breach policy
is enabled in this step. A measurement never supplies a review PASS.

Explicit `--result-path` / adapter `executionReceipt` paths retain the existing
receipt contract. The train retains `host-gate.<uuid>.execution.json` next to its existing
host receipt. Each attempt gets a unique sidecar, so a refused retry cannot read
prior execution metadata and prior evidence remains immutable. Direct profiled CLI holders, including `test:release`, automatically
retain unique receipts in `GIT_COMMON_DIR/gate-watchdog/executions/` (or the existing
scratch history override). Git archives without a common directory use
`.test-slot-executions/` inside the snapshot. Each receipt has a sibling
`*.samples.jsonl` telemetry file. `telemetry_file` is relative to the receipt so
it remains locatable after a release's `.partial` directory is renamed; the
absolute `telemetry_path` records its original execution location. Rows include
phase identity, so repeated attempts can be distinguished. Adapter-default
scratch receipts remain temporary; callers needing durable measurements pass
`executionReceipt`. These files do not enter healthy-clock history or the record.

Automatic receipt writes prune managed receipt/telemetry pairs to the newest
**20 per profile id** in that directory, across revisions and bindings. The receipt
being written is always kept. Receipts also retain their holder identity and lock
paths: live or unknown holders and matching live/unknown lock records are
protected even when older than the newest 20. An unfinished receipt is eligible
only after both its wrapper and recorded command group are confirmed gone;
missing command identity retains it. A later write retries pruning after those
holders finish. Files from before this retention schema,
malformed or redirected files, and explicit caller-selected receipts remain
untouched; protected evidence can exceed the normal bound. Pruning is best effort
and cannot change the command result. Only fixed sibling telemetry paths are
eligible for deletion; receipt-provided pointers are never followed.

Telemetry keeps the **last 256 rows per run**, shared across both attempts of a
permitted retry. Each successful write atomically replaces that tail. Aggregate
sample counts, peaks, host minima and failures still cover all observations.
Each measurement's `telemetry` summary records `row_limit`, `rows_observed`,
`rows_retained`, `rows_dropped`, `truncated` and `write_failures`; failed writes
can leave an older tail and are also recorded as sampling failures. A truncated
tail is diagnostic detail, not the full time series. The nominal 2,000 ms sample
interval and admission behavior are unchanged.

Summarize retained execution receipts without launching work:

```sh
node test-slot/summarize.mjs /path/to/*.execution.json
node test-slot/summarize.mjs --margin-bytes=268435456 /path/to/*.execution.json
```

The helper groups by profile/revision, counts runs once across retries, and
reports binding counts and incomplete runs. It invents no margin. With an
explicit chosen margin it labels the result “observed max plus chosen margin,
from N runs; provisional, not a guarantee”. Inspect the individual bindings,
phase notes, missing samples and isolation evidence before adopting any envelope.
Gather the first release and train envelopes on their next necessary runs;
this feature starts no measurement campaign. Shared enablement and coordinated
reader migration belong to the next rollout step.
