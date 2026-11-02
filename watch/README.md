# Watch

`watch.mjs` waits for one org run without inference. Once its worker reaches
`idle`, `done`, or is gone, it re-validates the final report with `org check`
and prompts the supervisor with the run, outcome, headline, check result and
report path. A valid report written while the worker is working, unknown, or
blocked wakes the watcher but is not delivered early; a blocked worker gets a
distinct intermediate notice and remains watched.

It listens to Herdr's blocking `agent wait`, the report and record files, and
the canonical project's `.lane/supervisor/STOP`. A changed claim, abandoned run,
removed record or STOP ends the watcher without another notice. An ingested
report also ends the wait; a stopped worker's valid final report still delivers
the existing final notice. A 30-second record stat and STOP check covers lost
filesystem notifications without restarting Herdr's wait while nothing changes.
Only appended lifecycle events for this run or its item's closure wake the wait;
events for other runs and routine metadata writes advance the byte cursor alone.
A separate timer emits one distinct long-running notice. It never writes
`events.jsonl` or ingests a report.

STOP ends the watcher permanently; clearing STOP does not restart it. After STOP
clears, a supervisor entry cold start re-arms the run. Alternatively, use
`dispatch --retry R-n`: the first retry clears a saved dead watcher and refuses;
the second retry re-arms it without replaying a delivered worker prompt.

