# Watch

`watch.mjs` waits for one org run without inference. Once its worker reaches
`idle`, `done`, or is gone, it re-validates the final report with `org check`
and prompts the supervisor with the run, outcome, headline, check result and
report path. A valid report written while the worker is working, unknown, or
blocked wakes the watcher but is not delivered early; a blocked worker gets a
distinct intermediate notice and remains watched.

It listens to two signals at once: Herdr's blocking `agent wait` for worker
lifecycle changes and `fs.watch` for the report. A timer emits one distinct
long-running notice; it is not a polling loop. It never writes `events.jsonl`
or ingests a report.

It saves the first terminal observation as run `process_end` metadata through
`record set`, independently of report time. Initial idle/gone states wait for
startup grace, observed work or a valid report; blocked and unavailable states
are excluded. This happens before final notice delivery and before any optional
idle report grace. Monitor dispatches also retain the event in their companion
dispatch journal. The [run timing view](../dispatch/README.md#run-timing) reports
these clocks and dispatch waits with explicit missing counts.

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
is kept unchanged only because bch-cloak still calls its path in this repository's
canonical checkout; it is removed last, after bch-cloak's release-gated switch. The
supervisor may explicitly open one with `supervisor/settle.sh`; that launcher
does not observe worker lifecycle. Brain `watch` remains separate: it captures
all stopped session screens into the operator queue rather than delivering a
recorded run to a supervisor. Brain's model-free steward now consumes blocked
captures using fleet identity, routes workers through the supervisor inbox, and
escalates blocked supervisors or aged deliveries to a configurable local operator
alert. See [Brain routing and bounds](../brain/README.md#model-free-steward-routing).

Internal response waits adapt to measured machine load; see the
[deadline inventory](../docs/reference/load-deadlines.md) for allowances and preserved safety checks.
