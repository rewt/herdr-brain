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

From a Herdr-managed supervisor pane, arm a visible watcher tab with:

```sh
node watch/watch.mjs R-29 --org /path/to/.org --to supervisor-herdr --spawn
```

The tab is labelled `watch R-29`, so the wait is visible in Herdr, and closes
after a stopped worker's valid report is delivered. Without `--spawn`, the
command blocks in the current terminal. A newly armed watcher gives the worker
60 seconds to be seen working before an initial idle or missing agent is treated
as terminal; `--start-grace` changes that window. `--long-after` changes the
default one-hour long-run notice. If an intermediate notice cannot reach the
supervisor after its retries, an operator notification is raised and the watcher
continues waiting; failure to deliver the final report or a gone-worker notice
remains fatal.

This module replaces bch-cloak's `notify-watch.sh` after that project switches
over. It takes the proven blocking-wait and direct-prompt mechanics from the
retired `contrib/settle-watch.mjs`, but does not open a model session. The
supervisor may explicitly open one with `supervisor/settle.sh`; that launcher
does not observe worker lifecycle. Brain `watch` remains separate: it captures
all stopped session screens into the operator queue rather than delivering a
recorded run to a supervisor.
