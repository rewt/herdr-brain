# Daily goals: console and identity coordination

Date: 2026-09-13, America/Chicago. Status: closed 2026-09-15; specification and
board-inventory integrated, board-frame parked. Open items continue in
`docs/plans/2026-09-15-carry-forward.md`.
Scope: herdr-lanes integration and protocol design. Existing project acceptance
checks apply. No remote publication or cross-project rollout is implied.

## 1. Advance console integration through verified acceptance

Resolve board-inventory Round 1 findings, refresh its gate, independently review
the corrected commit, and promote on acceptance. Then reconcile board-frame with
integrated main, obtain its green gate, review, and integrate on acceptance.
Preserve review evidence and required ignored artifacts before lane close.

Starting evidence: inventory e9e0d2b7ea657d6912443fb88b256d3f8aa729e6 received
NEEDS-WORK, review lr-7451c85a3828a7040dff8d58087b87bd. Two major findings concern
cross-repository observation fallback and actual-cwd ownership. Five moderate
findings concern ambiguous registry joins, retained preview/tripwire state,
cancellation, tripwire compatibility, and plain-output coverage. Frame
9e8c8f99ed1ffdaf35de6694fbe0a6bfbf33161f needs a green final gate and review.
See docs/reports/console-integration.md for baseline evidence and dependencies.

Success: accepted integrations, reviewed/promoted SHAs, and verified cleanup
recorded. If further defects prevent acceptance, record remaining findings and
the next correction step. Do not weaken checks to meet the daily target.

## 2. Specify the coordinator and supervisor partnership

Produce reviewable OpenSpec proposal, design, requirements, and bounded task briefs.
The identity coordinator owns the explicit project roster, daily outcomes,
priorities, cross-project dependencies, and resource budgets. One designated
integration owner per project owns engineering acceptance and lifecycle actions.
Dedicated project supervisors are optional for small tasks and useful for sustained
or multi-lane work. The coordinator must not duplicate their detailed review.

Define compact assignments and event reports: canonical project identity, goal,
acceptance criteria, constraints/budget, owner, milestone/result, blocker or
decision needed, next action, and durable evidence pointers. Reports describe
changes since the previous report; detailed project context stays with its owner.
Specify escalation, restart/handoff, duplicate-report handling, and explicit
reassignment. Saved metadata cannot grant authority or become a job queue.
No background scheduler, routine model polling, or automatic lifecycle replay.

Audit pending console sampling/details/composer specs against this protocol.
Identify existing CLI fields and propose only missing display fields in their
owning changes. Goals, owners, and report visibility remain separate from execution
authority. Keep coordinator features out of the existing inventory/frame scopes.

Success: reviewed ownership and reporting contracts, concrete report examples,
console compatibility/dependency mapping, and independently deliverable briefs.

## 3. Prepare a measurable two-project pilot

Write a pilot brief and measurement template for one identity coordinator and two
explicitly selected projects. Project selection remains pending until the operator
selects them; discovery alone cannot choose rollout targets. Use project supervisors
where workload justifies them.

Define one or two outcomes per project, acceptance criteria, concurrency limits,
budget/escalation rules, and a baseline against the project-only workflow. Measure
input, cached input, output, model turns, repeated reads, operator interventions,
elapsed time, and accepted milestones. Record model/effort and workload differences.
Missing usage is unknown. Do not claim monetary savings from token counts alone
or claim savings before measurement. Measure coordination overhead as well as total
work, so adding supervisors must demonstrate a benefit.

Success today: a ready-to-run brief with selected or explicitly pending projects,
baseline method, success criteria, and stop/reconsider conditions. Live rollout
follows protocol review and explicit project selection.

## Sequence and daily handoff

Start inventory corrections first. Protocol design and pilot preparation can
advance while engineering proceeds; serialize builds/tests and independent lane
reviews under repository rules. Sampling follows inventory; complete details
depends on frame plus complete discovery. Idea CLI/composer remains a later slice.
Record material results and decisions rather than heartbeats. End the day with
achieved outcomes, review/gate evidence, spend observations, unresolved decisions,
and the first next action per project.

## Afternoon/evening checkpoint and overnight gates

The coordinator specification passed independent Round 2 review at `6d8e74d`.
Its evidence-only successor `e69143a` was validated, promoted, and closed with
reports, reviews, and local gate evidence preserved. Goals 2 and 3 have reviewed
documentation deliverables; live adoption, project selection, and measurement
remain pending. This is not a shipped coordination console or savings claim.

Inventory Round 3 at `6d63181` returned NEEDS-WORK despite a 226/226 gate.
Four corrections remain: retain status-triggered preview demand during busy
collection; include terminal identity in occupant retention; restore meaningful
eligible-join regression coverage; preserve null provenance for absent goals.
The existing engineer owns one bounded correction delivery, followed by a new
gate and independent review. Frame remains queued behind inventory acceptance.

| Sequence | Deliverable | Start/finish boundary |
| --- | --- | --- |
| Inventory corrections | Four failure-first fixes, report, final gate | Independent acceptance before promotion; no self-acceptance |
| Frame reconciliation | Rebase onto accepted main, compatibility checks, refreshed gate/review | Existing repository-scoped frame only; no new details/composer |
| Sampling | Bounded asynchronous observation and measured large fixture | Start only after inventory promotes; serialize shared files and tests |
| Coordination read-model | Opt-in bounded JSON/watch projection | Start only after inventory and sampling are accepted and promoted |
| Coordination UI | Source forwarding and separate coordination attention | Wait for frame, complete details, and read-model promotion |
| Manual pilot | Two explicitly selected projects with finite outcomes/budgets | Operator selection required; no console prerequisite |

Before each unattended dispatch, the supervisor supplies a verified baseline SHA,
exact brief, file ownership, acceptance checks, reporting target, finite delivery
budget, and review-by cutoff. Stop at READY_FOR_REVIEW or an unresolved scope,
authority, or resource blocker. No routine model polling, automatic lifecycle
replay, push, release, unselected project work, or inferred follow-on assignment.
Tests and promotion stay serialized; detailed evidence stays with the project
owner. Missing usage measurements remain unknown. Morning handoff distinguishes
review-ready artifacts from accepted integrations and verified cleanup.
