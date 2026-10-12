# Promote

The supervisor or settle enqueues lanes with one command from any checkout of
any project. No project configuration, record initialization, service installation
or model call is needed:

```sh
node /path/to/herdr-monitor/promote/promote.mjs first-lane second-lane
```

The command durably enqueues the topics, acknowledges a detached worker after
its first queue checkpoint and exits.
Promoted commits accumulate on the integration branch. At a release boundary the
operator builds a tag with the [machine release tool](../herdr/README.md), which
gates the archived snapshot once before activation.
The worker snapshots ready pending requests in FIFO order, then exits when empty. It never waits to accumulate a batch or uses a timer/window. Repeated enqueues of a current or
pending topic reuse its request. Independent enqueues serialize their writes;
exactly one worker owns the drain. A project is its canonical Git common directory,
including calls from linked worktrees. Nothing depends on a project name, remote,
workspace label or session registry.

Queue settings are read once when forming each new batch. A canonical branch
without a commit, or a commit without `.promote.json`, uses defaults. A Git read
failure stops the drain with `PROMOTION_SETTINGS_GIT_FAILED`; invalid committed
settings use `PROMOTION_SETTINGS_INVALID`. `--status` retains the coded `refusal`
and the affected pending request IDs. Requests stay pending in arrival order;
after fixing the cause, retry the drain. A successful settings read clears the
refusal. Captured and interrupted batches keep their original membership.

Compatible requests (same validation override, lane configuration and run-binding mode) form a
batch. `lane promote-batch` holds the existing Git promotion lock, checks clean
canonical and lane worktrees, and stacks the captured lane commits in an owned
scratch branch using native Git rebases. Each replay must equal Git's mechanical
merge tree; conflicts, merge commits and custom external merge drivers refuse
that lane without touching its worktree. Preparation runs in scratch. The
project's promotion tier runs once on the stack, followed immediately by a
local fast-forward to that exact validated commit. An existing green receipt
for the same tree, command and environment is reused. No pushes or merge commits
are created. Settle performs only code/report review and never runs a suite.

A red batch splits into FIFO halves and retries; green halves land, red singleton
lanes remain available for a correction. Each subsequent green half is validated
on the main that already includes earlier landed work. This keeps unrelated
work moving and checks the actual combined tree before every fast-forward.
Bisection depth is logarithmic; total gate executions are not universally
logarithmic. With three lanes and the last lane broken, there are three executions
(one red batch, one green pair, one red singleton). With the first or second lane
broken, ordinary bisection can take five. A universal two-extra-execution bound
cannot also guarantee arbitrary combined-tree validation from exit-code-only
commands; the train preserves the green gate requirement.

Direct `lane promote` retains its single-lane behavior. Direct promotion, train
integration and all lane closures share the Git-common-directory lock. Gates
recheck trees, branches, captured lane tips, STOP and record readiness before
integration. Promoted lane refs adopt only their proved replay after main moves;
post-integration edits preserve the lane with a warning rather than overwriting it.

For reviewed work, bind the request to one exact commit and, when applicable,
its authorized record run. Name any older open attempts with
`--superseded-runs '["R-OLD"]'`; the guarded completion transaction retires only
those explicit attempts after integration. To resume retained batch bookkeeping,
use the supervisor recovery steps in [promotion completion](../supervisor/PROMOTION-COMPLETION.md):

```sh
node promote/promote.mjs topic --expected-head FULL_COMMIT_HASH --if-current-run R-123 --org /record
```

`--expected-head` accepts one lane and a full commit hash. The queue persists it
and the train checks it under the shared promotion lock
before replay and again before integration. A changed tip emits a clear
`refused` notice with both hashes and preserves the lane. A bound head may be replayed onto a moving main in scratch only after the full
merge-tree preservation proof. The original authorization stays bound to
`source_head`; `tip` identifies the proved replay. Supervisor handling checks the
train receipt, green log hash and Git tree/ancestry proof before closing the run.
Preparation cannot replace the captured scratch commit. The final fast-forward
names the validated commit directly, so moving a lane branch cannot redirect it.
Pending requests with different head/run bindings cannot deduplicate each other.

