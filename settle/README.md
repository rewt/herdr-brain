# Settle

From any checkout of the project, after watch's final report notice:

```sh
node /path/to/herdr-monitor/settle/settle.mjs R-123
```

The foreground command discovers the canonical Git project and its record. It
records the worker report, gets an independent `lane review` without running a suite,
and returns one JSON result: `promotable`, `promotable_with_findings`, `fix_round`,
or `escalate`.
It has no dependencies and all record writes use the record CLI.

No project config is required. Routes come from the portable preset when none
is configured. The review route follows the routes module's review selection
policy and the run's declared pool; an independent session is required, not a
different provider. The fix route defaults to the worker's route or `engineer`.
The promotion queue runs the project's promotion tier on the integration batch,
immediately before main moves. Settle copies a matching worker receipt's entire
log into its evidence, including the TAP totals at the end. Missing or stale
worker validation is explicitly deferred to that batch gate. `validation.executed`
is false; inherited `exit_code` can be null. It does not authorize integration.
Runtime `.org/` and `.lane/` exclusions use the existing project discovery helper;
settle requires no tracked configuration. A project needs a working promotion
command before its reviewed code can land.

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
registered lane, clean tree, HEAD and base branch. The reviewer gets
the actual report, original ask, acceptance, diff pointer and validation log and
checks material claims against code. A `done` report never substitutes for this
judgment. Already ingested reports use the record's immutable copy; subsequent
edits to the source cannot silently replace it. After intake, settle confirms
from the record that the requested run is not abandoned and that its recorded
report hash matches the captured report. A successful CLI exit alone is not a
receipt: abandoned intake can skip the report with exit zero. Missing or different
receipts receive a handoff before reopening, review or correction.
Resuming a pending settlement and returning saved readiness repeat this check.
Review briefs include the captured report path, immutable ingested path, SHA-256
and passed ingest validation result. Ingest uses the same report validation as
`record check`. Settle rechecks the supplied and ingested bytes against that hash
before review and before deciding readiness. This verifies report validity;
historical command execution and commit timing remain independent claims.
Report-provided commands are
never executed. Blocked, failed and needs-human reports are recorded and handed
to the supervisor with their substance and recorded outcomes intact, without
guessing a scope decision. Settle acts only on the requested run. A later run or
an outcome belonging to another reported run receives a supervisor handoff,
including on retries and saved readiness. Stale, unrecorded reports are retained
as evidence without ingestion. Direct record ingestion retains older reports and
marks them late when a newer started run already has a report; the newest reported
run owns the outcome. Saved outcome-owner refusals from older folds are rechecked
on the next invocation or retry, with the same report, identity, tree and actual
run supersession checks before review resumes.
Only that run's own done outcome is reopened while review is pending.

Before launching a reviewer, settle checks delivered-commit claims in the report's
`artifacts` against the originally captured `mainHead..head` and saves a
`brain.review-scope/v1` receipt as `review_scope` in its result and any scope
handoff. Use `Commit: SHA`, `HEAD: SHA`, `Branch head: SHA`, or a bare SHA
(optionally `on lane/topic`) for delivery claims.
An outside or unresolved claim escalates with `named-commit-outside-range` or
`named-commit-unresolved`. Bases, tested implementations, earlier rounds, quoted
commands, paths and prose remain informational; HEAD is bound mechanically and
need not be named. Settle's proved rebases preserve this original delivery scope,
including claims naming the worker's original commit; independent review binds
the replayed head. External lane changes still fail the HEAD and clean checks.
The [review desk and scope contract](../docs/contracts/review-desk-and-scope.md)
records the BCH mapping and the parity/activation work still required.

Ingest and reopen use the record CLI's optional `--if-current-run R-n` guard,
checked inside the event-log transaction, so a newer report arriving between the
precheck and either write cannot have its outcome overwritten or cleared.
Correction dispatch saves `--from-run R-n` and passes the same guard to record
start, so a superseding report cannot be cleared by opening a correction run.

