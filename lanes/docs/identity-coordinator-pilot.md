# Manual two-project identity coordinator pilot brief

Status: prepared 2026-09-13; no identity or projects selected, no pilot started.
Protocol review and explicit operator selection are required first. The [proposed
protocol](../openspec/changes/identity-coordinator/) is not deployed runtime
behavior. This pilot uses the existing project-only supervisor/engineer workflow and
manual evidence reports; it can run before console extensions.

## Selection and setup (operator fills privately)

Select one identity coordinator and exactly two canonical repositories, verifying
their Git common directories and project rules. Do not select by root, same-named
repository label, Git author, remote, or discovered pane alone. For each project,
name exactly one integration owner. Use an optional project supervisor as that owner
for sustained/multi-lane work; on a small project, the coordinator can be that owner
and assign one engineer directly. Record the delegated authority source, current
plan, integration branch, independent review rule, evidence destination, and owner
acknowledgement. Do not launch if any is missing.

Choose one or two accepted outcomes per project (maximum four in the pilot), with
observable acceptance criteria and a comparable project-only baseline. Portable
examples, not chosen work: Project A accepts one bounded documentation milestone
after its normal review; Project B accepts one bounded defect-fix milestone with a
failing test, green gate, and normal independent review. The actual operator-selected
projects and criteria replace these examples in private records.

Set before dispatch: maximum two active engineering milestones per project, one
integration owner per project, finite token/turn/elapsed-time ceilings per milestone
and coordination role, a maximum operator-intervention budget, and a stop decision
time. Use [the measurement template](identity-coordinator-measurement-template.md);
blank caps mean no approval to start, not unlimited spend. Cross-project dependency
edges name a specific unblock artifact. Reports occur only at checkpoint, blocker,
or ready handoff, never on a heartbeat or routine model poll.

## Baseline and comparison

First identify one or two recent accepted project-only milestones per selected
project with the same acceptance policy and reconstructable usage. If such records
are insufficient, prospectively run a bounded project-only milestone before the
coordinated milestone; do not fill missing numbers from estimates. Match task class,
scope/complexity, model and effort as closely as possible, and record differences
in workload, parallelism, cache availability, tools and reviewer demands. Keep the
same start/acceptance timestamps and role-inclusive accounting on both arms. This
is an observational pilot, not a causal proof of savings.

Only the named integration owner may mark a milestone accepted after verifying the
project's own gate/review and outcome evidence; a planned assignment or engineer
report remains unaccepted. A stale saved handoff with the same available authorized
owner requires evidence reconciliation, not a new owner. An unavailable/replaced
owner requires an explicit authority-backed transfer before resumption. For each
accepted milestone, sum engineer, integration-owner/project-supervisor, coordinator,
and reviewer usage where available. Record total input, cached input
as a subset, uncached input (`total - cached` only if both are known), output, model
turns, repeated reads of unchanged primary evidence, operator interventions,
elapsed time, and coordination overhead separately. A repeated read is a second
model-visible read of the same artifact at the same revision without intervening
work; count it only from inspectable evidence, not a guess about memory. Log usage
source and missing fields as `unknown`. Compare medians or itemized paired rows per
accepted milestone, plus acceptance/rework quality and stop events; do not report
tokens per attempted milestone as if all attempts were accepted. Do not convert
tokens to money without verified model pricing, billable-cache rules and usage.

## Success, stop, and close

Success means all selected outcomes satisfy their original project acceptance and
closeout checks, the coordinator reduces avoidable cross-project reads or operator
interventions without hiding supervisor overhead, and no authority, identity,
budget, or evidence boundary is violated. Report actual measurements and
confounders even if there is no improvement. Stop/reconsider on any exceeded cap,
missing/ambiguous integration owner, stale evidence or handoff, unavailable archive
destination, required final gate/review refusal, unapproved dependency change, ambiguous report
delivery, or a material increase in coordination overhead. The integration owner
retains the lane and follows project recovery; no pilot-specific automatic action.
The operator decides whether to continue, revise, or end after seeing accepted
milestones and costs. No push, account change, or wider rollout is included.
