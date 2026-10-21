# Dispatch

One foreground command opens or reuses a Git lane, prepares it, records a routed
run, starts a worker, records its agent and pane, arms the existing watcher and
sends the work prompt. Node built-ins only; all record writes use its CLI.

From the project checkout (or with `--repo /path/to/checkout`):

```sh
node /path/to/herdr-monitor/dispatch/dispatch.mjs ENG-71 \
  --org /path/to/.org --lane dispatch --route engineer \
  --brief /absolute/path/to/ask.md --report docs/reports/dispatch.md \
  --to supervisor-herdr
```

`--report` is optional and defaults to the record's per-run report. Relative report
paths resolve inside the selected lane worktree; absolute report paths remain
absolute. Other file flags resolve from the invoking directory; `--repo` chooses
where the lane CLI runs. A successful command prints one JSON object with run, item,
lane, route, harness, model, effort, agent, pane, watcher PID/log and journal path.
Route values come from `lanes/routes.mjs`, never copied by the caller. Dispatch
freezes that request's route configuration for both `record start --route` and
`lane dispatch --route`; retries keep it even if project config changes. Lifecycle
configuration retains its original sources and path resolution.
The frozen snapshot contains routing fields only, including with an explicit
`LANE_CONFIG`. Record briefs resolve archive directories from the run's workspace
through the canonical project's configuration layers unless `LANE_CONFIG` is set.
In that case, only that file, resolved from the invoking directory, supplies the
archive declaration. Relative archive paths resolve from the declaring file,
without adding archive data to the routing snapshot or run metadata.

`--awaited` records `meta.notify=supervisor` on the item before starting work.
Optionally add `--awaited-step 'Cut RC-11'` to record the plan step it unblocks.
After verified promotion and record closure, autopilot sends the supervisor one
short landing line. Routine unmarked landings stay silent. Retry keeps the record
metadata and does not re-arm a notification cleared with `meta.notify=none`;
these flags belong only to a new dispatch request.

`--base REF` opens from that ref and fast-forwards a reused lane only when clean.
It never rebases, pushes, or makes merge commits. `lane prepare` runs for both new
and reused lanes. Git common-directory identity owns the request; no registry
session metadata authorizes any action.

New lanes use `lane open --git-only`, deferring their Herdr workspace until
`lane dispatch` can start the worker in its initial selected tab. This leaves one
agent tab and preserves operator focus. Existing workspaces retain their tabs.

A fix round starts a new run on the same item and lane. The default starts a fresh
worker, on the requested route. To prompt the existing stopped worker, add
`--reuse R-previous --extra 'Read the review and fix its findings.'`. Reuse requires
the same lane, route and declared harness/model/effort, an idle/done worker,
a live matching cwd/pane/workspace, and matching immutable occupant evidence
recorded on the previous run. Older manually dispatched runs without that evidence
need a fresh worker. The session registry is never read to choose or reuse workers.
The previous run must already be reported or abandoned, even when its worker is
idle; an open run cannot share its worker with a new fix round.
Reuse records `meta.continuation_of=R-previous` and `meta.same_session=true`
through `record start --meta`. These are display facts and authorize nothing.
The supervisor may explicitly reuse across items on the same lane under the
same checks; omit `--from-run` across items. Starting a continuation neither
consumes nor resets either item's independent-review count.

Open-run, lane/route/declared-field and newer open-run occupant refusals happen
before lane preparation, run creation or awaited-item writes. Dispatch also
rechecks the occupant immediately before prompting: an older completed run cannot
lend a worker held by a newer unreported, unabandoned run, even if idle or done.
The check uses recorded agent, pane, terminal and effective session identity;
the dispatch's own run is excluded. Failed JSON adds a stable `code` alongside
the unchanged reason: `REUSE_RUN_OPEN`, `REUSE_MISMATCH`,
`FROM_RUN_OTHER_ITEM` or `FROM_RUN_SUPERSEDED` (the reason names later runs).
Workspace and live occupant checks remain late; missing/conflicting/replaced
identity uses `REUSE_IDENTITY_UNKNOWN` only at the initial reuse identity check
when the error has no code. A working occupant or newer open-run holder uses
`REUSE_WORKER_BUSY`. Later transport failures and Node system error codes use
`DISPATCH_FAILED`; existing dispatch-owned codes are preserved. Inspect a late
failure's journal to recover its started run.