The generated review brief explicitly budgets zero build, test, prepare, install
and check commands. Reviewers independently inspect code, Git and the validation
log; they acknowledge inherited validation under Non-claims and claim no fresh
test execution. Deferred promotion CI is a non-claim. If an acceptance requirement
lacks code or report evidence, the reviewer names it under Unverified for a
supervisor handoff. The brief supplies one exact inherited-validation
acknowledgment that can also appear alone under Unverified; that scoped non-claim
does not prevent readiness. A whole `- Report record-check validation not independently executed.`
entry is also discharged by a matching ingest receipt. The legacy whole entry
about the report's `record check` lacking an in-repository receipt is recognized
exactly as defined in [report-evidence.mjs](report-evidence.mjs) and receives the
same treatment for its validation uncertainty. Added claims and
other non-test entries still require a handoff. Scoped `- Test evidence not re-executed: path/to/file.test.mjs`
entries in a PASS review with no findings follow the bound promotion path when
the promotion test plan or recorded full-file re-execution covers every file.
The independent review remains unchanged in the public record; the settlement
receipt carries `report_ingest` separately from deferred test evidence.

Settle commits only the validated public review record, after checking the exact
reviewed HEAD and only that dirty path. `promotable` requires PASS, no remaining
unverified claims, clean worktrees and the captured main as an ancestor. The
promotion queue obtains green validation at the stacked integration tree.
When the lane is behind the
captured integration branch, settle prepares a plain rebase in an owned temporary
detached worktree. It compares the replay's full tree with Git's mechanical merge
of the captured lane diff onto that branch, including the review record. Only an
exact match can replace the clean lane head. The result retains
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

NEEDS-WORK (unless the review-round cap applies) or FAIL produce
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
a declined question still blocks, and so does a done review whose latest verdict is
not PASS, while resolved blockers permit recovery.
A completed dispatch receipt
can still be adopted without launching work. A fresh worker is the default. `--reuse`
requests dispatch's existing identity-checked stopped-worker reuse on the same
route. If `fix_route` differs from the worker's route, settle starts a fresh
worker and records `reuse_skipped: "route_changed"`; older runs
without occupant evidence require a fresh worker. Budgets and total runs appear
in the result and remain advisory. There is no automatic loop;
each command handles one landed report. The correction's watcher delivers the
next report for the next settle invocation.

A review-round cap pauses automatic correction at every severity.
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
requires no unresolved Unverified entries,
clean worktrees, the captured base as ancestor and current record readiness.
Unparsed findings receive a supervisor handoff. At or above the cap, Major
findings or FAIL return `escalate` with `code: "REVIEW_CAP_REACHED"` and a handoff,
without dispatching another correction. Red batch validation is
isolated by the promotion queue and handed to the supervisor for correction. The cap
and settlement decision are recorded through the record CLI; readiness never
promotes by itself. A missing or lost decision-write response is reconciled on
retry against the exact recorded note, without repeating review or dispatch.

After inspecting the findings and project authority, the supervisor can file
follow-ups and `promote RUN --accept-findings --why REASON --role supervisor`,
which records the accepted findings and queues the exact settled head. Or use
`handle RUN --retry --fix-findings --role supervisor` to dispatch one more
correction without repeating review. The same command accepts a saved
`REVIEW_CAP_REACHED` escalation; Major or FAIL cannot be accepted for promotion.
Direct settle also supports
`RUN --retry --fix-findings`. This explicit choice retains the capped result in
the journal, records the correction decision, and respects current report/head,
record, blocker and STOP checks. Repeating it adopts the saved correction receipt.

The canonical `.lane/supervisor/STOP` is checked immediately before correction
dispatch and incomplete-dispatch retry, even if it appeared during review. A stop
returns `stopped` with a compact handoff and keeps the fix/dispatching stage,
review and correction brief resumable. After clearing STOP, use `--retry`; no
review is repeated and a completed dispatch may be adopted without another launch.

