# Adopt Herdr Monitor

Herdr Monitor keeps durable tasks, runs, reports and decisions in a record and
coordinates work in explicit Git lanes. It has no npm dependencies. The record
CLI needs Node.js 20+; lanes need Git 2.38+. Herdr and native Codex or Claude are
needed to launch agents. Native harness settings own permissions and sandboxing.

Build a tagged local release with `bash herdr/release.sh build TAG`. This runs
all offline suites in the archive before making it immutable. The operator then
activates it with `bash herdr/release.sh activate TAG`. Releases live under
`~/.local/share/herdr-monitor/releases`; `current` selects the installed product.
Activation manages three launchers: `org`, its `record` alias, and `lane`.
See [machine releases](../herdr/README.md) for overrides, status and rollback.
The optional `build TAG --live` acceptance pass belongs to release preparation.

Run `record status` in a Git project to discover its record, or `record init PATH`
for an explicit record. Register shared records and parent configuration explicitly:

```sh
node /path/to/product/discovery/client.mjs fleet join --record /path/to/.org --worktrees /path/to/lanes --layer /path/to/.lane.json
node /path/to/product/discovery/client.mjs fleet show
```

Create items with `record add`, dispatch through `dispatch/dispatch.mjs` and use
the returned brief and report path. Workers develop and commit in lanes, run the
focused checks their changes need, and write one checked report. Watch delivers
the final notice; settle reviews the report and code. The merge train rebases,
validates the batch once and fast-forwards locally. It never pushes. Only the
canonical supervisor starts project-wide housekeeping.

Fresh supervisors read `supervisor/supervisor.mjs brief --repo PROJECT`.
Foreground `entry --repo PROJECT --role supervisor` recovers enabled housekeeping
and dead watchers. Project chats use `discovery/client.mjs chat PROJECT --kind
codex --no-focus` and launch native harnesses through Herdr. Cross-identity work
uses [identity desks](../supervisor/PROTOCOL.md#identity-desks), each with its own
record, lanes and reviews.

Legacy chat, entry, always_args, host_suites and tier_suites settings remain
parseable and ignored. Historical release events and `record releases` remain
readable. Current releases are plain tagged snapshots with an offline gate.
See [lanes](../lanes/README.md), [supervisor](../supervisor/README.md) and
[validation tiers](validation-tiers.md).

An explicitly bound operator chat can [relay priority answers](operator-answer-relay.md)
with the operator's exact words and source context; reserved decisions keep their existing path.
