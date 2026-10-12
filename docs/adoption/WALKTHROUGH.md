# Release walkthrough

Build a tagged candidate using `bash herdr/release.sh build TAG`. The archive runs
all offline suites once, then becomes read-only. Activate it, check the `org`,
`record` and `lane` launchers, select a second release and exercise rollback.
Use a scratch `HOME`, `HERDR_MONITOR_HOME` and `HERDR_MONITOR_BIN` for experiments.

The optional `build TAG --live` pass exercises owned scratch records and panes
through record, lanes, dispatch, watch, settle, promotion and supervisor. Run it
only at release preparation. See [adoption](../ADOPTING.md),
[machine releases](../../herdr/README.md) and [acceptance](../../acceptance/README.md).
Harness permissions and identity configurations remain native machine settings.
