# Settle

From any checkout of the project, after watch's final report notice:

```sh
node /path/to/herdr-monitor/settle/settle.mjs R-123
```

The foreground command discovers the canonical Git project and its record. It
records the worker report, runs `lane check --tier promotion`, gets an independent `lane review`,
and returns one JSON result: `promotable`, `promotable_with_findings`, `fix_round`,
or `escalate`.
It has no dependencies and all record writes use the record CLI.

No project config is required. Routes come from the portable preset when none
is configured. The review route follows the routes module's review selection
policy and the run's declared pool; an independent session is required, not a
different provider. The fix route defaults to the worker's route or `engineer`.
Validation follows the project's declared promotion tier, the legacy `validate`,
or the lane CLI's default. Exact tree/command/environment passes are reused, with
the original log linked in settlement evidence. A changed tree, including the
public review-record commit, gets a new check; an unchanged-tree rebase does not.
Runtime `.org/` and `.lane/` exclusions use the existing project discovery helper;
settle requires no tracked configuration. A project without a known working check
needs its actual validation configured before it can become promotable.

For a manually dispatched run, supply `--brief FILE`. Runs started by dispatch
recover their original ask from that request. With neither, the item's title,
acceptance and durable history supply the ask. `--repo DIR` selects a project,
`--org DIR` selects a record, and `--to AGENT` names the supervisor watched by a
correction run (default `supervisor-herdr`).
That correction's watch delivers through the
[shared supervisor inbox/input gate](../supervisor/README.md), so a fix report
waits durably while the operator composes a message. Settle has no separate
supervisor prompt path.

Mechanical checks pin the report bytes, Git common-directory ownership,
registered lane, clean tree, HEAD, base branch and validation. The reviewer gets
the actual report, original ask, acceptance, diff pointer and validation log and
checks material claims against code. A `done` report never substitutes for this
judgment. Already ingested reports use the record's immutable copy; subsequent
edits to the source cannot silently replace it. After intake, settle confirms
from the record that the requested run is not abandoned and that its recorded
report hash matches the captured report. A successful CLI exit alone is not a
receipt: abandoned intake can skip the report with exit zero. Missing or different
receipts receive a handoff before reopening, validation, review or correction.
Resuming a pending settlement and returning saved readiness repeat this check.
Report-provided commands are
never executed. Blocked, failed and needs-human reports are recorded and handed
to the supervisor with their substance and recorded outcomes intact, without
guessing a scope decision. Settle acts only on the requested run. A later run or
an outcome belonging to another reported run receives a supervisor handoff,
including on retries and saved readiness. Stale, unrecorded reports are retained
as evidence without ingestion, since ingestion would replace the current outcome.
Only that run's own done outcome is reopened while review is pending.
Ingest and reopen use the record CLI's optional `--if-current-run R-n` guard,
checked inside the event-log transaction, so a newer report arriving between the
precheck and either write cannot have its outcome overwritten or cleared.
Correction dispatch saves `--from-run R-n` and passes the same guard to record
start, so a superseding report cannot be cleared by opening a correction run.

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
validation at the resulting review-record commit. When the lane is behind the
captured integration branch, settle prepares a plain rebase in an owned temporary
detached worktree. It compares the replay's full tree with Git's mechanical merge
of the captured lane diff onto that branch, including the review record. Only an
exact match can replace the clean lane head, and validation is obtained for that
rebased tree, reusing an identical prior pass when available. The result retains
the original reviewed commit and includes rebase
heads, expected/actual trees and log evidence. Changes already present upstream
count as preserved; unrelated upstream edits can survive in the same file.
Affected paths using custom merge drivers (including `merge.default`) receive a
handoff before preparation: a successful driver can discard reviewed edits in
both the expected merge and the replay. Settle inspects attributes in the current
lane, captured base/main and every replayed commit, including intermediate trees.
Settle retains the Git 2.38+ minimum: historical attributes are read from an owned
temporary index with `read-tree` and `check-attr --cached`, without the newer
`check-attr --source` option. The real lane index and worktree are untouched by
attribute inspection, and the temporary index is removed after success or refusal.
NUL-delimited Git output is read as raw bytes without trimming; whitespace and
UTF-8 byte-order marks in filenames remain intact. Paths that cannot round-trip
through UTF-8 receive a clear refusal before attribute lookup or replay, rather
than allowing a changed path spelling to bypass the driver check.
Built-in text, binary and union drivers remain available unless custom driver
configuration overrides their names.
The final replacement reserves the saved lane ref with an expected-old-commit
Git transaction while holding the lane's HEAD and index locks. It rechecks branch
identity and clean worktrees under those locks, then checks out the proved tree
through Git's edit-preserving two-tree update. Concurrent commits or branch
switches cause refusal; another branch is never reset. Unexpected interruption
during checkout retains the HEAD/index locks for inspection rather than attempting
an unsafe rollback. A lost response after the completed replacement can still
adopt the exact saved prepared head.
Merge commits requiring linearization, net-tree conflicts, intermediate replay
conflicts and preservation mismatches receive an evidence handoff. Conflicts name
their files or directories, including paths present only in Git's informational
conflict records; ordinary auto-merge notices do not contribute conflict paths.
The reviewed lane remains intact; settle aborts and removes its own
scratch replay, never a rebase in the lane. Unexpected dirty scratch data is kept
for inspection. An interrupted preparation also retains its scratch path; inspect
it before further work. An interrupted lane-head update can adopt only the exact
prepared commit saved in the receipt. The result names both heads.
It is readiness evidence: project authority and promotion policy are still the
supervisor's judgment. Settle never promotes, pushes, closes worktrees or tidies
panes. An unresolved record blocker receives an evidence handoff.

