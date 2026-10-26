# Settle

Settle records a worker report and delivers its one independent post-code review.
It has no dependencies, runs no test suite, and writes record events through the
record CLI. The canonical supervisor handles the existing final notice:

```sh
node supervisor/supervisor.mjs handle R-123 --role supervisor
```

The actual operator landing waiver makes review delivery asynchronous. Finished
source lands independently, without a pre-main test, merge, affected-file or review
readiness gate. Red main is accepted and real findings are fixed forward. Native
identity, claims, source/head/clean Git/CAS/FF safety and recoverable archives stay
enforced. Settle itself never promotes, pushes, closes worktrees or tidies panes.

## One review, captured after code

Every item receives one independent review of the immutable diff and evidence,
including ordinary changes. There is no plan/pre-code/contract/concurrence stage.
The default review-round cap is1; the actual canonical waiver forces cap1 for new
intake even when an older item/project override differs. Timeout0 disables the
elapsed review deadline. The approximately30-minute target is advisory. Reviewer
test/build/install/prepare/check/probe counts are all zero.

The supervisor's default handler returns `review_pending` and retains its delivery
receipt before the background continuation runs. Do not dispatch another reviewer
or watcher. The completed current-policy result is `reviewed`, with
`blocks_landing:false`, the captured reviewed commit, verdict and findings. A PASS
is a review verdict, not a test result or integration receipt. Majors must actually
be corrected and their specific correction/evidence checked before final release.

Intake captures the report bytes/hash, original ask/acceptance, canonical Git common
identity, source commit, base and diff. Supplied report commands are evidence,
never execution authority. Ingest uses the record's immutable report copy and the
same report validation as `record check`. An unknown/abandoned run, changed report
hash or foreign claim remains a refusal. A done envelope never substitutes for
independent judgment or functional evidence.

The asynchronous review reads its captured commit objects. An engineer's later
HEAD, a newer run or supported lane retirement cannot replace that source or erase
its review. Completing the old review never clears the newer run's outcome or
borrows its claim. A late older report never restores an outcome cleared by
`item.reopened`. Delivery binds the matching full source/head/review receipt;
uncertain launch or delivery requires inspection of the existing session/evidence,
not a second automatic review. Historical verdicts/caps/receipts remain unchanged.

## A single formal correction

After the review, the supervisor may request at most one formal fix round:

```sh
node supervisor/supervisor.mjs handle R-123 --retry --fix-findings --role supervisor
```

Direct settle also supports `R-123 --retry --fix-findings`. The command records the
explicit decision and retains its original result. Repeating it adopts the saved
correction dispatch; it never starts a duplicate. No automatic second full review
or re-review chain follows. Later findings are fixed forward. Scope continuations
and narrow same-session corrections never reset the review count.

Correction dispatch retains current report/head, native ownership, record,
supersession, blocker and STOP guards. It is not pre-gated by promotion readiness.
The canonical `.lane/supervisor/STOP` is checked before a fresh correction launch
and incomplete-dispatch retry. Unknown launch/delivery remains held. Recovery uses
only the matching existing correction journal/run; multiple matches require
inspection and never authorize another worker. Route changes retain a fresh
worker; explicit same-route `--reuse` keeps dispatch's actual stopped-occupant
identity checks. Never relay or retry a native harness refusal.

## Configuration and durable recovery

Inspect supported settings through the record CLI:

```sh
record desks --json
record desks set --review-route review-codex --review-round-cap 1 --timeout 0
```

Routes retain their actual model/effort configuration; independence does not require
a different provider. Routing snapshots, lifecycle configuration provenance and
saved owner/project bindings survive retries. `--retry` uses its saved request,
without repeating intake flags or selecting a different ambient `LANE_CONFIG`.
No console or dependency-bearing module is required.

Receipts, captured reports/diffs, logs, correction briefs and handoffs live under
`.org/settle/`; status remains derived from events. The existing per-repository/lane
lock serializes updates. Repeated finished delivery returns its saved result.
Inspect the existing receipt and session when an outcome is uncertain:

```sh
node settle/settle.mjs R-123 --status
node settle/settle.mjs R-123 --retry
```

Exit0 means a clear result, including a handoff; exit1 means interruption/refusal
with retained evidence. Legacy unwaived projects retain compatibility branches
for old readiness/rebase/cap snapshots; those branches are not the active Brain or
BCH process. Historical receipts are preserved, not rewritten to today's defaults.
See [the continuation/cap contract](../docs/contracts/CONTINUATION-AND-REVISION-CAP.md)
and [supervisor protocol](../supervisor/PROTOCOL.md).

## Final coverage and consumers

ONE FULL release test is shared by all fixes per release, immediately before final
release/adoption. Preserve completed passes and run only failing, actually affected
or previously unrun checks after a real correction. Bind carried and fresh coverage
to actual source, runner, environment and dependencies; do not fabricate a green
full-command or validation-done receipt. Actual live acceptance, package seal,
activation/readback and Major correction evidence remain required. The sole forced
freeze is measured no-output AND confirmed-no-activity; unknown activity holds.

Brain and BCH use the same rules now in separate tooling. BCH switches to Brain
tooling only through its separately authorized replacement/drain/fresh-binding/
exact-scope adoption boundary. This document grants no adoption inspection or
mutation. Rehearsal remains PRIVATE with fresh-clone pre/post checks in parallel;
Chipnet/run/funds and other reserved operator boundaries remain unchanged.

Offline functional tests use real Git/record/review schemas with scripted Herdr
transport and no model. They belong to the coordinator's final coverage, never to
a reviewer. Fixture cleanup retains actual process/ownership/stream-drain guards;
a refused or unknown cleanup preserves evidence rather than claiming completion.
