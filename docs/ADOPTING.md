# Adopt Herdr Monitor

Herdr Monitor keeps durable tasks, runs, reports and decisions in a record and
coordinates work in explicit Git lanes. It has no npm dependencies. The record
CLI needs Node.js 20+; lanes need Git 2.38+. Herdr and native Codex or Claude are
needed to launch agents. Native harness settings own permissions and sandboxing.

The canonical supervisor builds a routine runtime update with
`bash herdr/release.sh build TAG --landing-checks` and activates it with
`bash herdr/release.sh activate TAG`, or uses `ship TAG --landing-checks` for the
installed-launcher check and automatic rollback on failure. Routine snapshots
ship on landing checks; full offline coverage and per-candidate live acceptance
are explicitly UNRUN. They cannot qualify for stable adoption or project pins.
Releases live under
`~/.local/share/herdr-monitor/releases`; `current` selects the installed product.
Activation manages three launchers: `org`, its `record` alias, and `lane`.
See [machine releases](../herdr/README.md) for overrides, status and rollback.
For a stable release that BCH adopts, `build TAG --live` retains the full path:
one full final offline coverage obligation, actual live acceptance of that exact
candidate and corrected Majors before stable adoption. Valid completed evidence
is reused; only failed, affected or unrun controls are rerun. Existing
`--coverage FILE` and `--live-coverage FILE` continuations retain their verifiers.
`build TAG` alone runs the full offline path but leaves live acceptance UNRUN.

Run `record status` in a Git project to discover its record, or `record init PATH`
for an explicit record. Register shared records and parent configuration explicitly:

```sh
node /path/to/product/discovery/client.mjs fleet join --record /path/to/.org --worktrees /path/to/lanes --layer /path/to/.lane.json
node /path/to/product/discovery/client.mjs fleet show
```

Create items with `record add`, dispatch through `dispatch/dispatch.mjs` and use
the returned brief and report path. Workers develop and commit in lanes, run the
focused checks their changes need once, self-land with the guarded
`lane promote TOPIC --expected-head-from-worktree` under the current waiver and
write one checked report. Tests, review and reports do not gate main. Watch delivers
the final notice; the line dispatches one asynchronous capped diff/evidence review
through the existing record queue. Findings fix forward; Majors need specific
correction checks before stable adoption. Landing never pushes. Only the
canonical supervisor starts project-wide housekeeping.

Fresh supervisors read `supervisor/supervisor.mjs brief --repo PROJECT`.
Foreground `entry --repo PROJECT --role supervisor` recovers enabled housekeeping
and dead watchers. Project chats use `discovery/client.mjs chat PROJECT --kind
codex --no-focus` and launch native harnesses through Herdr. Cross-identity work
uses [identity desks](../supervisor/PROTOCOL.md#identity-desks), each with its own
record, lanes and reviews.

Legacy chat, entry, always_args, host_suites and tier_suites settings remain
parseable and ignored. Historical release events and `record releases` remain
readable. Current releases are immutable tagged snapshots with explicit routine
or full stable-preparation evidence.
See [lanes](../lanes/README.md), [supervisor](../supervisor/README.md) and
[validation tiers](validation-tiers.md).

An explicitly bound operator chat can [relay priority answers](operator-answer-relay.md)
with the operator's exact words and source context; reserved decisions keep their existing path.