Dispatch also caps **unlanded items at 8** per canonical Git common-directory
project. Set `dispatch.max_unlanded` to a positive integer beside
`dispatch.max_sessions` in the existing dispatch configuration. Both use
`loadDiscoveredRoutes` and its current project configuration layers (including
the config home when supplied by that loader); there is no separate cap config
path. The usual `.lane.json` fallback layers and explicit `LANE_CONFIG` apply.
For example, `"dispatch": { "max_sessions": 7, "max_unlanded": 8 }` sets both.

The unlanded count is derived from record events, once per item with a
`run.started` in this project, including manual record starts. A matching
`promotion.reconciled` item/run/head tuple covers that attempt and earlier
attempts; a later run on the item makes it unlanded again. An explicit current
`item.closed` as `dropped` also releases the item; reopening a dropped item
restores its unlanded count. A done report, abandoned run or ordinary closure as
done **does not release it** without a recorded landing. Parked and kept lanes
still count. Items with no run and another project's runs are excluded from the
count; promotion exclusions do not establish a landing. Original start metadata supplies project
identity; legacy runs resolve their workspace through Git. Unavailable legacy
workspace evidence conservatively counts, so deleted worktrees cannot silently
free capacity. No worktree census or display session registry supplies authority.

At or above the cap, only these explicit exceptions dispatch:

- Fix rounds using `--from-run R-previous`, including settle's correction runs
  on the same item/lane. Existing origin and current-run guards still apply.
- Landing follow-ups using `--unblocks ITEM`, naming another unlanded item in
  this project. Dispatch records `record block ITEM --by NEW-ITEM` before run
  creation and records `dispatch_unblocks=ITEM` on the new run. An existing
  dependency alone, a shared lane or `--reuse` alone grants no exception.

These share **3 active exception runs**, including reused workers. Admission at
the cap records `dispatch_unlanded_exception=fix|unblocks` in the original
`run.started` metadata, an admission fact rather than stored status. A report
or explicit abandonment ends that exception's occupancy; it does not itself
land the item. Normal admissions below the cap consume no exception slot.
`DISPATCH_UNLANDED_CAP` refuses ordinary work at the cap or a fourth active
exception. Its message names the current count, cap and unlanded item IDs,
and tells the caller to finish a listed landing or explicitly drop that work;
when exception slots are full it also names the active runs to finish first.
An invalid target uses `DISPATCH_UNBLOCKS_INVALID`.

Early unlanded checks precede lane, run and awaited-item writes. After the open
memory wait and preparation, the authoritative recount and record start share
the session cap's `<git-common-dir>/dispatch-session-cap/` admission lock. The
recorded run durably reserves the item and any exception slot before release,
so concurrent dispatches cannot take the same final slot. Failed/uncertain
launches keep that reservation. A retry without a recorded run checks the
current cap again; recovery of a recorded run consumes no new reservation.
`--unblocks` is saved with the request and cannot be changed on retry. The record
core remains advisory and never refuses a manual start for these caps. BCH's
settle-watch and reconcile do not participate in this policy.

The independent session cap limits new sessions per Git common-directory project
to **7**, matching BCH's `MAX_SESSIONS` default and leaving room for the normal
4–6 concurrent lanes.
Set `dispatch.max_sessions` to a positive integer in the existing `.lane.json`
dispatch settings. The usual parent/repository layers and explicit `LANE_CONFIG`
apply; like other dispatch fields, a later `dispatch` object replaces that object.
Admission reads the current setting again on retry and immediately before launch;
route identity stays frozen separately.

The count covers open bound worker runs (including external `record worker`
launches) and uncertain launches, plus recorded live or uncertain settle
reviewers, deduplicated by immutable native identity. Reported or abandoned workers
are excluded. Recorded settle reviewer sessions from
`.org/retirement/occupants/` also count, including retained live reviewers after
their worker report or review verdict. Repeated evidence for the same native
session/terminal counts once. Other projects are excluded by canonical Git
common-directory identity; the display session registry is never read.
Saved native PID/birth evidence is checked first; older record-only workers use
their matching live native occupant when available. Only ESRCH or a confirmed
birth mismatch frees a session. EPERM, unknown errors, missing native evidence
and uncertain launches count as occupied. Even a definitive Herdr
`agent_not_found` does not prove that the native process exited and cannot free
an otherwise unknown slot. Unreadable capacity files refuse admission. The
refusal names `session cap N reached: R-a, R-b, …`, gives the worker/reviewer
breakdown and separately lists observed-live, unknown-liveness and
uncertain-launch runs. Inspect those uncertain runs and their workers, then use
the existing record abandon command for stale runs. It never kills or closes a
session, or automatically abandons a run. This is a new-worker-dispatch admission
cap, not a host census or a guarantee that the host has at most seven agents.
It never authorizes closing or abandoning anything; cleanup requires the
existing lifecycle authority. Reuse and prompt/watch recovery that create no
new session remain admissible without consuming another session.