`--if-current-run` requires `--expected-head` and a record. Before promotion and
again after validation, the lane checks that this run has a recorded done report,
belongs to this Git lane, is not superseded and has no changed outcome, closure,
unresolved/declined blocker or overlapping work. A done review blocker whose latest
report carries a verdict other than PASS still holds the work, and an open operator
question under the item (role human, linked or not) refuses promotion; dropping or
unlinking the review, or answering the question, releases it. Batch completion
rechecks both. The final check holds the record
lock across the fast-forward, inside the promotion lock. It never writes events
or trusts session metadata. Canonical supervisor STOP also refuses integration.

On success the worker runs one cleanup pass limited to the promoted lane, with
resume disabled. It discovers the record and uses housekeeping's existing live
occupant, record, Git and topology checks to close eligible finished worker tabs.
It never starts the project-wide housekeeping loop. Missing records, unavailable
Herdr, blocked/open workers and operator chats preserve tabs. Cleanup failures
appear in the outcome. Then `lane close TOPIC --git-only --expected-tip COMMIT`
takes the same promotion lock and rechecks the saved promoted tip, base ancestry
and clean worktree before removing the worktree and merged branch. Contention with a direct gate preserves
the lane and is included in the supervisor outcome as a closure warning. It does
not repeat promotion. Git-only closure preserves the Herdr workspace and its
protected tabs.
Remaining workspace shells/chats stay for the operator. A red gate, dirty lane
or conflicting replay leaves that lane intact and continues with the other
requests. Replay conflicts live only in the train's scratch worktree and are
aborted there; the original lane never acquires a paused rebase.

After every completed attempt, including unknown lanes, refusals and legacy interrupted attempts,
[the shared supervisor input gate](../supervisor/README.md) journals a compact
`[promote-queue]` message before attempting `herdr agent prompt`. The pane must be
idle/done with an empty composer on two ANSI reads three seconds apart. Typing or
unavailable input queues the message and raises a non-focusing Herdr notification.
`SUPERVISOR_INPUT_WAIT_SECONDS` defaults to zero for promotion queue callers,
which return after the independent inbox owner acknowledges delivery ownership.
An explicit value retains a bounded caller wait. The owner uses its existing
confirmation window and busy-input notification policy; capped messages stay in the inbox
with an acknowledged delivery owner, and drain before newer notices when input
clears, even after the queue caller exits. Housekeeping restarts a dead owner.
The queue records delivery and its inbox/notice ID separately from promotion.
An interrupted train delivers an `interrupted` notice for every member, naming
the receipt and log. The queue retains its error and suspended batch for the next
`--drain`; later pending requests continue in the same drain. Each suspended
batch is attempted at most once per drain. Interruption notices keep the original
`promote:REQUEST_ID` notice ID across retries; the eventual outcome uses
`promote:REQUEST_ID:complete`, since the inbox binds each notice ID to exact content.
Refusals and lost acknowledgements retry through the input gate; every prompt
includes the same visible `notice-id`, making at-least-once duplicates recognisable. It never turns an undelivered success into a
new promotion. The declared gate retains its deadlines; optional affected-test extras have the estimated selection budget described below.

Optional overrides:

```sh
node promote/promote.mjs topic --repo /project --to supervisor-project --org /record
node promote/promote.mjs --repo /project --status
```

Tracked `/project/.promote.json` may contain `to`, `delivery_attempts`,
`retry_seconds`, `validate`, `max_batch` and the `gate` profile below. Command flags `--to`, `--delivery-attempts`,
`--retry-seconds`, `--validate` override them. `LANE_VALIDATE` takes precedence over
the promotion config's validation override. `LANE_CONFIG` retains the lane CLI's
explicit config selection. Request overrides are saved per entry, so a subsequent
enqueuer does not inherit the first enqueuer's gate or supervisor. With no gate
override, lane configuration's promotion tier is resolved when promotion runs. `--herdr` and
`--lane-cli` are CLI adapter hooks for isolated tests.

### Existing project gate profile