It saves its terminal decision as run `process_end` metadata through
`record set`, independently of report time. Initial idle/gone states wait for
startup grace, observed work or a valid report; blocked and unavailable states
are excluded. This happens before notice delivery, after any optional idle report
grace has resolved. A later observed resume to working lets the next terminal
decision supersede the earlier timestamp. Monitor dispatches also retain the event in their companion
dispatch journal. The [run timing view](../dispatch/README.md#run-timing) reports
these clocks and dispatch waits with explicit missing counts.

For new watchers in a candidate containing usage-limit recovery, an idle/done
worker without a report is also inspected through its original native pane.
The last native error is matched against several usage/quota/credit-limit forms;
an unfamiliar stop or unreadable screen stays explicitly unclassified, with
`reset=unknown` in the ordinary no-report notice. Recognition does not treat
quoted earlier errors above later assistant output as a current limit stop.
Recognized usage limits do not produce a clean `process_end` decision. The
watcher keeps its existing run, claim, session, worktree and unlanded source.

`ORG/watch/usage-stops/R-n.json` retains the exact owner/native binding, screen
hash (no screen contents), classification, native absolute reset time or an
explicit unknown-time hold, and recovery phase/reason. Absolute native dates
without a timezone use the host's local timezone; relative or incomplete clocks
remain held. A reset deadline wakes the same watcher within a 30-second safety
interval, plus native/record lookup and quiet-confirmation time. No service or
supervisor turn is required. The existing finite/shared watcher checkpoints that
same deadline; resident watchers retain their own timers and receipts.

After reset, the existing `offerQuiet` adapter confirms the original idle/done
occupant and empty composer before one continuation message. Fresh checks retain
the original claim, dispatch source/Git identity, open current run, ancestor
HOLD, pending question, report-file and STOP/HOLD boundaries. A busy, changed or
unreadable worker receives no input. An intent saved before input survives a
watcher crash: offering, acknowledged, refused and uncertain receipts cannot
offer again until the same worker has actually been observed working. Acknowledged
input is not proof of model consumption; a worker that never resumes stays held
with that reason. The native read-to-input race remains the existing adapter's
boundary. No old watcher, saved runtime, callback or recipient is migrated.
Candidate installation and a real account-limit/reset witness remain with the
line's authorized candidate/soak owner; offline controls do not prove live recovery.

From a Herdr-managed supervisor pane, arm a visible watcher tab with:

```sh
node watch/watch.mjs R-29 --org /path/to/.org --to supervisor-herdr --spawn
```

The installed `supervisor/arm-watch.sh R-29` arms the same visible watcher
using the caller's checkout and discovered record (including fleet mappings).
`--org`, `--cwd` and `--to` explicitly bind another project. The recipient
defaults to the adapter's `MONITOR_SUPERVISOR_AGENT`, then `supervisor-herdr`.
Discovery and that recipient are frozen before launching the watcher child.
`--cwd` also binds the notice's canonical Git identity even when the caller runs
from a different checkout. Routine notices apply the project's autopilot policy
before waiting for supervisor input.

An existing project can use a small wrapper around the activated release:

```sh
RUN=${1:?run required}; shift
exec sh "$HOME/.local/share/herdr-monitor/current/supervisor/arm-watch.sh" "$RUN" \
  --org "$RECORD" \
  --cwd "$PROJECT" --to supervisor-opus \
  --idle-grace 900 "$@" --detach \
  --log "$LOG"
```

Set `PROJECT` to the adopting checkout, `RECORD` to its record directory and
`LOG` to this run's watcher log path. This journals at
`RECORD/supervisor/inbox.log`; it needs no separately
installed notice daemon. `--dry-run` with detached settings validates the run
without starting a child or creating a log. The returned detached receipt can be
retained as `watcher_pid`, `watcher_identity` and `watcher_log` through the record
CLI for native supervisor entry recovery. Explicitly enter that supervisor with
its project, record and `--to supervisor-opus` so recovery retains its recipient
when a legacy run has no dispatch journal. New Monitor dispatches retain `to` in
their dispatch journal. See [the adoption steps](../supervisor/README.md) for
the quiet switch and pending-notice handling.

The tab is labelled `watch R-29`, so the wait is visible in Herdr, and closes
after a stopped worker's valid report is delivered. Without `--spawn`, the
command blocks in the current terminal. A newly armed watcher gives the worker
60 seconds to be seen working before an initial idle or missing agent is treated
as terminal; `--start-grace` changes that window. `--idle-grace` optionally delays
a no-report notice after a previously working agent becomes idle or done, while
still waking immediately for a report, resumed worker or blocked worker. It defaults to zero;
bch-cloak's cutover uses 900 seconds to preserve its current watcher behavior.
`--long-after` changes the default one-hour long-run notice. If an intermediate
notice cannot reach the supervisor, an operator notification is raised and the
watcher continues waiting. Final/gone-worker delivery failure stops the watcher,
while an acknowledged inbox worker retains and delivers the pending notice after
the caller exits. The existing housekeeping tick restarts a dead delivery owner.
Every supervisor prompt uses [the input gate](../supervisor/README.md): idle/done
status and an empty composer on two ANSI reads three seconds apart. Typing,
working, unknown layouts and failed reads queue the notice without touching input
or focus. `SUPERVISOR_INPUT_WAIT_SECONDS` caps waiting (default 7200);
`--inbox FILE` overrides the shared `ORG/supervisor/inbox.log` journal. Re-arming a
completed run adopts its final notice. An intermediate notice durably queued
with an acknowledged owner counts as notified. The long-running event retains
one ID and its original elapsed-minute payload across retries and watcher
restarts, so a busy-composer cap does not schedule another notice. Lost
acknowledgements can replay the same visible `notice-id`; acknowledged notices
are not repeated.

For a detached watcher with a log, use `--detach --log /path/to/R-29.watch.log`
instead of `--spawn`. This returns JSON with run, PID, kernel birth `identity` and log only after the child
has acquired the per-run lock and read its worker/report configuration. Startup
failure exits nonzero with the log path. The child inherits no supervisor pane,
tab or workspace identity. [Dispatch](../dispatch/README.md) uses this acknowledgement
before sending work to its worker; this mode does not create a Herdr tab.
The run lock stores PID and birth too, so a reused PID cannot block re-arming.
Unreadable identities, malformed locks and present legacy PIDs without a birth
require inspection; an absent legacy PID can be recovered.

This module replaces bch-cloak's `notify-watch.sh` after that project switches
over. It takes the proven blocking-wait and direct-prompt mechanics from
`contrib/settle-watch.mjs`, but does not open a model session. That old entrypoint
is kept unchanged only because bch-cloak still calls its path through the installed
release; it is removed last, after bch-cloak's release-gated switch. This watcher is
the only run-lifecycle observer: the Brain capture service and steward were removed,
and a supervisor settles a reported run with `supervisor.mjs handle`.

Internal response waits adapt to measured machine load; see the
[deadline inventory](../docs/reference/load-deadlines.md) for allowances and preserved safety checks.

## Shared project observation (opt-in; no live migration)

An explicitly started project observer can replace resident watchers **for new
ordinary dispatches**. Existing watchers and saved recipients finish unchanged.
No installed plist, pin, hook, running service or saved job is rewritten by this
feature. The canonical project supervisor owns the project choice and holds; the installed line can manage starting/stopping the observer
through its existing native execution path, after the normal installation or
canary authorization. A worker must not activate it on a live consumer.

```sh
# Pinned Node, canonical checkout, adopting project's actual record/transport:
node watch/observer.mjs --repo /project --org /record
node watch/observer.mjs --repo /project --org /record --status
# Once the matching observer is alive, an authorized new ordinary dispatch:
node dispatch/dispatch.mjs ENG-n --repo /project --org /record --lane topic \
  --route engineer --brief ask.md --watch-mode shared
```

The existing watch entry also supports `--shared` in place of `--detach`.
Registration requires the original Brain claim, exact live worker name, pane,
workspace, terminal, native session and checkout, plus a matching project/source/
socket observer with a live kernel birth. It refuses an existing per-run watcher
or callback receipt. The returned shared registration path is recorded as
watcher_shared; watcher_host holds the separate host PID/birth/log. A shared run
has no per-run watcher_pid. The reference proves a durable duty, not subscription
readiness or report acceptance. Retirement inventories an unfinished shared duty
without treating its host as a per-run callback. Supervisor entry reports held or
failed duties to their retained owner instead of inferring health from host liveness. Retries adopt the saved mode and duty. There is no
fallback to a different executor, runtime, watcher or recipient.

The observer reuses `lanes/board/herdr-client.mjs`. It attaches filesystem hints
before catch-up, subscribes to lifecycle facts, then refreshes after subscription
acknowledgement. Events invalidate observations; their payloads never replace an
authoritative snapshot. A hint during refresh forces another refresh. A rejected
pane rejects the entire set; unavailable native state stays unavailable, and a
new acknowledged set is required for readiness. Frame limits, reconnect and
`events_lost` handling belong to the existing adapter. Socket device/inode/times
scope the server generation; this is an observation boundary, not a replay
cursor or a guarantee of continuous native history across a handoff.

Only registrations and selected compact record facts stay resident. At most two
finite original `watch.mjs --step` consumers run concurrently; their original
watcher locks, claims, mutations and inbox remain authoritative. A child carries
no caller pane/session or inherited guard override. It never runs `agent wait`.
Grace clocks and notice dedup state are checkpointed in `watch/steps/R-n.json`.
The registration in `watch/shared/R-n.json` names its consumer, wake facts and
stuck owner. An unfinished duty blocks claim transfer even after report ingestion.
Unknown callback acknowledgements stay with the original inbox owner. A live
finite child survives a host restart; a proven dead child resumes the same duty
and stable notice IDs. A vanished worker (missing or invalid report) completes its finite step after its
original notice is delivered or handed to the durable inbox; genuine consumer
errors stay failed. Pending/refused/uncertain deliveries retain their existing
effect holds. Failed consumers retain a held receipt under
`watch/observer/held/`; restarting the host does not replay them.

| Watcher duty | Consumer and retained evidence |
| --- | --- |
| Exact report validation and report-available hash | Original finite watcher, existing record check and report-available producer |
| Working/unknown report, initial startup and late-report grace | Original watcher state machine, persisted original deadlines |
| Blocked, invalid, no-report, unavailable and long-running notices | Original watcher notices and sequence-bound IDs; long notice retains its original payload |
| Final report and process-end clock | Original watcher, original final notice ID and process-end journal |
| Queued, refused or uncertain input | Existing durable inbox owner and original recipient; no replacement delivery |
| Claim change, abandonment, ingestion and STOP/HOLD | Fresh record/ownership guards before effects; held state and original registrations survive |
| Report-to-review and resource closeout | Existing finite line intake and single record queue-review/guarded closer; observer grants no lifecycle authority |

Shared registration permits an absent session before Codex receives its first
prompt, while agent, pane, workspace, terminal and cwd must already match the
record exactly. The original registration stays immutable. The observer and
finite watcher resolve the effective session from the existing checked
`run.session_bound` fact; a native session alone grants no bound observation or
usage-stop recovery. Closeout also requires that bound session, and any recorded
session conflict or replacement native session retains the original duty.

Each invalid, foreign, changed or unreadable registration holds only its own duty.
The first held receipt and original registration/step files are retained. One stable
exception plan and receipt under watch/observer/exceptions use the existing durable
supervisor inbox and recorded stuck_owner (or project supervisor for unreadable
metadata). Host restart keeps the original notice ID, message and recipient;
refused/uncertain deliveries stay with that inbox owner. Healthy duties still run,
including during startup alongside a bad registration.

One timer waits until the earliest persisted step deadline or the 30-second safety
deadline. Hints and checkpoints recompute it; there is no one-second polling tick.

One named **coarse-safety-reconciliation** runs every 30 seconds. It recovers a
lost final native/file hint even if nothing else happens. Normal operation
targets zero repairs. The detection bound is one safety interval **plus the
measured snapshot/record read and finite-consumer queue/runtime**; native outages,
STOP/HOLD, failed consumers and external input gates are explicit holds, not a
false wall-clock completion promise. The observer records safety repairs,
readiness, RSS, queue and consumer times, and exact claim/occupant/server-bound
completion/state-change counters in `watch/observer/observations.jsonl` for
ENG-1036. Each reconciled row also includes host cpu_usage_us (user/system since
host start), elapsed_ms and reconciliations_per_second. ENG-1036/ENG-1137 soak
owners must compare CPU delta divided by wall-time delta and reconciliation-count
delta divided by wall-time delta for the same busy-record and idle windows, with
run count, note-append rate and finite-consumer queue/runtime recorded separately.
The 3,000-note synthetic RSS witness is not a host CPU or live-soak result; those
measurements remain UNRUN until those owners record them. Cache loss causes reconciliation; it cannot manufacture an effect.

`--once` performs a finite reconciliation for offline/integration use. Project
STOP/HOLD or the observer's own STOP ends a resident host; clearing a marker does
not restart it. SIGTERM/SIGINT drain already owned finite children and release
the singleton host lock. The supervisor retains restart and rollback ownership;
an unknown host/child birth is never reclaimed on age alone. Source landing and
focused tests do not activate this mode or qualify installed/live acceptance.

The installed line can own the observer lifecycle. In the canonical project,
the supervisor selects new ordinary **and queued-review** starts with:

```sh
node /installed/build/bin/org.mjs config set dispatch.watch_mode shared
# Default/off for new starts:
node /installed/build/bin/org.mjs config set dispatch.watch_mode process
```

Use pinned Node 20.19.4 and the project's installed build. The setting lives in
the existing project lane policy (home policy after adoption, `.lane.json` in
legacy projects). Commit a tracked legacy policy before running the line.
Absent means `process`; invalid values hold selection. Each new dispatch saves
its choice. Retrying an existing dispatch retains its saved mode, regardless of
subsequent policy edits. Existing process watchers are never migrated.

Each scheduled line pass with shared mode selected, or pending shared duties,
calls the finite `watch/host.mjs` launcher. It starts only `watch/observer.mjs`,
not another resident manager. A live exact project/source/socket/kernel-birth
receipt is reused. A proven dead host is restarted on the next ordinary pass.
The observer checks the line's own STOP as well as project STOP/HOLD and its own
STOP, and exits when the saved installation changes build. After a supported
install/restart and cleared boundaries, the new installed line starts its host.
Clearing a marker alone never starts a service. A live foreign build/birth is
rechecked without launching over it. A readiness timeout rechecks the original
child for its exact receipt, and a pre-launch install/STOP refusal rechecks on
the next pass. An unknown launch or definite child refusal stays held for
explicit inspection/retry. Original duties,
consumer failures and saved dispatches remain immutable; a build change does
not migrate a prior build's registrations or authorize replay of their consumers.

`SHARED_OBSERVER_HELD` blocks new shared starts before a dispatch is issued and records
its project-supervisor owner, original evidence and next action in
`watch/observer/line-host.json` and the line's effects/diagnostics. The line submits
one stable notice per outage through the existing durable project-supervisor inbox.
Without a recorded supervisor address the role-owned hold keeps that notice ID
pending and queues nothing; subsequent passes recheck the binding. A queued
receipt is recorded as queued, while refused and uncertain delivery stays with
that original notice and is never replayed. A later outage after recovery gets
a new generation and notice. Explicit process selection still allows new process
starts while old shared duties retain their hold and notice. There is no
process-watcher fallback. A registration race after launch retains the original
run/claim/journal and also sends a stable supervisor notice.

After inspecting the original hold and `watch/observer/host.log`, the actual
canonical project supervisor can explicitly reconcile/retry the finite launcher:

```sh
node /installed/build/watch/host.mjs --repo /project --org /record --retry
```

This rechecks native canonical ownership, installed binding and STOP/HOLD. It
never replaces a live unidentified/foreign child. For a dispatch already held
at its original `watch` stage, restore its matching original source observer and
use that dispatch's saved `--retry` command, preserving mode, run and claim.
No new run or launch replay is authorized. The installed canary shared control
selects project policy and drives these real line starts; its command adapter
supplies neither a watch-mode flag nor an observer process. Real Brain installation
and a real line-started shared witness remain supervisor/release work.