Early session admissions are lock-free advisory counts. After both memory gates and
lane/record preparation, the final recount and durable worker launch are
serialized under `<git-common-dir>/dispatch-session-cap/`, so simultaneous
dispatches cannot both take the last slot. Waiting for memory never holds this
lock. Native process observation, record worker, watch and prompt delivery happen
after release. An overlapping launch polls for admission for up to 60 seconds,
scaled by `loadTimeout`, and recounts capacity after acquiring the lock. Only
an exhausted allowance returns the named `locked` retry reason. STOP is checked
while waiting. The lock is installed by renaming a private directory containing
the complete `owner.json` PID and kernel birth identity. A later admission
automatically reclaims it on ESRCH or a confirmed birth mismatch; EPERM, unknown
or invalid owners remain held. Contenders also carry birth identity and serialize
stale cleanup; waiters withdraw theirs before polling again so they cannot hold
each other out. An older owner-less or unreadable-owner directory refuses with
`DISPATCH_SESSION_CAP_LOCK_OWNER_UNREADABLE`, its path, and an instruction to
inspect surviving dispatch processes before manually removing that lock directory
and retrying. Age alone cannot establish safe ownership, so it never clears this
legacy case automatically. Live `--reuse`
continuations and retries that only record a worker, arm watch or deliver the
saved prompt do not add a session and bypass session admission. New reused runs
still require the unlanded admission described above. An explicit `--fresh`
launch still checks capacity, including an uncertain earlier launch.

Settle adds `--from-run R-previous` to bind a correction to its originating run.
Dispatch saves this precondition and passes `--if-current-run` to record start;
it also refuses an already superseded origin before any lane or run side effect.
The event-log transaction refuses creation if a later sibling run exists, the
current outcome belongs to another run, or the item is explicitly closed. A
retry retains the saved origin. `--retry ... --from-run R-previous` may bind an
older journal that lacks the field, or confirm the same origin, but cannot
replace an existing origin. It adds a record precondition, preserving the saved
work request and all route and worker recovery checks.

The generated prompt names the ask, run brief, exact report path and run ID, plus
`--extra` text. Neither input brief is patched or replaced. The worker starts
without a work prompt; the prompt is sent only after its record is complete and
`watch/watch.mjs --detach` has acknowledged startup while holding the run lock.
The watcher uses a log under `.org/dispatch/` and inherits no supervisor pane,
tab or workspace ID. `--to` selects the supervisor; the default is
the adapter's `MONITOR_SUPERVISOR_AGENT`, then `supervisor-herdr`. Project chat
launches bind that variable to ops separately from their `chat-` agent name.
The core stays foreground and never calls a model.
When the immutable pre-prompt receipt has no native session, dispatch pins the
native foreground PID and kernel birth identity before delivery, then observes
for the remainder of one saved delivery deadline (at most 60 seconds). A verified
late session becomes a separate `run.session_bound` event through
`record session-bind --journal FILE`; the launch receipt is never enriched.
Dispatch alone writes this fact. Retirement, reuse, handoff, pane-release and
status derive the same effective identity and reject conflicting evidence.
Unavailable continuity, replacement or timeout leaves the run unbound. Uncertain
delivery requires explicit recovery before binding. An authorized `--resend` or
`--accept-delivered` starts a new bounded window, anchored to the original launch
process and receipt; `prompted_at` records the delivery attempt or confirmation.
An ordinary retry only gets the saved remainder and never replays a prompt.
There is no backfill, background binder or ingestion delay. A saved bind proposal
is never replaced and can recover an exact lost reply even after report ingestion.
An unknown bind reply prints the exact retry command to stderr and returns
`binding.status: "unknown"` with that command in the JSON receipt. Record writes
finish outside the observation timeout and enforce the deadline under the lock.
Folded identity evidence lives in side tables; run objects and historical
completion fingerprints retain their original shape.
Correction and completion notices go through watch's
[shared supervisor input gate](../supervisor/README.md), which journals notices
and waits for two empty-composer reads while the supervisor is idle. Dispatch's
work prompt still targets its own worker; it does not type notices into the
supervisor directly.

## Run timing

