# Settle

From any checkout of the project, after watch's final report notice:

```sh
node /path/to/herdr-monitor/settle/settle.mjs R-123
```

The foreground command discovers the canonical Git project and its record. It
records the worker report, runs `lane check`, gets an independent `lane review`,
and returns one JSON result: `promotable`, `fix_round`, or `escalate`.
It has no dependencies and all record writes use the record CLI.

No project config is required. Routes come from the portable preset when none
is configured. The review route follows the routes module's review selection
policy and the run's declared pool; an independent session is required, not a
different provider. The fix route defaults to the worker's route or `engineer`.
Validation follows the lane CLI's project `validate`, or `npm test` default.
Runtime `.org/` and `.lane/` exclusions use the existing project discovery helper;
settle adds no tracked configuration. A project without a known working check
needs its actual validation configured before it can become promotable.

For a manually dispatched run, supply `--brief FILE`. Runs started by dispatch
recover their original ask from that request. With neither, the item's title,
acceptance and durable history supply the ask. `--repo DIR` selects a project,
`--org DIR` selects a record, and `--to AGENT` names the supervisor watched by a
correction run (default `supervisor-herdr`).

Mechanical checks pin the report bytes, Git common-directory ownership,
registered lane, clean tree, HEAD, base branch and validation. The reviewer gets
the actual report, original ask, acceptance, diff pointer and validation log and
checks material claims against code. A `done` report never substitutes for this
judgment. Already ingested reports use the record's immutable copy; subsequent
edits to the source cannot silently replace it. Report-provided commands are
never executed. Blocked, failed and needs-human reports are recorded and handed
to the supervisor with their substance and recorded outcomes intact, without
guessing a scope decision. Only a done outcome is reopened while review is pending.

The generated review brief explicitly budgets zero build, test, prepare, install
and check commands. Reviewers independently inspect code, Git and the validation
log; they acknowledge inherited validation under Non-claims and claim no fresh
test execution. If an acceptance requirement needs additional evidence or an
execution beyond that budget, the reviewer names it under Unverified for a
supervisor handoff. The brief supplies one exact inherited-validation
acknowledgment that can also appear alone under Unverified; that scoped non-claim
does not prevent readiness. Any additional Unverified entry does.

Settle commits only the validated public review record, after checking the exact
reviewed HEAD and only that dirty path. `promotable` requires PASS, no remaining
unverified claims, clean worktrees, the captured main as an ancestor, and green
validation at the resulting review-record commit. The result names both heads.
It is readiness evidence: project authority and promotion policy are still the
supervisor's judgment. Settle never promotes, pushes, closes worktrees or tidies
panes. An unrebased lane or unresolved record blocker receives an evidence handoff.

NEEDS-WORK, FAIL or red validation produce a correction brief and call dispatch
for a new run on the same item/lane. Immediately before a new launch or incomplete
dispatch retry, settle checks current item closure, blockers and concurrent runs;
an operator drop or new blocker receives a handoff. A completed dispatch receipt
can still be adopted without launching work. A fresh worker is the default. `--reuse`
requests dispatch's existing identity-checked stopped-worker reuse; older runs
without occupant evidence require a fresh worker. Budgets and total runs appear
in the result and remain advisory. There is no automatic send-back cap or loop;
each command handles one landed report. The correction's watcher delivers the
next report for the next settle invocation.

Flags `--review-route ROUTE`, `--fix-route ROUTE`, `--timeout SECONDS` override
defaults. Projects may put `settle` settings in their tracked `.lane.json`:

```json
{
  "settle": {
    "review_route": "review-codex",
    "fix_route": "engineer",
    "reuse": false,
    "timeout": 1800,
    "to": "supervisor-herdr"
  }
}
```

These settings accompany normal lifecycle/routes configuration. Discovery uses
the nearest parent config followed by the canonical repository config; repository
`main` and the whole `settle` object replace parent values when present.
`LANE_CONFIG` selects exactly one file, and command flags override its settings.
The integration branch defaults to `main`. Partial project route configurations
must declare the routes they select. Named routes retain
all model/effort plumbing in the routes and lane modules.

Receipts, report/diff snapshots, logs, correction briefs and compact handoffs
live under the discovered `.org/settle/`. Status remains derived from record
events. A per-repository/lane lock serializes settlement, including stale-owner
cleanup. Repeating a finished invocation returns its saved receipt; repeating a
promotable invocation first checks that its Git evidence is still current, both
the lane and canonical checkout are clean, and record readiness still holds.

```sh
node settle/settle.mjs R-123 --status
node settle/settle.mjs R-123 --retry
```

An incomplete review is never automatically relaunched. Inspect its named agent
and retained private evidence; after it stops, `--retry --review-again` explicitly
starts a different round. Malformed retained evidence can trigger the lane CLI's
prefix collision checks and needs inspection; settle never deletes it. A public
record published during an uncertain result also needs inspection before retry.
An uncertain correction recovers the single matching dispatch journal. Resolve
uncertain launch/delivery using dispatch's documented recovery flags there, then
retry settle; it adopts a completed dispatch without starting another worker.
No matching journal or multiple matches produce a substantive supervisor handoff.

Exit 0 means a clear result was produced (including an escalation); exit 1 means
the operation was interrupted or refused and needs the printed recovery evidence.
CLI adapters `--org-cli`, `--lane-cli`, `--dispatch-cli`, `--watch-cli` are for
integration tests. Offline tests use real Git, record, review schema, validation,
dispatch and watch with scripted Herdr/model transport. No model or live pane is
called. The supervisor's next real report remains the live canary.