BCH's two automatic fix rounds correspond to review cap **3**, since the first
review counts. Scope continuations and narrow same-session corrections do not
consume a review round or reset the count. The full rules and BCH cutover fields
are in [the continuation and revision-cap contract](../docs/contracts/CONTINUATION-AND-REVISION-CAP.md).

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

An escalation caused only by record readiness (an overlapping open run, item
closure or unresolved blockers) saves its originating stage as `resume_stage`.
After that precondition clears, `--retry` or a fresh handle resumes that stage
under the saved request and rechecks project/lane identity, the captured report,
supersession and current readiness. Existing completed readiness refusals also
recover: retained review and dispatch receipts select the continuation, so a
finished review is not repeated and an existing correction is not dispatched
again. Replay conflicts, changed report evidence, superseded runs and unresolved
review claims remain terminal escalations. Recovery never overrides a blocker.

An incomplete review is never automatically relaunched. Inspect its named agent
and retained private evidence; after it stops, `--retry --review-again` explicitly
starts a different round. Malformed retained evidence can trigger the lane CLI's
prefix collision checks and needs inspection; settle never deletes it. A public
record published during an uncertain result also needs inspection before retry.
If a base check finds main moved during a pending settlement, settle makes one
automatic recapture attempt per run. It saves `automaticBaseRetry` in the journal
before recovery, including the observed old/new base, stage and time, and pins
that new target so a second move cannot be silently recaptured. Recovery uses the
same identity, head, report and current-run checks as explicit `--retry`, and the
review-round cap stays unchanged. A second move, conflict or any other refusal
still produces the usual handoff. Interrupted or already prepared replays retain
their existing inspection and explicit-retry requirements. Finished readiness
receipts also retain explicit `--retry` for a later base move.

An explicit `--retry` captures the new main during an incomplete settlement
and proves a clean scratch replay before replacing the lane head. A completed
review remains bound to its original source commit and is retained when the
replay matches the mechanical merge tree. An unreviewed lane is rebased before
the next review. Dirty lanes, conflicting replays, changed lane tips and changed
record readiness refuse recovery without overwriting work or launching a worker.
Each recapture and prior rebase receipt remains in the journal. Settles and
promotions have no shared scheduling window.
An uncertain review still requires `--review-again` before recapture can change
the lane. At the record stage, recapture saves only its target; replay waits for
the captured report to be ingested and checked. A lost review-commit response
adopts only a single-parent commit containing exactly the captured review bytes
before recapturing. A pending `recapture` records its target while `mainHead` retains the
last successful base; only a proved, applied replay advances that base and adds
the completed recapture. Preflight or replay conflicts return a terminal handoff,
so retry cannot bypass the conflict or launch a reviewer on the unreplayed lane.
Repeated recaptures derive the replay base from the current replayed head, keeping
upstream history out of the lane's commit range. Fix/dispatching stages leave
recapture to the correction run and retain dispatch's correction-run exemptions.
An explicit `--retry --fix-findings` also leaves recapture to the correction run,
so moved main or a replay conflict cannot swallow the supervisor's correction
request. The lane and record readiness checks still apply.
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

Run an individual offline file through the bounded runner, for example
`ORG_ACTOR=developer node test/helpers/run.mjs settle/test/record-safety.test.mjs`.
Fixture teardown waits for bounded senders and stops their watchers first, then
confirms and stops the inbox owner and its current transport child before removing
the scratch record. A busy composer or slow transport cannot keep teardown waiting
for natural delivery. Unconfirmed ownership or shutdown preserves the directory.
Stop and exit confirmations retain their five-second base allowance, scaled with load.

Internal response waits adapt to measured machine load; see the
[deadline inventory](../docs/reference/load-deadlines.md) for allowances and preserved safety checks.

Independent reviews [wait for memory pressure to clear](../docs/reference/memory-gate.md)
before launching, retaining the review stage for recovery.
