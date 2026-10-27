> Current policy: new reviews and fixes start fresh. New `--reuse` requests are
> refused; explicit `--resume-session UUID` uses a fresh guarded allocation through
> the configured ai identity wrapper. The reuse descriptions below document
> compatibility for existing saved/in-flight requests, which remain immutable.

# Continuation and revision cap

ENG-444 / ARCH-36, additive contract for dispatch and settle. Owner: herdr
(supervisor-herdr); opus accepts BCH parity. This implementation is a candidate
for Astra review, not evidence of release, BCH activation or pilot acceptance.

## Sessions and authority

An explicit supervisor `dispatch ITEM --reuse R-previous ...` starts a new record
run on the retained worker's lane, pane, terminal and native session. The prior
run must be reported or abandoned. Lane, workspace, route, declared
harness/model/effort and immutable occupant identity must match, and the live
worker must be idle or done. An unknown identity requires a fresh worker or
investigation. Reuse never infers identity or model choice from a session registry.
An older completed run cannot lend a worker held by a newer unreported,
unabandoned run, even when idle or done. Dispatch checks shared agent, pane,
terminal or effective session identity in preflight and again before prompting,
excluding its own run from the holder check.

The new run records `meta.continuation_of=R-previous` and
`meta.same_session=true` through `record start --meta`. These names match BCH.
They are display-only: they grant no review, scheduling, retry, promotion or
lifecycle authority. Each run has its own brief, report, worker binding and
watcher; its result still passes through ordinary settle and independent review.