Dispatch records entry and grant for its two memory gates (`memory_open` before
lane preparation and `memory_worker` before worker launch), including immediate
grants. The `admission_lock` split records final admission lock acquisition,
including immediate grants, with a 60000 ms allowance scaled by `loadTimeout`.
Reused workers do not acquire that lock and have no sample for it. Project
admission uses a bounded wait for overlapping final launches;
there is no concurrency queue or fleet session limit. Its recovery lock refuses
a second coordinator for the same request; that refusal is not a queue wait.
Lane dispatch skips the redundant memory gate
through `--memory-checked` while still checking canonical STOP.

Memory and process-end timing events live in the dispatch journal's companion
`<request>.json.events.jsonl`, retaining its strict kind list for older readers.
Admission events live separately in `<request>.json.admission.jsonl` and mirror
to the additive `dispatch_admission_waits` run metadata field. Older readers
ignore this companion and field, preserving their memory totals and process end.
Total dispatch wait requires both memory gates and includes admission only when
attempted; an absent acquisition on reuse or a legacy run does not make the total
missing. An attempted acquisition without a grant remains missing.
Watch and dispatch append separate small lines so watch cannot overwrite the
request's live recovery stage. Only timestamp, run id, item id, lane topic, kind
and outcome are serialized; prompts, filesystem paths, screens, errors, memory
probe contents and environment values are excluded. Before a run exists its
journal events have a null run id; after `record start`, dispatch mirrors them
into that run's `dispatch_waits` metadata with its assigned id through `record set`.
Stopped/failed attempts retain their outcome; an unfinished entry is resumed
without replacing its original timestamp. These fields never drive scheduling
or derived status.
Timing writes are best-effort: failures increment the request journal's
`timing_missing` count and dispatch continues with the original wait result or
error. Unavailable measurements count as missing in metrics. Recovery skips
record writes when `dispatch_waits` already matches the journal.

Watch records `process_end` through the same CLI and companion journal when it
decides idle, done or gone is terminal, after startup and idle report grace or
with a valid report. It records that observation before notice delivery. Startup idle,
blocked and unavailable states are excluded. This clock is separate from report
time and is an observed terminal state, not an OS process exit timestamp. A
watcher restart retains the journaled timestamp if a record reply was lost.
If watch observes resumed work, the next terminal decision supersedes the earlier
attempt's process end, including in the companion journal.

Read the run clocks alongside the [train metrics](../promote/README.md):

```sh
node dispatch/metrics.mjs --org /path/to/.org --since 2026-10-08 --json
node promote/metrics.mjs --project /path/to/project --since 2026-10-08 --json
```

Add `--org /path/to/.org` to the train command for both views in one report
(`run_timing` in JSON). Each view keeps its own window basis: batch start for
train receipts, run start for record runs.

The run view counts every record run in its run-start window, including legacy
and manual runs. Per-gate and total waits carry sample and missing counts; missing
or incomplete evidence is null, never zero. Measured zero requires an actual
entry/grant pair at the same timestamp. Resolved stopped/failed attempts count
toward total gate time after a later grant. Process end since run start includes
worker setup and the worker gate, so it is not a worker execution duration.

## External dispatchers

Immediately after starting a worker, before arming watch, an external launcher
records its launch through this foreground command:

```sh
node /path/to/herdr-monitor/dispatch/record-worker.mjs "$RUN" \
  --org /path/to/.org --agent "$AGENT" --pane "$PANE" --cwd "$WORKTREE"
```

Supply the name, pane and checkout from that launch, not a session registry.
When the launch reply supplies them, also pass `--worker-workspace ID`,
`--terminal-id ID` and `--agent-session-id ID`; each must match the live occupant.
The command reads that named Herdr worker directly, verifies its name, pane and
cwd, and requires workspace plus at least one terminal/session identity. It calls
`record worker` with argument arrays to save the same fields as Monitor dispatch:
`agent`, `pane`, `worker_workspace`, `terminal_id`, `agent_session_id`, with cwd
checked against the run's recorded `workspace`. No session registry is read.

The record transaction refuses conflicting existing fields, a settled run
lacking launch evidence, and a worker name assigned to a newer
run. An exact retry writes no event; it cannot add another occupant identity to
an already complete receipt. Partial receipts, including legacy `agent`/`pane`
fields, refuse any completion from the live worker. A failed step leaves the
worker and run intact; inspect them before continuing, and do not arm watch
after a recording failure.
This is a launch step, never a migration/backfill tool for old workers. Historical
tabs without recorded launch evidence stay protected by housekeeping.

## Recovery

Requests and errors live in `.org/dispatch/<request>.json`, separate from the
record's derived item/run status. Started runs point at their journal and carry
milestone and failure notes, so `record show R-n` exposes a partial dispatch.
Open/prepare/base failure leaves a journal but creates no run. Read and retry with:

