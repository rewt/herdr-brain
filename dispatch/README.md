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

`--serves P-n` names the operator priority this dispatch serves. The record validates
it, keeps it in run metadata and includes the outcome and current rank in the run
brief. Retry preserves the saved selection. Without the flag, `record start`
inherits `meta.serves` from the item or its nearest parent; `--serves=` explicitly
names none. Unaligned work remains visible in Priorities and can still dispatch.
Only the operator adds or re-ranks outcomes (`record priorities`); agents propose
changes with `record priorities propose QUESTION --parent ID --recommend yes --why TEXT`.

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
the same item, lane, route and declared harness/model/effort, an idle/done worker,
a live matching cwd/pane/workspace, and matching immutable occupant evidence
recorded on the previous run. Older manually dispatched runs without that evidence
need a fresh worker. The session registry is never read to choose or reuse workers.
The previous run must already be reported or abandoned, even when its worker is
idle; an open run cannot share its worker with a new fix round.

Settle adds `--from-run R-previous` to bind a correction to its originating run.
Dispatch saves this precondition and passes `--if-current-run` to record start;
the event-log transaction refuses creation if a later sibling run exists, the
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
`supervisor-herdr`. The core stays foreground and never calls a model.
Correction and completion notices go through watch's
[shared supervisor input gate](../supervisor/README.md), which journals notices
and waits for two empty-composer reads while the supervisor is idle. Dispatch's
work prompt still targets its own worker; it does not type notices into the
supervisor directly.

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
