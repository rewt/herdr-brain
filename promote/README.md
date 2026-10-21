# Promote

Projects may opt in to [declared gates](../docs/contracts/DECLARED-GATES.md) with
`schema: "declared-gates/v1"` in their owner `.lane.validation.json`. The
validation loader returns one captured value/source snapshot to every adapter.
The declaration owns commands, preparation, runners and host gate settings;
`.promote.json` keeps transport and batching policy. Remove competing `validate`,
`validation`, `prepare` and old `gate` declarations before adoption. Environment,
enqueue and saved-job command overrides refuse. No project is adopted by this
implementation.

The project's own supervisor enqueues from its canonical checkout or a linked
worktree under the same identity root. Jobs retain both roots, the declaration,
the exact source head and bound requirements. Drain, resume and integration
recheck these bindings before effects. Markers use `identityRootAt`; no marker
means the default identity. Stable refusals are `PROMOTION_IDENTITY_MISMATCH`,
`PROMOTION_IDENTITY_AMBIGUOUS`, `PROMOTION_PROJECT_MISMATCH` and
`PROMOTION_IDENTITY_BINDING_CHANGED`. These checks stop mistakes. Native sandboxes
remain the hard boundary; Brain does not authenticate native execution identity
on a shared-UID host. Native launch provenance is future plan-7 work.

Declared planners run as literal argv in a private, prepared canonical-base
snapshot, with closed JSON on stdin. Their source, imports and runtime never
come from the lane. Output is `promotion-tests/v2`: whole-file `files` plus
ordered `{runner,args,reason}` steps. `--required-tests` accepts legacy file
strings and typed `{runner,args}` requirements; admission captures each typed
runner definition, toolchain and canonical scope. Batch unions, retries and
bisected subsets retain them. A pattern, changed recipe or renamed invocation
cannot silently replace bound evidence. The mandatory promotion command always
runs first, followed by selected steps and remaining files.

Canonical command sources and their literal policy closure, manifests, locks
and runner configuration are pinned. Candidate edits to those execution inputs
refuse; planner edits remain inspection data. Dynamic source loaders that cannot
separate orchestration from candidate inputs refuse. Preparation checks source
bytes and symlink containment, and hashes installed dependencies. Runtime facts
include executable paths, versions and bytes; locked dependency versions and
bytes participate in receipt identity. Loader/search overrides are scrubbed
from the planner environment.

Planner PATH directories and executable targets are resolved before preparation
and invocation; a target inside any linked lane or candidate refuses. Python
drivers bind every canonical Python source as a conservative import closure;
new or generated local modules, import symlinks and dynamic loaders refuse.
Python module (`-m`) and inline (`-c`) launches refuse with
`DECLARED_PYTHON_FILE_REQUIRED`; declare a driver file instead. Executable
discovery follows the supplied PATH and runner cwd, including relative and empty
PATH entries, with no additional cwd-local `node_modules/.bin` search.
The mandatory command also binds its shell, executable bytes and interpreter
chain. It currently accepts literal simple commands; shell expansion, compound
commands and indirect package-manager recipes refuse when their runtime chain
cannot be resolved. The same restriction applies to planner preparation.

Environment values stay in memory: job snapshots and the literal executor input
retain their digests and re-read only a matching owner declaration. Script
versions come from locked package metadata or content revisions and their
interpreter chain; identifying an opaque driver never runs it with a guessed
`--version` flag. Keep generated caches outside the immutable installed runtime
tree (the Vitest fixture directs them to an ignored project output directory).

One finite attempt deadline covers planner preparation, its 20-second/1-MiB
planning subprocess, candidate preparation and all selected execution. Everything
inherits the host admission and foreground group. The final command carries the
complete serialized selection as one quoted argv value. Receipts retain source,
selection, runtime, limits and command outcomes, including failures. Exact reuse
adds these bindings to the existing core identity without adding exclusions.
Old workers must support the internal `--capabilities` protocol or remain held;
old file-only receipts never cover typed steps. Rollback requires disposition
of outstanding jobs and explicit restoration of a sufficient legacy declaration.
Verified integrated checkpoints recover under their captured declaration before
current admission or host checks. Recovery verifies the original job, literal
gate, log, replayed tree and containment on the captured integration branch;
it retains the execution-identity fences and repeats no project commands.
Final refused members retain their results during mixed-batch recovery; current
declaration admission applies only to members that still need execution.