```sh
node dispatch/dispatch.mjs --org /path/to/.org --status R-n
node dispatch/dispatch.mjs --org /path/to/.org --retry R-n
# Before a run exists, use the printed journal path in place of R-n.
```

Retry uses the saved request. It checks repository ownership and live worker
identity again, preserves the run, and does not replay a completed prompt. A
watcher failure leaves a recorded, unprompted worker; retry arms the watcher and
then prompts that same worker. If a previously acknowledged watcher has stopped,
retry reports that fact and clears its saved PID; another retry re-arms it without
replaying the prompt. A live saved watcher is retained. Watch's per-run lock
refuses duplicate watchers, including one whose acknowledgement was lost.

Some failures cannot be safely retried by guessing:

- A lost `record start` result leaves `starting`. Retry reconciles the item's
  runs against `meta.dispatch_journal` and adopts a single matching run. If none
  exists and the earlier command returned a record refusal (exit 1 with
  `record:` diagnostics), retry starts again using the saved request. A missing
  run after an unknown outcome, or multiple matches, still requires inspection
  and `--recover-run R-n`; dispatch never guesses or creates another run in
  those cases. A committed run's missing brief is restored by `record brief`
  before worker launch.
- Failed/lost worker launch leaves `launching`. Inspect Herdr, then use
  `--adopt AGENT` for the worker that actually started, or `--fresh` to explicitly
  authorize another launch after checking the first attempt. Adoption verifies
  cwd and captures live occupant identity; the caller must confirm that this is
  the worker launched on the frozen route. Dispatch never infers that fact from
  display metadata or guesses from an error string.
- Failed/lost prompt delivery leaves `prompting`. Inspect the worker, then use
  `--accept-delivered` if it landed, or `--resend` if it did not. Both require
  `--retry`; neither is automatic.
- Before any Codex brief delivery, including an authorized resend, dispatch reads
  the worker's visible pane screen. A `Hooks need review` dialog with a
  count of new or changed hooks or trust option, or a counted
  `1 hook needs review before it can run.` message, returns exit 1 with JSON
  `result: "blocked"`, code
  `DISPATCH_HOOK_REVIEW`, the worker/pane, run, journal and a specific fix on
  stderr and in the record note. The diagnostic names the profile from the saved
  launch route, or says the configured default profile when none was explicit.
  Open `/hooks` in that worker session and review the hooks in that profile.
  Dispatch never sends keys or trusts hooks. An unsent request stays at `prompt`;
  ordinary `--retry R-n` sends the saved brief after the operator clears the
  dialog, retaining the same run, worker and live watcher. A screen-read failure
  also leaves the brief unsent. An uncertain earlier delivery stays `prompting`
  and still needs its existing explicit recovery flag.
  This includes the `Hooks` event table with its `⚠` review count and
  `t trust all · enter review · esc close` footer, as captured from Codex 0.160.0.
- A live watcher whose acknowledgement was lost still owns watch's run lock.
  Inspect the log and stop that watcher before re-arming; the module refuses to
  launch a duplicate. Do not remove a live lock.

Dispatch acquires its request lock before reading the retry journal. Unique PID
contenders under `<journal>.locks/` serialize acquisition and stale-owner cleanup
of `<journal>.lock`; a contender never removes another live contender. Concurrent
requests may both refuse and can be retried. Dead-owner files from either phase
are removed safely on retry. Invalid owner files require inspection. Failed
attempts leave workers/worktrees intact for inspection.
Use the existing record abandon and lane close commands when choosing to discard
work; lifecycle safety and archive recovery remain in the lane CLI.

`--org-cli`, `--lane-cli` and `--watch-cli` select executable CLI adapters for
integration tests. Production defaults use sibling modules from the same tree.
Tests use a temporary record and Git repositories, fake Herdr and lane CLIs, and
the real detached watcher; they never launch models or address real panes.

The supervisor's next real dispatch is the canary acceptance step. See
`supervisor/KICKOFF.md`. bch-cloak's script and activated release stay as they are;
a later release-gated switch can replace its script with this command, its record
path, supervisor target, route, brief/report paths and optional base.

Internal response waits adapt to measured machine load; see the
[deadline inventory](../docs/reference/load-deadlines.md) for allowances and preserved safety checks.

Dispatch also [waits for memory pressure to clear](../docs/reference/memory-gate.md)
before opening a lane or launching a worker, retaining the same durable request.
If the canonical project's `.lane/supervisor/STOP` appears during either wait,
dispatch returns `result: stopped` and keeps its current stage. After clearing
STOP, use `--retry` with the returned journal or run to resume that request.
