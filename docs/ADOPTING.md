# Adopt Herdr Monitor

Herdr Monitor keeps durable tasks, runs, reports and decisions in a record and
coordinates work in explicit Git lanes. It has no npm dependencies.

Use Node.js 20+, Git 2.38+, Herdr and native Codex or Claude. Harness settings own
permissions and sandboxing. The bundled non-setuid process reader supports
process birth checks inside harness sandboxes.

Build a tagged local release with `bash herdr/release.sh build TAG`, then have the
operator activate it with `bash herdr/release.sh activate TAG`. Immutable releases
live under `~/.local/share/herdr-monitor/releases`; the `current` link selects the
active product. Activation manages record, org and lane launchers. See
[machine releases](../herdr/README.md) for overrides, rollback and restore.

Run `record status` in a Git project to discover its record, or use `record init
PATH` for an explicit record. To preserve a shared record and parent settings,
register the canonical project explicitly:

```sh
node /path/to/product/discovery/client.mjs fleet join --record /path/to/.org --worktrees /path/to/lanes --layer /path/to/.lane.json
node /path/to/product/discovery/client.mjs fleet show
```

Create work items with `record add`, dispatch with `dispatch/dispatch.mjs`, and
use the returned brief and report path. Workers commit their changes and write
one checked report. Watch delivers the final notice; settle reviews the report
and code, and promotion validates and fast-forwards locally. Nothing pushes.
Only the canonical supervisor starts project-wide housekeeping.

A fresh supervisor reads `supervisor/supervisor.mjs brief --repo PROJECT`.
Foreground `entry --repo PROJECT --role supervisor` refreshes the brief and
recovers enabled housekeeping and dead watchers. Project chats use
`discovery/client.mjs chat PROJECT --kind codex --no-focus`; receipt-bound tabs
launch native harnesses directly through Herdr. See [fleet](../discovery/README.md),
[lanes](../lanes/README.md), [supervisor](../supervisor/README.md) and
[protocol](../supervisor/PROTOCOL.md).

Legacy `.lane.json` chat, entry and always_args settings, validation host_suites
and tier_suites, and fleet temp/excluded_roots keys are ignored. Existing record
mapping and old chat receipts remain usable.

Run focused offline tests while developing in a lane. Promotion runs the merge
checks once per batch; release preparation runs all offline suites once per
candidate. The release acceptance gate runs only at release preparation.
