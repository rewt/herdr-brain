# Release walkthrough

Build the tagged candidate in an isolated machine home, activate it, check the
record and lane launchers, then exercise rollback and restore. Use the release
acceptance gate once per candidate to prove the record, lane, dispatch, watch,
settle, promotion and supervisor contracts with owned scratch records and panes.
See [adoption](../ADOPTING.md) and [acceptance](../../acceptance/README.md).

Harness permissions and identity configurations are native machine settings.
The product creates explicit lanes and launches native harnesses through Herdr.