Settle's observational planning also enters the owner's host admission, retains
its canonical planner/runtime provenance under `promote/planning/`, and runs no
candidate gate. Exact projects must include literal gate environment names in
their existing exact-validation allowlist; a conflict refuses before preparation.

Direct `lane promote` and local promotion-tier shortcuts refuse in declared
mode: enqueue the complete gate. `lane check --cmd COMMAND` remains available
for development evidence. It does not certify an incomplete declared promotion.

Offline acceptance uses scratch projects and optional real tool fixtures. To
exercise pnpm, TypeScript and Vitest without a download, freeze an existing
fixture tool installation with `promote/test/helpers/runtime-artifact.mjs` and
set `DECLARED_GATES_FIXTURE_ARTIFACT` to its tar. The fixture verifies the tar's
canonical SHA-256 before each independent planner/candidate preparation. Missing
fixture input is an explicit skip; Python and Node use available native tools.
Brain's bundle and package manifest gain no npm dependencies.

The remainder describes the unchanged legacy mode.

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
unresolved/declined blocker or overlapping work. Promotion also needs an explicit
`verdict: PASS` in the latest report of every done reviewer-role blocker, which includes a
reviewer-role child of the work, linked or not: a missing
verdict refuses here, although status views still release it, and a verdict other than
PASS holds the work everywhere. An open operator question (role human, linked or not)
under the item or under a reviewer-role item that blocks it refuses promotion.
Dropping a review releases its verdict hold. Unlinking releases it only when the review
is not a child of the work. A question under a review holds until it is answered, even
if that review was dropped; unlinking a review that is not a child of the work also
releases its questions. Batch completion rechecks blockers and open questions
directly; a review recorded after preparation refuses there through the
changed-since-preparation fingerprint. The final check holds the record
lock across the fast-forward, inside the promotion lock. It never writes events
or trusts session metadata. Canonical supervisor STOP also refuses integration.

