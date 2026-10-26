# Host test slot

Herdr Monitor supplies a dependency-free foreground command runner with shared
occupancy, optional exclusive proving, process-family measurements and watchdogs.
ARCH-34 records the operator's cross-project rule (2026-10-16): every job,
including gates and releases, starts immediately and shares the machine; only a
real, declared proving step uses the exclusive bridge and publishes a reservation.
Named new-launch gates can pause for that reservation; admitted shared work
continues, so neither free memory nor a quiet machine is guaranteed. Brain does
no proving. Its promotion, release and validation profiles are **SHARED**, even
before measurement. The promote memory gate and integration `lane-promote.lock`
remain unchanged guards.

```sh
node /path/to/herdr-monitor/test-slot/test-slot.mjs run promotion --wait 600 -- npm test
node /path/to/herdr-monitor/test-slot/test-slot.mjs status
```

## Classes and occupancy/v1

A top-level `run` defaults to **shared**, including unprofiled commands from any
project (`resource.reason: unprofiled`). Shared runs acquire no legacy,
compatibility or workspace lock, publish no queue ticket and never poll those
paths. They read holders once only to recognize nesting. They never wait on
occupancy. One top-level record is published beside the selected compat lock
in `<compatPath>.occupancy/`; different concurrent runs have different filenames.
Nested shared runs remain inside the existing command group, take nothing and
publish no second record. A declared-exclusive child of a shared holder is refused
with `TEST_SLOT_PROFILE_REJECTED/75`: nested proving admission is deferred, and
proving must run as its own top-level gate. Never clear inherited tokens to
disguise a shared wrapper. Sampling belongs only to a profiled top-level holder.
`MONITOR_TEST_SLOT_OCCUPANCY_PATH` carries the holder's path to descendants;
nesting still requires a live `occupancy/v1` record. Like the existing slot paths,
it is coordination metadata excluded from validation fingerprints. It avoids a
complete ancestry read when sandbox restrictions deny that read. Without the
inherited path, ancestry/group recognition remains available.

The versioned cross-project record contract is **occupancy/v1**. Its first field
is `"schema": "occupancy/v1"`. Fields are:

- `class: "shared"`, `pid`, nullable `processStart`, nullable `processBirth`;
- nullable `pgid`, `groupStart` and `groupBirth` for the command group;
- `acquiredAt` and `startedAt` (the same ISO time), `project` (the real Git common
  directory, shared by ordinary lanes and promotion scratch worktrees; the cwd
  basename if Git discovery is unavailable), `label` (job label), `cwd` (the
  holder's working directory, matching the legacy holder field) and `host`;
- `reason` (`profiled`, `unprofiled` or a coded profile rejection) and optional `profile_id`.

`project` remains a string in `occupancy/v1`; older records with directory labels
remain readable. Promotion scratch checkouts under `.git/promote/batches/*/scratch-N`
resolve through worktree metadata to their owning project's common directory.

The occupancy project value is resolved from filesystem metadata only: walk to
the `.git` marker, follow a `gitdir:` file and optional `commondir`, then use the
real common directory. Results, including basename fallbacks for uncertain
metadata, are cached per process and cwd. This discovery starts no subprocess.

No command text or token is recorded. Publication writes complete bytes to a
hidden temporary file in the same directory, then renames it atomically; group
updates also use atomic rename. Top-level shared payloads wait behind a start
barrier until their group is published in that record; publication failure
prevents the payload from starting. The owner removes its record after its group is confirmed gone on success,
failure, forwarded INT/TERM/HUP, timeout, spawn failure and exception. A surviving
group retains its record. SIGKILL
cannot run cleanup, so readers apply the stale rule instead. Status is read-only
and includes `occupancy`; the reader can optionally prune confirmed stale rows.

**Liveness:** ESRCH for the owner **and every recorded group** means stale.
EPERM means live (reserved), never unknown. A start-identity mismatch proves an
identity gone only after a successful process-source read; failed `ps` or denied
identity reads cannot make a record stale. Brain uses its existing kernel birth
reader instead of `ps` for that comparison. Nullable starts remain reserved
while the PID/group exists. A dead group leader with surviving group members
reserves the record. Unknown schema versions are skipped and never removed;
malformed or unreadable records are retained. A reader may remove only records
confirmed stale under these rules. Legacy BCH `scripts/test-slot` and old
exclusive-create pollers read only the lock (and, for newer readers, `.queue`);
they ignore `.occupancy/`.
Retirement reads occupancy without pruning. Live and EPERM-reserved records
keep matching lanes and tabs by the same `cwd` and `label` rules used for legacy
holders and queue tickets; confirmed stale records do not keep them.

An exact declared profile with `admission_class: "EXCLUSIVE"` selects the
existing exclusive path. A found declaration that says EXCLUSIVE also stays
exclusive if validation rejects it, so a mis-specified proving step cannot run
shared. That path's legacy lock, FIFO queue, one-token bridge,
admission and conformance behavior remain unchanged. Declare the proving command
in the calling project's `package.json.resources` with the matching script
`command_sha256`, or in `test-slot/validation-resources.json` with the exact shell
command. Use the same stanza fields described below, set `admission_class` to
`EXCLUSIVE`, and wrap the proving step itself. For example:

```json
{"prove":{"id":"project/prove","revision":1,"command":"npm run prove","admission_class":"EXCLUSIVE","M_bytes":null,"C":null,"worker_caps":{},"named_claims":[],"evidence":["project proving declaration"]}}
```

That example belongs in `test-slot/validation-resources.json` and matches
`run proving -- /bin/sh -c 'npm run prove'`. No project-name special case or
shared throttling knob exists. The following lock/queue details apply only to
**declared-exclusive proving**; watchdogs, limits and retries apply to both classes.

The default lock is `/private/tmp/bch-cloak-test-slot.lock` on macOS and
`/tmp/bch-cloak-test-slot.lock` on Linux. It uses bch-cloak ENG-725's holder schema
and UTC/C process start identity, so existing bch-cloak exclusive gates exclude declared-exclusive Monitor
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
New holders write complete lock bytes to a hidden sibling, then publish them by
exclusive hard link before removing their ticket. Readers cannot see a partial
lock record from a participating taker; competing creators cannot overwrite it.
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
stays unchanged. Shared admission writes the same grant sidecar immediately with `class: shared`,
`occupancy_path` and no encountered waits. Declared-exclusive promotion profiles
retain their grant across preparation and the train invocation. The legacy bridge
and configured workspace slot share one deadline, so acquiring the bridge does
not grant a fresh wait allowance for the second lock.

FIFO applies among compatible ticketed exclusive participants. Legacy zero-wait
pollers that ignore tickets can jump the queue; it is not host-wide fairness.

An EXCLUSIVE proving stanza may add `memory_floor_bytes` (safe integer >= 0).
The project owns its floor/margin; `M_bytes` and `reserveGib` do not change.
The compat lock, workspace lock and asynchronous memory wait share one bounded
`--wait` deadline. The reservation is live while waiting, expires at that deadline,
and renews for execution only on a successful floor grant. Low memory at the
deadline returns `TEST_SLOT_MEMORY/75`; an unreadable/invalid sample immediately
returns `TEST_SLOT_HOLDER_UNKNOWN/75`. `--wait 0` samples once without sleeping;
its initial reservation is already expired. INT/TERM/HUP cancel and clean up owned
waiting state with the signal exit status. Fresh ownership/floor confirmation
precedes the grant receipt, group publication and start barrier. An EXCLUSIVE
child of an exclusive holder stays covered without resampling. SHARED with a
floor gets a coded profile rejection and stays shared; invalid floor-bearing
EXCLUSIVE profiles refuse before locking. Ordinary runs never inherit the floor.
Floor calls log the resolved floor, deadline, profile binding and admission result;
their existing bound execution receipts identify command/candidate/runtime.
See [the proving-step contract](../docs/contracts/HOST-RESERVATIONS.md#proving-step-admission).

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

The lane promotion adapter runs with timeout retry disabled, so it
never replays a command chain, including when a leaf declines to retry. Leaf
wrappers and the release gate command may enable `--retry-timeout-under-load`: a
nonzero timeout (exit 124, `ETIMEDOUT`, or the Node test runner's timeout marker)
under measured load above one per available CPU (capacity capped at four) is
re-run once within the same top-level execution (retaining any exclusive hold). The log includes
`TEST_SLOT_TIMEOUT_RETRY` and both attempts. A second timeout counts as failure.
The retry scope is the wrapped command. This project's shared promotion command spans
the whole chain and wraps `test:promotion:core`, the focused
`test:promotion:lanes` and mixed-file `test:promotion:logic` separately, so only
the timed-out step reruns. The complete
former chain (`test:core`, `test:cycle`, `test:lanes`, `test:acceptance`) now runs
in `test:release`, retaining the same bounded leaf retries.
Containing wrappers recognize a child's retry marker and do not retry the chain
again. When a containing wrapper initiates the retry, it passes
`MONITOR_TEST_SLOT_TIMEOUT_RETRIED=1` so descendants cannot add another attempt.
Ordinary failures, signals and exit 75 never retry. The release claim and snapshot
are created once; only its gate command can retry, never preparation or the
release lifecycle. Gate commands must be safe to rerun after a timeout. Watch observations and internal-timeout retry scope are the same for both execution classes.

`npm run test:slot` exercises temporary locks and owned child groups offline;
`npm test` includes it. These tests need kernel process reads and signal access and
run outside the fixture policy that disables detached processes. Other offline
fixtures receive a temporary slot per test file and never take the machine's
real slot. No model calls or live acceptance harness are involved.

Every `run` watches its foreground command. **Zero means no wall-clock cap**:
`limits.wall_seconds` is always `0` with `wall_source: "watch"`. Legacy
`validation.timeout_seconds`, profile `gate.timeout_seconds`, and CLI
`--timeout-seconds` values remain readable but cannot stop a run. Healthy history
never enables a blocking limit. The test runner similarly has no file or suite
wall timer; legacy file/suite timeout options are accepted without enforcement.
Individual tests' own deadlines and product IPC allowances still apply. Load
continues to control file admission through `max(1, floor(4 / loadFactor))`.

When a proof must use a pinned canonical CLI from before watch mode, that outer
adapter still has its legacy 4,500-second default. Give that check invocation
`MONITOR_TEST_SLOT_RELEASE_TIMEOUT_SECONDS=9999999`, its existing compatibility
allowance, and run the candidate's watch gate around the prescribed selection.
The canonical adapter still writes the receipt; the candidate records wall `0`
and retains its silence notice and four-hour inactivity stop. Keep the prescribed
test files, groups and concurrency limits unchanged during this transition.

Output on either stream refreshes the monotonic silence clock. At **900 seconds**
without output, the watcher records one silence observation and enqueues one
`[test-watch]` notice through `supervisor/prompt-supervisor.mjs`'s
`enqueueSupervisor`. The existing supervisor inbox delivery owner drains it;
no model is invoked by the watcher. The train supplies its job's recipient and
record in `MONITOR_GATE_NOTICE_CONTEXT`; other callers use
`MONITOR_SUPERVISOR_AGENT` (default `supervisor-herdr`) and the discovered record.
`idle_timeout_seconds` / `--idle-timeout-seconds` select the observation threshold
(`0` disables the notice). Further silence never repeats the notice or fails the
test. Nested gates and suites inherit the outer watcher, so one run has one
silence notice. A per-run nonce keeps notices distinct even when a caller reuses
its result path; retries share the same nonce and one-notice boundary.

The recommended last resort is **four hours with neither output nor observed
CPU or process activity**. `MONITOR_TEST_SLOT_FROZEN_SECONDS=14400` names this one
setting; the operator may remove the stop with `=0`. It is independent of wall
and notice thresholds. Birth-confirmed owned-group/descendant audits compare
cumulative CPU time, thread scheduling state and process membership at most every
30 seconds. CPU changes, runnable processes, topology/state changes, output, or
an incomplete/unavailable audit prevent the stop and restart the relevant clock.
Unknown CPU evidence never proves a freeze. A confirmed freeze records the
supporting process observations, sends TERM then KILL through the existing
birth-confirmed cleanup path, and exits **124**, without spending a load retry.
Unrelated processes receive no signal. The gate retains existing cleanup and
slot-release safety checks. Slot admission waits retain their existing bounds.
Proving execution reserves the full six-hour host-contract allowance, independent
of its advisory expected end; reaching that reservation expiry never stops tests
or permits a live prover's bridge locks to be taken over.

Execution receipts retain `duration_s`, `longest_silence_s`, `observations` and
`activity_audits`. Silence is persisted when observed, before the run finishes.
File, suite and tier start/finish observations are appended to
`RECEIPT.execution.json.timings.jsonl` and included as `timings` in the completed
execution receipt. Start-only rows preserve evidence of interrupted files;
results and durations are observations, with no stored slow/hung classification.
Gate receipts point to the same sibling journal. Only the owning gate creates a
journal and starts it empty for each run; retries and nested gates append to the
inherited journal. Standalone runners record only when they inherit
`MONITOR_TEST_TIMINGS_PATH`, so ungated developer/fixture runs create no orphan
journals in the Git common directory. Read-only averages:

```sh
node test-slot/timing-averages.mjs /path/to/*.execution.json
```

The helper deduplicates observation IDs and reports file/suite/tier sample
counts, averages and exit results, excluding nested fixture observations. It also
accepts `.timings.jsonl` journals directly. Release snapshot gates retain their
execution receipt and journal under the frozen canonical Git common directory,
outside the immutable release archive. This is intentionally a small receipt reader,
not the held measurement-view design. Automatic receipt retention removes its
fixed timing and telemetry siblings together.

Healthy command observations still live in `GIT_COMMON_DIR/gate-watchdog/`, keyed
by project, tier and declared-command fingerprint, with the last 20 successes
and at most 128 command files. They never set time limits. Tests set
`MONITOR_GATE_HISTORY_ROOT` to scratch in-process and in child environments,
with an inherited `MONITOR_GATE_HISTORY_ORIGIN` token. Their exit guard fails
only for a sample from that test tree in the real repository history; concurrent
writers produce a diagnostic. Linked worktrees share their Git common directory,
so a scratch slot path alone does not isolate history. Tests exercise the frozen
rule with scaled clocks and fixtures, without real multi-minute waits.

## Resource profiles and measurements

Profiles choose shared execution or declared-exclusive proving. There is no
capacity ledger, named-claim enforcement or new exclusive ticket/lock format.
The v1.1 exclusive protocol and token aliases above are unchanged. Measurements
never choose retries, deadlines, cleanup or a validation verdict.

Profiles live with existing recipes: `package.json.resources` binds each named
test script by its JSON-string SHA-256; `test-slot/validation-resources.json` binds
validation commands exactly. Lane validation looks up the command it executes in
that separate file. `.lane.validation.json` retains its pre-profile schema and
bytes so older lane CLIs and installed validators can still read it; it carries
no resource metadata. `gate.resource` in a committed `.promote.json` may
carry a stanza for a project's train; otherwise the train derives its stanza
from a matching validation recipe. Its binding also includes preparation and the
existing gate fingerprint. A configured arbitrary command does not inherit a
nearby profile. If no declaration is found, execution is shared with
`resource.reason: unprofiled`. A found stanza rejected for a stale script digest,
extra arguments or a malformed field keeps EXCLUSIVE if it declares that class;
a rejected SHARED stanza or one with no class runs shared. The runner emits one
`TEST_SLOT_PROFILE_REJECTED` stderr warning naming the profile id and failed
check, and records that coded reason in the execution receipt. Rejection supplies
no valid profile or measurement binding. Validation and train adapters preserve
the declaration and failed check when passing the command to the runner.
The exact valid declaration selects the class and supplies execution evidence.
The synchronous adapter can pass an exact-command `resource`
stanza (`--resource JSON` on the CLI) for an owned recipe.

Brain profiles use revision 2 for the ARCH-34 shared class. Each stanza contains
`id`, `revision`, exact command or script digest,
`admission_class: SHARED` (ordinary work) or `EXCLUSIVE` (proving), `M_bytes: null`, `C: null`, worker caps,
`named_claims: []`, and evidence references. Memory envelopes and transitive
simultaneous CPU-worker demand are **unknown**, awaiting necessary runs. The
helper's `max(1, floor(4/loadFactor))` is a cap on simultaneous **test files**,
not on the threads, subprocesses or CPU workers those files create. Its factor
is `max(1, loadavg()[0] / availableParallelism())`, shared by timeout retry and
worker telemetry. The product's serialized CLI/IPC allowances retain their
separate four-core divisor in `lib/deadline.mjs`. `test:slot`
uses Node's default test-file concurrency instead. The release and promotion
composites include that step. No worker settings are changed by profiling.
Bindings record actual argv, recipe, real cwd, tree (or `.release-commit` in an
archive), Node executable/version, platform, worker declarations and an environment
hash; environment values are not copied into the profile receipt.

Only the foreground top-level profiled holder samples, in either class. Nested receipts say
`nested; sampling owned by top-level holder if profiled` and do not start another
sampler or release the parent's hold. This neutral status also applies when the
top-level holder or the nested command is unprofiled; it does not assert that
sampling happened. Unslotted validation still runs unslotted; its receipt says
`unslotted`. During execution, the owner samples every 2,000 ms and at
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

Execution and grant receipts include `class` and `occupancy_path` for shared work.
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
command results, timeout retries, or cleanup. No memory breach policy
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
interval is unchanged.

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
this feature starts no measurement campaign. Joint proving-step quiet admission belongs to the next rollout step; shared
occupancy itself never gates work.

## Proving reservations and path interop

Declared EXCLUSIVE steps additionally publish `host-reservation/v1` beside compat,
with reason, expected end and mandatory expiry. The payload starts behind a
barrier until both lock records and the reservation contain its group identity.
`--reason TEXT`, `--expected-seconds N` and `--reserve-gib N` supply bounded step
metadata; the default advisory expected end is 75 minutes. Execution expiry uses
the full six hours from acquisition allowed by the shared contract, including
after a memory-floor grant or permitted retry. An overdue estimate remains
blocking until the owned group ends or that contract expiry arrives. Renewals
cannot extend the original six-hour cap; expiry never preempts a running command.
Only launch gates pause for live/unexpired proving; shared/nested `run` and held
promotion re-checks do not read reservations. STOP still cancels launch waits.

Workspace, compat and `--lock-path` reject prover names, known inode aliases,
symlinks and nonregular files with `TEST_SLOT_LOCK_PATH_INVALID`/75 before writes.
Non-default compat must be in owned temporary scratch with no group/other write
(the configured temp root, or macOS's verified OS-reported per-user temp root);
`--lock-path` changes compat too. Readers continue observing both configured
occupancy directories and never prune during display. No default path or
environment name changes. See [the full shared contract](../docs/contracts/HOST-RESERVATIONS.md)
for fields, expiry, release, reader duties and mixed-version behavior. BCH adoption
and schema/location agreement remain subject to independent cross-project review.