Set `max_batch` to a positive integer in the tracked canonical `.promote.json`
to cap the number of lanes in each new train batch, for example
`{"max_batch":3}`. Omit it for the default unbounded batch. Extra lanes remain
queued in arrival order and form the next batch after the current one completes;
command/config compatibility can still create smaller batches. The queue reads
the committed canonical configuration at enqueue and before forming each batch,
including invocations from linked worktrees. Untracked files, uncommitted edits
and lane copies cannot override it. Existing and interrupted batches retain their
captured membership when resumed.

Settings Git reads run outside `queue.lock` with a load-aware two-second
allowance for the complete snapshot. Git failures, including timeouts, refuse
with `PROMOTION_SETTINGS_GIT_FAILED`; invalid committed settings refuse with
`PROMOTION_SETTINGS_INVALID`. The queue retains the code, reason and pending
request IDs in `--status`, preserving their order for a later retry. A refusal
after startup sends one queue notice through the first pending request's saved
supervisor recipient and records its delivery receipt alongside the refusal.

Declare the gate command in `.lane.validation.json`, for example
`{"promotion":"pnpm validate:all-safe"}`. A canonical `.promote.json` can also
declare a `gate` profile. This example matches bch-cloak's existing gate; the
train has no project names or package filters built into it:

```json
{
  "max_batch": 3,
  "gate": {
    "node_version_file": ".nvmrc",
    "env": { "BCH_CLOAK_TEST_SLOT_WAIT_SECONDS": "7200" },
    "prepare": [
      {
        "run": "pnpm install --prefer-offline --ignore-scripts --frozen-lockfile"
      },
      {
        "run": "pnpm --filter @bch-cloak/reference-wallet --filter @bch-cloak/wizardconnect-client build"
      }
    ],
    "external_lock": "/private/tmp/bch-cloak-promote.flock",
    "refuse_processes": ["scripts/lane/lane\\.mjs [p]romote(?:\\s|$)"],
    "wait_seconds": 7200
  }
}
```

The Node file must contain an exact installed version. The adapter prefixes
`$HOME/.nvm/versions/node/v<VERSION>/bin` to PATH for preparation and the gate,
and verifies that executable's version. Missing pins refuse before building.
`env` supplies literal strings; it cannot redirect host slot paths or supply
slot tokens. Profile preparation follows existing lane preparation in each
scratch candidate, under the slot. Both preparations and the effective profile
fingerprint salt green evidence; environment values are not written to receipts.

Run dependency installs unconditionally for each scratch candidate. An existing
`node_modules` directory can be stale after a rebase adds packages or changes the
lockfile; an up-to-date install is a fast no-op. `--prefer-offline` reuses cached
packages while allowing missing metadata or tarballs to be fetched, whereas
`--offline` fails when the store lacks them. The optional relative `unless` path
remains supported for preparation whose output stays valid whenever that path
exists; do not use it to guard dependency installs.

The foreground gate adapter first takes the optional external kernel record lock for the train
invocation, including preparation, all bisection gates, integration and scratch
cleanup. It then takes the host test slot for that entire invocation. This order
matches legacy promotion's lock-then-slot order. The external lock uses
`/bin/zsh`'s `zsystem flock` (`fcntl`, not the incompatible `flock(2)` API), keeps
its descriptor through exec, and never deletes the lock file. Projects using
this bridge need `/bin/zsh` with `zsh/system`. `refuse_processes` contains regular
expressions checked against live process commands before waiting for the slot,
again after that wait, and under the Git lock before integration. Unreadable
process evidence refuses. Matching processes are reported and left running.

The wait cap defaults to 7200 seconds and applies separately to the external
lock and host slot. Unknown holders still refuse immediately. The host receipt
`promote/batches/ID/host-gate.json` shows the current phase, Node pin, profile
fingerprint, lock wait and refusal reason; after a slot grant,
`test-slot-wait.json` records the encountered holders, cap and acquisition time.
Waiting and slot refusal create no grant receipt; logs retain wait and refusal
reasons. A capped pre-execution wait produces a per-lane refusal,
preserves main and the lanes, and creates no red gate evidence or bisection.
Explicitly enqueue again after the holder clears. Resuming an interrupted
execution reacquires the guards before using the existing train checkpoints;
a capped wait on a resume retains those checkpoints and stays interrupted,
since the earlier attempt may already have integrated.
Unconfigured trains also wait for the host slot with a 7200-second default;
explicit Monitor or legacy slot wait settings retain precedence.

