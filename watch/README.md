# Watch

`watch.mjs` waits for one org run without inference, validates the report with
`org check`, and prompts the supervisor with the run, outcome, headline, check
result and report path.

It listens to two signals at once: Herdr's blocking `agent wait` for worker
lifecycle changes and `fs.watch` for the report. A timer emits one distinct
long-running notice; it is not a polling loop. It never writes `events.jsonl`
or ingests a report.

From a Herdr-managed supervisor pane, arm a visible watcher tab with:

```sh
node watch/watch.mjs R-29 --org /path/to/.org --to supervisor-herdr --spawn
```

The tab is labelled `watch R-29`, so the wait is visible in Herdr, and closes
after a valid report is delivered. Without `--spawn`, the command blocks in the
current terminal. `--long-after` changes the default one-hour long-run notice.

This module replaces bch-cloak's `notify-watch.sh` after that project switches
over. It takes the proven blocking-wait and direct-prompt mechanics from
`contrib/settle-watch.mjs`, but does not open a model session. Brain `watch`
still owns the operator queue and screen-result capture; retiring or narrowing
it and the old settle watcher belongs to ENG-64.