On success the worker runs the shared retirement planner and executor scoped to
its promoted lane, after record reconciliation. A kept or occupied pane prevents
Git-only worktree removal. Cleanup refusal/failure is retained as
`integrated-but-cleanup-pending` with `cleanup.state: pending`, preserving the
promoted outcome and successful gate. A later `--drain` retries this cleanup
checkpoint only; it never revalidates or reintegrates it. The current keep reason
and close errors remain in the per-job cleanup JSONL.
Unchanged record/request revisions allow at most five cleanup attempts, with
exponential backoff starting at one minute. A new revision resets that budget;
`cleanup.last_refusal`, attempt count and next-attempt time remain visible. The
drain consumes retirement hints once at its foreground start and end.
See [safe retirement](../supervisor/README.md#safe-retirement) for references,
immutable launch identity and the installed `plan|apply` adoption CLI.

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
`{"promotion":"pnpm validate:all-safe"}`. The `.promote.json` committed at the
canonical checkout's HEAD can also declare a `gate` profile; working-tree edits
and untracked copies are ignored, so nothing uncommitted reaches the host. This example matches bch-cloak's existing gate; the
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

The Node file must be committed and contain an exact installed version. The adapter prefixes
`$HOME/.nvm/versions/node/v<VERSION>/bin` to PATH for preparation and the gate,
and verifies that executable's version. Missing pins refuse before building.
`env` supplies literal strings; it cannot redirect host slot paths, supply
slot tokens or set `NODE_OPTIONS`, which would load project code into the host
adapter (gate commands may still set it themselves). Profile preparation follows existing lane preparation in each
scratch candidate, within the admitted execution. Both preparations and the effective profile
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
cleanup. It then starts shared work immediately, recording occupancy (ARCH-34). Only a
declared-exclusive proving profile takes the host test slot. For that class, this order
matches legacy promotion's lock-then-slot order. The external lock uses
`/bin/zsh`'s `zsystem flock` (`fcntl`, not the incompatible `flock(2)` API), keeps
its descriptor through exec, and never deletes the lock file. Projects using
this bridge need `/bin/zsh` with `zsh/system`. `refuse_processes` contains regular
expressions checked against live process commands before waiting for the slot,
again after that wait, and under the Git lock before integration. Unreadable
process evidence refuses. Matching processes are reported and left running.

The wait cap defaults to 7200 seconds and applies separately to the external
lock and any declared-exclusive host slot. Unknown exclusive holders still refuse immediately. The host receipt
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
When the confirmed host timeout interrupts preparation, the queue classifies
that last interrupted attempt as timed out even if cancellation let it save a
preparation refusal first. Earlier completed outcomes remain intact. A signaled
preparation without a host timeout remains an ordinary refusal.
Unconfigured trains start shared immediately; declared-exclusive trains have a
7200-second default host-slot wait;
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

The record CLI guards item-changing writes while a run is pending in this
project's queue, being prepared or gated, or integrated with reconciliation
pending. It reads only the owning Git common directory's queue and
`promotion-train/v1` receipts, including from linked worktrees and explicit
fleet record paths. Protection is queue-backed: it does not scan arbitrary legacy
scratch `prepared.json` manifests. Before retiring a legacy guarded caller, drain,
reconcile or explicitly dispose its remaining prepared batches through that
existing guarded path (the default), or bind them through a supported equivalent
queue protection. Item/run notes and edits, dependency changes, new children,
questions, launch receipts, abandonment, handoffs and pane-release notes are
checked under the record lock before their events are appended. Blockers and
review children that contribute to completion are protected with their member.
The direct pane-release policy writer uses the same guard. Recorded queue
admission holds that lock through its snapshot and queue commit, so a writer
that observed no queued member finishes before the admission boundary.
Refusals exit 3, name the batch or queue job, and direct the writer to an
unguarded parent or supervisor digest until landing and reconciliation finish.

The policy is **fail-closed** for an existing unreadable/invalid queue or train
receipt. Open entries never expire by age: a stale green receipt can still need
reconciliation. A missing queue means there is no queued work; a standalone
record has no Git queue. Terminal refused/timeout jobs are released immediately;
members of a red batch still queued for bisection stay protected. Reconciliation
markers release completed members even before the queue saves its next checkpoint.
Older promoted results without reconciliation metadata release after the item
was closed as done with that run current, after admission when its record sequence
is known. That durable legacy completion remains
effective after reopening or starting follow-up work; an explicit pending
reconciliation still holds its member.

For a named supervisor recovery disposition only, set `ORG_GUARD_OVERRIDE` for
one command, retaining the reason and evidence, to the exact batch ID (or the
job ID while it is pending outside a batch). If a transaction touches multiple
promotions, supply their comma-separated batch/job IDs. The supplied set must
equal the full set of affected promotions; missing or extra IDs refuse. The
override is local to that command: never export it to workers or use it for an
automatic retry. It cannot waive current-run, candidate, review, hold, readiness
or finish checks. A plain-note refresh remains the supported record-only refresh;
other deltas retain their applicable refusals and original evidence. Each
successful override prints a warning to stderr and appends a
`promotion.write-overridden` audit event in the same transaction, with the
command, member IDs, batch/job IDs and Git identity. Unknown/unreadable membership
cannot be overridden this way; inspect and repair the queue first. Older folds
ignore the new audit event.

The existing supervisor-attested `complete-batch` receipt remains authoritative
for its entire validated transaction, including manual recovery and effects on
other queued parents, dependents and review owners. Those jobs retain their own
completion checks. The legacy
completion `close --if-current-run` also works when the queue has persisted a
promoted result for that run and its exact requested head is integrated. Actor
names, note text and the current-run flag alone grant no exemption. Read-only
commands never consult this guard.

`ingest` and watcher ingestion through `ingest`/`sync` remain accepted, including
report proposals: refusing them risks losing a late report. Intake does not
refresh prepared fingerprints or waive readiness checks. A late report that
changes completion inputs therefore holds integration/reconciliation for
inspection through the existing guards, with its immutable report preserved.

A failed velocity note is reported as a warning and does not prevent finished
tab cleanup or lane close. Integration warnings still retain the lane for inspection.
When no record is discovered, the saved result retains
`no record discovered; finished tabs preserved`. This notice is informational:
tabs stay, while Git-only lane removal still requires the shared vacancy guard.
It does not create a cleanup retry. A completed result awaiting delivery resumes
that saved outcome without repeating cleanup or promotion; actual cleanup refusals
continue through the bounded, revision-checked cleanup-only retry path.
Recovery persists a verified lane-head replacement in the current queue member
before invoking cleanup, so the shared reader observes that replacement work
has ended. The older pending results remain historical evidence.

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

#### Change-aware selector shadow

The selector is a separate observation beside the existing gate and additive
planner below. It never supplies a command, environment variable, coverage claim,
pass/fail decision or integration input. Enabling it leaves the declared tier
and supplemental tests unchanged. Using a selector to choose what actually runs
requires a separate validation-selection decision and review.

A project opts in with a committed `.promotion-selector.json`:

```json
{ "schema": "promotion-selector/v1", "adapter": "test/helpers/select-tests.mjs" }
```

The separate declaration preserves the existing validation declaration format.
The train reads the declaration, adapter and its imports from a private snapshot
of the attempt's captured canonical **base** commit. Candidate changes cannot
replace their own observer. New declarations take effect once present in the
canonical base. The adapter is a dependency-free Node module invoked as
`node ADAPTER --select`, with this JSON request on stdin:

```json
{
  "schema": "promotion-selector/v1",
  "root": "/absolute/candidate/worktree",
  "base": "captured base commit",
  "head": "captured candidate commit",
  "changed": [{ "path": "lib/example.mjs", "status": "M" }]
}
```

Changes come from `git diff --name-status -z --no-renames base...head` for the
complete candidate. Renames appear as deletion plus addition. Deleted, renamed,
type-changed or unknown statuses select `full` before invoking the adapter.
The adapter only reads the candidate and returns one JSON object on stdout:
`{"pick":["test/example.test.mjs"],"reason":"affected importers"}` or
`{"pick":"full","reason":"unmapped path"}`. Lists contain unique relative test
file paths (`.test` or `.spec`, JavaScript or TypeScript), at most 10,000 files.
Unknown paths, unmapped modules, package/config files and test helpers select `full`.
Adapter failure, invalid output, missing code or the 20-second planning timeout
are recorded as conservative full fallbacks and never change the gate outcome.

Brain's `test/helpers/select-tests.mjs` computes its map from tracked candidate
sources on every observation, bounded to 10,000 paths and 32 MiB. It follows
static imports and re-exports transitively, handles cycles, and adds conservative
edges for literal dynamic imports, CommonJS requires and `new URL` references.
Root-relative and basename `.mjs`, `.js`, `.cjs` and `.sh` literals also add edges
for spawned CLIs, including `path.join(source, 'lanes/lane.mjs')`, following the
existing additive planner's literal-path rules. These edges are transitive too.
Changed `.test.mjs` files include themselves. Known regular documentation includes
`docs/reviews/**`, Markdown under `docs/` directories and `README.md` files.
These documents contribute zero tests when no test reaches them through literal
paths. Thus a code change plus its unreferenced review record retains the code's subset.
Documents referenced by tests, directly or through helpers, still select full;
explicit relative and repository-relative path literals identify readers. Static
`join`/`resolve` calls with `HERE` or `__dirname` and literal components resolve
against the reader's directory, so `resolve(HERE, '..', 'README.md')` in
`lanes/test/lane.test.mjs` references only `lanes/README.md`. Bare basenames map
globally only to modules and scripts, never to documents. The literal patterns
anchor accepted path suffixes so paths inside template interpolations are found.
Unknown paths, helpers, fixtures, package/config files, other non-module paths,
symlinks and modules without a reachable test select full.
Computed runtime references are outside this static graph; real shadow misses
are evidence for improving the adapter before any switch-on. There is no budget
or file cap that defers part of a static pick.

`train.json` retains `attempt.selector_shadow`: base/head, changed paths, adapter,
pick, reason, and `miss: null` while pending. After validation it adds failing test
files, `outside_pick`, and `miss: true|false`. A subset misses if any observed
failure is outside its pick. A failed gate with an unattributed failure or missing
log conservatively misses for subsets; full covers every file. TAP failure
locations, file crashes, Vitest failures and runner file timeouts are recognized.
The exact gate log (including reused evidence) is compared without changing the
validation receipt. Resumed observations remain in `selector_shadow_history`.

Read saved observations across batches with:

```sh
node promote/shadow.mjs --project /path/to/project
node promote/shadow.mjs --project /path/to/project --json
```

The command reports completed observations, misses, pending observations, full
and subset picks, and errors; it performs no gate execution or record writes.
Counts are shadow evidence, not approval to change validation selection.

#### Existing additive planner

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

`test/helpers/test-durations.json` records tracked whole-file measurements with a
timestamp per file. The default source is the ENG-135 inventory; some rows carry
their own source. The three split lane CLI files have individual R-551 measurements:
214,806 ms for `lanes/test/lane.test.mjs`, 216,864 ms for
`lanes/test/lane-dispatch.test.mjs`, and 177,844 ms for
`lanes/test/lane-review.test.mjs`. Each fits the default 300,000 ms budget alone,
but no pair fits together, and other selected extras can leave too little budget
for even one. Unmeasured files use a conservative 60,000 ms estimate; every plan
row identifies measured or fallback cost and retains the measurement timestamp
when available. Update the tracked inventory from
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