NEEDS-WORK (unless the review-round cap applies), FAIL or red validation produce
a correction brief and call dispatch for a new run on the same item/lane.
Immediately before a new launch or incomplete
dispatch retry, settle checks current item closure, blockers and concurrent runs;
an operator drop or new blocker receives a handoff. Recovery exempts only its
recorded correction run from supersession and overlap checks. If record start
committed but its response was lost, settle identifies the unique run linked to
the matching dispatch journal before these checks. Dispatch then adopts that run
under its own journal lock; settle neither starts a replacement nor edits dispatch's
journal. Multiple linked runs remain uncertain and require inspection. It checks unresolved
blocker links and waiting report outcomes independently of derived active status;
a declined question still blocks, while resolved blockers permit recovery.
A completed dispatch receipt
can still be adopted without launching work. A fresh worker is the default. `--reuse`
requests dispatch's existing identity-checked stopped-worker reuse; older runs
without occupant evidence require a fresh worker. Budgets and total runs appear
in the result and remain advisory. There is no automatic loop;
each command handles one landed report. The correction's watcher delivers the
next report for the next settle invocation.

A review-round cap pauses automatic correction for Moderate/Minor findings.
Set the project default with `settle.review_round_cap` in tracked `.lane.json`,
or record a per-item override with
`record set ENG-123 meta.settle_review_round_cap=3`. `--review-round-cap 3`
on settle (or supervisor `handle`) records the same item override. Item values
win over project defaults; 0 disables the cap, including an inherited project
default. Values must be nonnegative safe integers. With no setting, behaviour
remains unlimited. Each intake snapshots the effective cap and its source;
retries use that snapshot, and future correction runs read the item override.

The current completed review counts toward the cap. Count one completed
independent review per reported run on this item in this Git common-directory
identity, using settle receipts bound to the recorded report hash. Worker starts,
abandoned unreviewed runs and uncertain reviewer retries do not consume rounds.
The result's `review_policy` names the cap, source, round and prior reviewed runs;
the existing `rounds` field remains the advisory total run count. Old pending
receipts without a cap snapshot retain unlimited behaviour.