## Evidence and recovery

Each `promote/batches/ID/train.json` is replaced atomically. Its batch `phase`
shows the current work: `preparing`, `rebasing`, `validating`,
`fast-forwarding`, `closing`, then `complete`. `started_at` is saved when the
queue creates the receipt, before external lock or slot waiting, and stays fixed
across resumes. Direct batch callers save it when the host adapter or train
starts. Older receipts retain their first train invocation clock. The latest attempt's
`gate.command` and `gate.started_at` are saved before validation begins, so a
reader can show the running check and elapsed time while the train blocks.
An unfinished gate has no `exit_code`, `finished_at` or `duration_s`. When the
gate returns, its full validation receipt supplies those fields, including a
red exit. Reused green evidence retains its original clock and `reused: true`.
If validation throws instead of returning evidence, the unfinished clock is
closed with `finished_at`, `duration_s` and `error`, without inventing an exit.
If a command actually ran before making the worktree dirty, its measured receipt
is retained under `gate.execution`; it cannot authorize integration. Each
execution has a unique, exclusively created log. The tree-keyed cache receipt
points to that log, so later red runs cannot overwrite earlier gate output.

Before revalidation, the previous observation moves into `attempt.gate_history`.
The slot's `execution_receipt` records command start and completion independently
of the synchronous train caller. Metrics count those starts, including gates
still running or interrupted, and retain completed gate time alongside
`executed_gate_time_s`, which also includes timed interruptions. Preparation and
slot refusals do not invent executions; reused proofs do not add executions.
Each gate profile keeps completed durations in `time_s` and all measured
execution durations in `executed_time_s`; `gates` counts executions.

Train and metrics receipts retain their v1 schemas; the timing fields are
additive. `train.json` saves the first `slot_granted_at` and, for a declared
external lock, `external_lock_started_at` and `external_lock_granted_at`.
`external_lock_required` distinguishes a known absent lock from old receipts.
Host grant clocks are saved before the train child starts, including a slot
grant followed by a competing-process refusal. Slot wait receipts now include
`acquired_at` (their existing `finished_at` remains readable). Unconfigured
trains retain the validation slot receipt via `gate.slot_receipt` and copy its
grant into the train after validation returns. These grant sidecars live in
`lane-validation/slot-waits/`, keeping them separate from validation receipts
enumerated by existing readers. Each attempt saves `prepare`
start/end clocks around preparation commands and test planning, including
failed preparation; resumed intervals move to `prepare_history`.

`node promote/metrics.mjs --project /project [--json]` exposes `batches[].timing`
and `lanes[].timing`: `queue_wait_s`, `slot_wait_s`, `external_lock_wait_s`,
`prepare_time_s` and `gate_time_s`. Queue wait uses each job's `queued` clock
to batch start; the batch reports its oldest member's wait. Queue wait is unknown
for legacy receipts without `external_lock_required`, since their `started_at`
may follow the external-lock and slot waits. Slot wait is batch
start to first slot grant, as requested, and overlaps external-lock wait;
unconfigured trains also prepare before taking the slot. External-lock wait
uses its own wait start to grant. Preparation sums retained attempt intervals.
In instrumented receipts, attempts that became stale, failed capture, or lost
every lane during rebase before preparation contribute zero; `timing.prepare_skipped`
records their attempt index and reason. A lane with no retained attempts also
contributes zero with a reason. Attempts with preparation or gate evidence still
require complete preparation clocks;
gate time sums executed commands, excluding reused/duplicate evidence and
using execution start/end to exclude slot waits in new receipts. Completed gate
receipts embed `command_started_at` and `command_finished_at` after execution;
running gates expose those clocks through their execution receipt. Existing gate
summary durations keep their original meaning, including possible slot wait
in legacy measurements. Lane costs include shared attempts in full, so summing
lanes would count the same build or gate more than once.