Use a fresh session for a new topic, every independent review (under the
project's review route/provider policy), and every route change, including an
escalation. A fix may reuse its lane and stopped worker on the same route.
When settle reuse is requested but `fix_route` differs from the original worker
route, dispatch starts a fresh worker on that route and the settle journal and
result add `reuse_skipped: "route_changed"`. Retrying adopts that dispatch receipt.

Cross-item reuse is allowed only when the supervisor explicitly chooses it and
all lane/workspace/route/declared/identity checks still match. Omit `--from-run`
across items: that flag always names a run on the dispatched item. A sibling
slice or landing repair may retain a session; the metadata does not move review
history between items or reset either item's cap.

`--from-run` is a current-run precondition, not a session-reuse request.
Dispatch refuses another item's run or an already superseded origin before
opening/preparing a lane, starting a run or recording awaited-item metadata.
`record start --if-current-run` remains authoritative under the event-log lock:
it rechecks supersession, closure and outcome ownership, including races after
dispatch's preflight. Retries preserve the saved origin and immutable request.

## Cap units and counting

`review_round_cap` counts **completed independent reviews**, including the current
one, once per reported run on the same item and Git common-directory identity.
Settle binds prior receipts to the recorded report hash and hashed review text.
Worker starts, abandoned unreviewed runs, uncertain reviewer retries, scope
continuations and narrow same-session corrections consume no review round.
Continuing work never resets earlier completed reviews; reviewing that new run
later consumes its own round. Continuation chains have no separate length cap.

Until stable release, Brain and BCH use **one independent post-code review per
item**, async/nonblocking for the engineer and landing, with zero reviewer suites.
The unconfigured default and both projects' saved cap are **1**. The actual
canonical landing waiver forces cap1 for new intake despite an older item/project
override. Each intake snapshots effective cap/source/round/prior runs as
`review_policy`; historical receipts keep their original snapshots and verdicts.
Total `rounds` and record budgets remain advisory. Legacy compatibility values
do not authorize a new current-policy review chain.

There is at most **one explicit formal fix round** after that single review.
No plan/pre-code/contract/concurrence stage, automatic second full review or
re-review chain applies. Later findings fix forward. Majors must actually be fixed
and their specific correction/evidence checked before final release; they never
become resolved by relabelling. The approximately30-minute target is planning,
not an elapsed stop; timeout0 is the supported active setting. At cap1:

| Review | Settle result | Automatic correction |
| --- | --- | --- |
| PASS | Review complete; main landing remains independently ungated | None |
| NEEDS-WORK, only parsed Moderate/Minor findings | `promotable_with_findings`, with findings and handoff | None |
| Major findings or FAIL | `escalate`, `code: "REVIEW_CAP_REACHED"`, with handoff | None |
| NEEDS-WORK with unparsed findings or unresolved evidence | Existing supervisor escalation | None |

Findings never create a pre-main test/review readiness gate under the actual
operator waiver. Major/FAIL still requires real correction and specific evidence
before final release. The explicit supported `--retry --fix-findings` path may
request the single formal correction; repeating it adopts its saved dispatch.
It retains report/source/claim/record/STOP guards. Autopilot does not create
another review or correction chain from the capped result.

## Explicit correction and parking

After inspecting the saved handoff, an authorized supervisor may request exactly
one correction with `handle RUN --retry --fix-findings --role supervisor`, or
direct `settle RUN --retry --fix-findings`. Both accept saved
`promotable_with_findings` or `REVIEW_CAP_REACHED` evidence. The existing decision
note records the choice; the journal retains `cappedResult`. Current report hash,
HEAD, record readiness, concurrent work, blockers and STOP are rechecked.
Repeated requests adopt the saved correction receipt without dispatching again.
The next completed review retains the count and is still subject to the cap.

BCH policy permits one escalation run up its configured ladder after the two
stuck fix rounds, then parking or an operator/Astra decision. The supervisor
selects that route under project authority before settlement; the core does not
select a provider/model ladder or automatically grant a second escalation.
A route change requires a fresh session. `--retry` keeps its saved fix route;
changing an already saved request requires an explicit new supervisor dispatch
with the current `--from-run` precondition. Park through the existing `lane close`
workflow, preserving unmerged work with its archive tag and lifecycle checks.

## Refusal codes

Failed dispatch JSON retains `result`, `reason` and existing message strings,
and adds `code`. Preflight refuses before lane/run side effects:

| Code | Meaning |
| --- | --- |
| `REUSE_RUN_OPEN` | Prior run is neither reported nor abandoned |
| `REUSE_MISMATCH` | Lane, route or declared harness/model/effort differs |
| `FROM_RUN_OTHER_ITEM` | Origin does not name a run on the dispatched item |
| `FROM_RUN_SUPERSEDED` | Origin has later runs; the reason names them |
| `REUSE_WORKER_BUSY` | A newer open run holds the occupant; also used by the late idle/done check |

Workspace and occupant checks remain late and retain the recoverable started
run: workspace mismatch also uses `REUSE_MISMATCH`; missing, conflicting or
changed identity uses `REUSE_IDENTITY_UNKNOWN` only at the initial reuse identity
check when the error has no code; a worker that is not idle/done uses
`REUSE_WORKER_BUSY`. Only dispatch-owned codes are exposed. Later transport
failures and Node system error codes use `DISPATCH_FAILED`; existing
dispatch-owned codes are preserved. These codes are diagnostic, not retry authority.
The historical reuse mismatch message still mentions item matching; the explicit
cross-item rule above defines the accepted behavior.

## BCH parity and cutover record

Current shared desk policy is cap1, timeout0 and one post-code async review with
no reviewer suites. BCH currently implements it separately; adoption has its own
actual replacement/drain/fresh-binding/exact-scope prerequisites. This document
does not authorize adoption inspection or mutation.

| BCH behavior | Brain mechanism | BCH project data |
| --- | --- | --- |
| `cont.sh` → `continue-run.sh`, new run on retained session | Explicit dispatch `--reuse`, continuation metadata, recorded worker and watcher | `settle.reuse: true` for same-route fixes; explicit `--reuse` for scope continuations |
| Unlimited scope/correction continuations, no cap reset | Completed-review counting by item; no chain-length gate | No continuation cap |
| One post-code review and at most one formal fix | Async review cap1; explicit single correction; later findings fixed forward; Majors corrected before release | `settle.review_round_cap: 1`, `settle.timeout: 0` |
| Routine findings remain delegated | Specific correction/evidence checks; no automatic re-review chain or extra operator round | Reserved outward/security/funds/identity authority retained |
| Every review and route change uses a fresh session | Independent review launch; changed fix route skips reuse | BCH-owned review route/provider policy |
| Sibling slice or landing repair can retain a session | Explicit cross-item `--reuse` with all identity checks; no cross-item `--from-run` | Supervisor chooses the item/lane |

The following Astra R4 cutover record is historical evidence, not a current
review/adoption prerequisite or authority to restore the superseded cap3 policy.

| Astra R4 row field | Historical evidence / recorded completion |
| --- | --- |
| Owner | herdr implements; opus accepts BCH parity |
| Contract | This document; acceptance pending Astra review and opus parity ruling |
| Implementation / release identity | ENG-444 lane commit recorded in R-598 report; supervisor fills release tag and exact commit at release, then BCH pin/activation separately |
| Pilot evidence | Offline fixtures: `dispatch/test/dispatch-admission.test.mjs`, `dispatch/test/dispatch-options.test.mjs`, `dispatch/test/dispatch-recovery.test.mjs`, `dispatch/test/dispatch-session.test.mjs`, `settle/test/round-cap.test.mjs`, `supervisor/test/supervisor.test.mjs`, `supervisor/test/autopilot.test.mjs`; phase B live pilot evidence to fill before retiring callers |
| Rollback | Project-local re-pin to the prior accepted release; retain old caller paths until pilot acceptance. Older readers ignore additive metadata/result fields; a prior writer retains its own cap behavior, so rollback requires supervisor control of capped work |
| Retire list | BCH `cont.sh` and `continue-run.sh` only after the phase B pilot and accepted parity; the cap/ladder prose stays BCH policy data |

Read-only BCH evidence (2026-10-19): `.lane/supervisor/cont.sh:3`,
`continue-run.sh:17,27`, `apply-settle.sh:9,31-36`, and
`WORK-PATTERN.md:46,57`, under
`/Users/rewt/development/bastian/bch-cloak/`. Astra's review is
`/Users/rewt/development/bastian/archive/ASTRA-REVIEW-BCH-ON-BRAIN-PLAN-20261019.md`,
R2 and R4. This contract changes no BCH files, installed bundle, project pin,
notice format or lifecycle authority.