At or above the cap, NEEDS-WORK with only parsed Moderate/Minor findings returns
`promotable_with_findings` without dispatch. It includes the findings, handoff,
reviewed source commit and head containing the public review record. This still
requires green initial and final validation, no unresolved Unverified entries,
clean worktrees, the captured base as ancestor and current record readiness.
Unparsed findings receive a supervisor handoff. Major findings, FAIL and red
validation retain correction/escalation behaviour regardless of the cap. The cap
and settlement decision are recorded through the record CLI; readiness never
promotes by itself. A missing or lost decision-write response is reconciled on
retry against the exact recorded note, without repeating review or dispatch.

After inspecting the findings and project authority, the supervisor can file
follow-ups and `promote RUN --accept-findings --why REASON --role supervisor`,
which records the accepted findings and queues the exact settled head. Or use
`handle RUN --retry --fix-findings --role supervisor` to dispatch one more
correction without repeating review. Direct settle also supports
`RUN --retry --fix-findings`. This explicit choice retains the capped result in
the journal, records the correction decision, and respects current report/head,
record, blocker and STOP checks. Repeating it adopts the saved correction receipt.

The canonical `.lane/supervisor/STOP` is checked immediately before correction
dispatch and incomplete-dispatch retry, even if it appeared during review. A stop
returns `stopped` with a compact handoff and keeps the fix/dispatching stage,
review and correction brief resumable. After clearing STOP, use `--retry`; no
review is repeated and a completed dispatch may be adopted without another launch.

Flags `--review-route ROUTE`, `--fix-route ROUTE`, `--timeout SECONDS` override
defaults. Projects may put `settle` settings in their tracked `.lane.json`:

```json
{
  "settle": {
    "review_route": "review-codex",
    "fix_route": "engineer",
    "reuse": false,
    "timeout": 1800,
    "review_round_cap": 3,
    "to": "supervisor-herdr"
  }
}
```

Inspect and edit these settings through the validating record CLI or console's
Desks screen (`S`):

```sh
record desks --json
record desks set --review-route review-codex --review-round-cap 3 --timeout 1800
record desks set --unset review_route
```

Writes target the canonical Git project's tracked `.lane.json`, ignore ambient
`LANE_CONFIG` launch overrides, preserve lifecycle and other effective desk fields,
and share the route editor's lock. `--expect REV` rejects a stale reviewed edit,
including changed parent settings. Clearing a field uses the built-in fallback;
a project desk object replaces the whole inherited desk object. The console
shows item-cap/command precedence and the existing-receipt snapshot boundary.

These settings can stand alone; a project with only settle or lifecycle settings
uses the portable route preset for review. Settle captures the effective routing
fields at intake and passes that snapshot to `lane review --route-config`, keeping
lifecycle settings and their relative path provenance in the original config files.
Discovery uses
the nearest parent config followed by the canonical repository config; repository
`main` and the whole `settle` object replace parent values when present.
`LANE_CONFIG` selects exactly one file, and command flags override its settings.
At intake its path resolves from the invoking directory to an absolute path. All
children and retries use that saved selection, regardless of their working directory
or a changed ambient `LANE_CONFIG`. When absent, the receipt retains discovery even
if a later invocation sets `LANE_CONFIG`.
The integration branch defaults to `main`. Partial project route configurations
must declare the routes they select. Named routes retain
all model/effort plumbing in the routes and lane modules.

Receipts, report/diff snapshots, logs, correction briefs and compact handoffs
live under the discovered `.org/settle/`. Status remains derived from record
events. A per-repository/lane lock serializes settlement, including stale-owner
cleanup. Repeating a finished invocation returns its saved receipt; repeating a
promotable or promotable-with-findings invocation first checks that its Git
evidence is still current, both the lane and canonical checkout are clean, and
record readiness still holds.

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