Missing, reversed or incomplete clocks yield `null` (`unknown` in text), never
an invented zero or partial total. Known absent external locks also yield null
with `external_lock_required: false`. `summary.phase_time_s` reports batch
samples and unknown counts; its total is null when no sample exists. Old
receipts remain readable without backfilling grant or preparation clocks.
If the exact synchronous caller dies, its slot wrapper signals the command
group. The direct child's caller watch checks its parent PID and signal-zero
liveness without spawning a process or re-hashing identity helpers per poll.
Nested cancellation signals the held command group once per signal,
preserving the existing group-based orphan protection.

Batch `phase` is display telemetry. The existing attempt `phase` remains the
recovery checkpoint (`prepared` during a running check, `validated` during the
fast-forward, `integrated` during bookkeeping). Readers should use batch
`phase` for current activity and the latest attempt's `gate` for the check.
An unfinished clock never proves a green gate; a resume revalidates the saved
prepared candidate using the existing tree-keyed evidence rules.

`GIT_COMMON_DIR/promote/queue.json` contains pending/current and interrupted batches, results,
notice text, delivery receipts and errors. The directory also contains `worker.log`,
batch receipts, full train logs and per-request cleanup JSONL. Each promoted
result includes `report_at`, `integrated_at` and `report_to_main_s` (null when no
record run was bound). The worker records the same timing through the record
CLI as a run note, so `record show R-n` exposes report-to-main velocity. This keeps a fresh checkout clean without
ignore setup. The record's event log is never written by this module. Queue state
is mechanical bookkeeping, not stored item/run status. Logs/results are retained
without a retention policy.
A failed velocity note is reported as a warning and does not prevent finished
tab cleanup or lane close. Integration warnings still retain the lane for inspection.

`queue.lock` serializes atomic queue replacements; `worker.lock` owns the drain;
`GIT_COMMON_DIR/lane-promote.lock` excludes overlapping gates, fast-forwards and
lane removals. Locks contain an owner PID and command. Crash locks deliberately
fail closed: inspect the saved owner, logs and any surviving validation child before removing only the
stale lock. Never remove a live lock. A worker exit between enqueue and empty
shutdown cannot strand the request: both transitions hold `queue.lock`.

After inspection/removing stale locks, `--drain --repo /project` resumes pending
requests and suspended batches. A current train resumes its saved scratch
candidate and tree-keyed evidence. If main moved without containing the validated
tip, prepared/validated attempts are marked stale and rebuilt from current main. Changed, dirty or stopped lanes are
refused individually before validation; remaining lanes continue. Dirty or
off-main canonical checkouts produce per-member refusals before scratch work.
Interruption before a green fast-forward leaves main untouched. Interruption
after the fast-forward accepts the planned validated tip when it is an ancestor
of main, including after later batches land, and resumes bookkeeping without
repeating the gate or integration.
A batch with some halves already landed retains those green integrations and
resumes its remaining groups. Dirty scratch evidence is retained for inspection.
Legacy single-job receipts still produce an `interrupted` notice and preserve
the lane rather than guessing an external effect; saved freshness never authorizes
replay.
A recorded completed outcome awaiting delivery is delivered without redoing Git.
A confirmed refused job may be explicitly enqueued again; the prior result stays
in the queue history. A completed refusal awaiting delivery does not prevent a
new pending attempt. Supervisor requests use its guarded `promote RUN --retry`
command to preserve the run's acknowledgement history and recheck readiness.
A crash in the message acknowledgement window can cause a duplicate notice with
the same request ID; receivers can deduplicate it. For an exhausted delivery,
the saved `message`, `to`, `delivery_id` and `delivery_error` are the evidence;
the inbox owner retries delivery without re-enqueuing promotion. The saved queue
result describes its original wait window; current delivery is in the inbox journal.

Offline tests in `npm test` use real disposable Git worktrees, the default npm
gate, detached workers and a fake Herdr delivery endpoint. They cover ordered
promotions, dirty/red/conflicting refusals, continuation, concurrent enqueues/direct
promotion, actual crashes during the promoted cleanup checkpoint, legacy recovery,
a direct gate overlapping queued closure, conditional removal checks, duplicate
entries, delivery exhaustion and post-gate mutation. `acceptance/run.mjs` also has
an unconfigured-project queue case using its owned supervisor PTY. That release
harness is separate from offline tests.

Internal response waits adapt to measured machine load; see the
[deadline inventory](../docs/reference/load-deadlines.md) for allowances and preserved safety checks.

Direct and queued promotions [wait for memory pressure to clear](../docs/reference/memory-gate.md)
once before acquiring the promotion lock and starting validation, then finish
the fast-forward without another memory wait. Queued waits are visible in the
job log; they do not produce a refused result.

### Affected test files

A canonical `.lane.validation.json` may declare `promotion_tests`, a relative
path to a dependency-free Node planner. The train calls it with `--plan` and a
JSON array containing the union of paths changed by the captured lanes, including
both sides of renames and deletions, a JSON string naming the effective
promotion command, and a JSON array of bound required test files. Settle and the
train execute the planner and its imports from a private snapshot of the captured
canonical base commit while inspecting the candidate tree. A lane-modified planner
cannot invent coverage or shrink the bound selection.

The planner returns JSON `files` (additional full files), optional `covered`
(files already run in full by the promotion command), optional `graph` bounds,
and optional `selected`, `deferred` and `budget` details. Selected and deferred
rows name the file, reason and estimated milliseconds; deferred rows name
`release-candidate` as their destination. Selection is capped at 512 files and
planning at 20 seconds; invalid or oversized plans refuse integration. The planner
receives `--run` and the selected JSON array after the declared promotion command,
inside the same slot, log and green gate. The command includes the selection, so
cached evidence cannot authorize a different set. `attempt.test_plan` retains
changed paths, required files, selected files, deferred files and reasons, coverage,
command, budget and graph bounds even for a red gate. Deferred extras do not block
promotion; the complete offline suites still run once per release candidate.

This repository's `test/helpers/affected-tests.mjs` considers changed existing
`.test.mjs` files outside whole-file promotion coverage and release files with a
direct reference to a changed module (one hop). It recognizes static imports,
re-exports, literal dynamic imports, `new URL` references and literal launched-script
paths, including conservative basename matches for joined paths. It does not
follow references through intermediate helpers or modules. Computed runtime
references need a literal path/import to enter this static selection.

Optional extras default to a **300,000 ms estimated budget and ten-file cap**.
`MONITOR_PROMOTION_EXTRA_BUDGET_MS` and `MONITOR_PROMOTION_EXTRA_MAX_FILES` accept
positive integers to override those limits. Bound required evidence always runs,
even beyond either limit, and consumes the allowance before optional extras.
Whole-file promotion coverage needs no extra run. Remaining candidates prefer
changed tests, then cheaper direct references, with path order breaking ties.
Files that do not fit are recorded as `time-budget` or `file-cap` deferrals to the
release candidate. Required exceptions carry `bound-required` and
`budget.required_over_budget` in the receipt.

`test/helpers/test-durations.json` records the latest tracked whole-file
measurements from the ENG-135 inventory, with a timestamp per file and a source
path. Its 342,215 ms measurement for `lanes/test/lane.test.mjs` exceeds the default
budget by itself. Unmeasured files use a conservative 60,000 ms estimate; every
row identifies measured or fallback cost and retains the measurement timestamp when available. Update the tracked inventory from
whole-file measurements collected during release preparation, without running
extra suites in a lane. The estimates bound selection rather than impose a new
execution timeout: machine load and changed test behavior can exceed them.

The source scan is bounded to 10,000 paths and 32 MiB; execution uses the release
runner's at-most-four-file suites and existing per-file/suite deadlines. Selected
mixed-tier files are omitted from patterned promotion steps and run once in full.

Settle can defer only entries of the exact form
`- Test evidence not re-executed: path/to/file.test.mjs` under Unverified, with
independent PASS and no other unresolved claims. Full-file coverage must be in
the plan or in recorded re-execution evidence. Required evidence files travel as
`--required-tests` on the bound queue request and bypass the optional-extra caps;
a later plan that omits them refuses before gating or integration. Other Unverified entries retain their escalation.
