# Keep the next useful work aligned with the goal

20 September 2026 · design recommendation · automation has not been enabled.

Use a short, fresh planning session to keep the backlog useful. Give it a weekly
outcome to work toward, a daily opportunity to reconsider the next steps, and
event wakeups when something materially changes. It reads the durable record,
records what changed and why, starts only work already authorized for pickup,
and exits. There is no permanent supervisor conversation to maintain.

The operator should be able to answer three questions from the project overview:
**What outcome matters now? What is advancing it? What needs my decision?**
The daily review is a means to answer those questions, not another backlog of
status reports the operator must clear.

This extends [Goals, authority and the next task](console-goals-autonomy-2026-09-19.md)
and the [idea-first onboarding design](console-projects-onboarding-2026-09-20.md).
It specifies future behavior; the live console remains an inspection trial.

## What exists, and what does not

The following is grounded in this worktree's code on 20 September, not in a
claim that every planned Brain dispatch feature has landed elsewhere.

| Capability | Available now | Missing for unattended operation |
| --- | --- | --- |
| Reconstruct work | `org status --json`, `today --json`, `show --json`, `log`, and `snapshot` derive state without a model. | A compact planning packet with a stable source revision and explicit focus/authority references. |
| Goals, tasks, dependencies | Item parents, blocker links, acceptance, notes, runs and reports already persist. | A current-focus contract and conditional, idempotent planning changes. Existing `org set` cannot edit acceptance. |
| Priority | `lib/state.mjs:sortItems` orders higher numeric priorities first, null last, with ID ties. | Goal-priority inheritance and goal-relative candidate ordering are design proposals, not current core behavior. |
| Planning and pickup | `supervisor/SETTLE.md` Continue mode reads authority, selects ready work, avoids open runs and overlapping files, and limits engineering lanes. | A separate read-only review mode; durable task claims, reserved capacity and an atomic eligibility check at dispatch. |
| Wake on completed work | `contrib/settle-watch.mjs` waits on Herdr without an idle model call; STOP and daily launch brakes exist. | Project-scoped scheduled review, coalescing, durable request identity, missed-wakeup recovery and durable planning ownership. |
| Launch coordination | The watcher holds a short filesystem lock while checking and opening a session, then checks names/status for busy executives. | That is not a durable claim on a task or capacity slot; renamed/gone sessions and crashes leave ambiguity. |
| Org consistency | `lib/store.mjs` serializes individual mutations with a lock. | The lock does not make read-plan-start across several processes atomic. `org start` intentionally permits parallel runs and reopens closed items. |
| Feedback | Reports and decision notes survive sessions; `org ask`/`answer` support scoped questions and a declined answer keeps dependent work blocked. | Review receipts and a stable key that reuses an unresolved exception instead of asking it each morning. |
| Brain service | `brain/bin/brain.mjs` watches results and maintains its own queue; `start` launches on request. | It is not yet a daily/weekly planner. Do not describe its capture service toggle as enabling autonomous work. |

The supervisor wrapper paths and scope are currently specific to herdr-brain;
its prompt explicitly forbids writing to the bch-cloak organization. Do not use
that wrapper as a generic project scheduler. Integrate these capabilities with
the per-project dispatch boundary when available; do not create a second
console-owned watcher or another project registry.

## Weekly direction, daily choices

**Weekly direction** names one primary outcome from the existing goal tree,
the concrete evidence that would count as progress, and the work deliberately
deferred. The planning session proposes it from the operator's direction and
recent results. The operator sets it unless that power is already delegated.
An existing goal can remain the focus for several weeks; do not clone goals or
create arbitrary weekly tickets. A genuine urgent exception names its reason
and the displaced outcome.

Record a focus revision with project/org identity, goal, plain-language outcome,
evidence of progress, review date, issuer, authority reference and source
revision. This is direction, not stored goal status. A review date is a reminder
to reconsider; it neither declares the work late nor revokes unrelated
authority. The default recommendation is a weekly review on Monday and one
daily check each weekday, at a project-configured local time such as 09:00.
Those are proposed defaults, not a schedule installed by this work.

**Daily review** asks what changed, whether active work still serves the focus,
and which feasible step helps most. It produces one short result:

> Keep the import-recovery outcome first. One worker is implementing retries;
> the next useful step is failure-path testing. Account work stays deferred
> because it edits the same files. One format decision needs you.

Retain the previous direction when it still holds. Do not reorder work merely
to make a daily report look productive. Check for new evidence, newly actionable
blockers, stale links, missing acceptance, duplicate work, unranked tasks,
overlapping active work and an oldest repeatedly deferred eligible goal.
Numbers of closed tickets and busy agents are not evidence of outcome progress.

**Event wakeups** handle settled reports, answered substantive questions,
changed direction/authority and newly available execution capacity. A raw agent
status change is a hint to reconcile against durable runs and dispatch receipts;
it is not permission or a standalone instruction to launch. Do not wake a model
for every console refresh, terminal output chunk, tab focus or metadata update.

Daily checks may be cheap and deterministic: unchanged inputs with no due
review, expiring blocker follow-up or actionable work produce a `no change`
receipt without opening a head. The weekly review boundary is itself a reason
to reconsider direction, even if work has been slow. Explicit **Review now**
runs one requested review rather than hiding it behind a no-change shortcut.

## The planning pass

1. Read the project identity, org revision, current focus, effective authority,
   recent material events and last relevant review. Read active runs, dispatch
   claims and required policy; use linked documents selectively. A fresh session
   gets this packet, not every historical conversation.
2. Reconcile facts. A run is not complete just because its terminal is idle;
   a task is not done because a title says so. Flag missing reports and stale
   pane links. Check actual acceptance and review evidence before proposing
   closure. An unanswered or declined authority question remains blocking.
3. Groom only what matters. Identify duplicate tasks with evidence, broken or
   missing goal links, stale blockers and work without a useful success test.
   Clarify eligible work from existing intent; propose decisions where intent
   changes. Avoid generating children for every observation: ingested report
   proposals create real items, so repeated suggestions would inflate backlog.
4. Build an ordered shortlist using the goal rank, then task preference within
   that goal, then stable ties. Separate eligibility from importance. A useful
   prerequisite may live under another goal; name its home goal and the outcome
   it unblocks. Unranked/no-goal work remains visible for classification.
5. Check readiness, current authority, already-open runs/claims, capacity and
   overlapping edit scope. Unknown overlap waits for clarification or runs
   sequentially. Select a lower-ranked feasible task when appropriate and record
   why the higher one cannot start. Reordering does not interrupt a running agent.
6. Re-read affected facts before applying. Record a concise decision and its
   sources; apply only changes inside delegated authority through the org CLI.
   Reserve and dispatch through the existing lifecycle boundary if pickup is
   allowed. Record selection, confirmed start or uncertain/failed start distinctly.
7. Leave one result, update the planning checkpoint and stop. A future pass
   resumes from the record. Do not keep checking workers in the model session.

The result includes observed source revision, trigger, focus/authority revision,
actor, changes actually applied, selected work, principal skipped alternative,
open exception and reconsideration condition. Keep proposed changes visibly
separate from applied changes. A routine autonomous start belongs in activity
and **Why this work**, not in Needs you.

## Boundaries of autonomy

The project can separately delegate **review**, **backlog maintenance** and
**pickup**. A schedule grants none of these by itself. Reuse effective goal
decision notes and approval policy; do not add an unrelated permission system.
Conflicting notes require reconciliation, not an arbitrary latest-note override.

| Operation | Recommended authority |
| --- | --- |
| Read, analyze and write a review artifact | The planning request; no business-state changes implied. |
| Append factual evidence or a review note | Explicit maintenance delegation or the current authorized task. |
| Change a task's goal, blockers, title or acceptance | Delegated maintenance scope; otherwise record a proposal with a concrete diff. |
| Close a duplicate | Explicit maintenance scope plus evidence, a retained canonical item and checked dependents; never delete history. |
| Change the weekly focus, goal outcome or operator-set rank | Operator or actor already delegated that specific decision. |
| Start eligible work | Separate pickup grant plus a fresh claim/capacity check. |
| Promote, push, close/delete lanes, install tools | Existing independent permissions and gates; planning grants none. |

Missing acceptance cannot become a vague `Success:` label. Show **Success
criteria not recorded**, explain whether the outcome is understood, and propose
the smallest check that follows the original intent. Do not silently rewrite
acceptance after implementation to make completed work pass.

Keep advisory org budgets advisory. Surface repeated attempts, age and cost as
evidence for reconsideration. Explicit operator-configured resource ceilings
and STOP remain separate operational controls. Changing a focus is not permission
to exceed them. Preserve independent PASS for the exact reviewed head, clean
worktrees, verified validation/rebase and fast-forward promotion under the goal's
current policy; a planning report is not a review record or promotion waiver.

## Durable scheduling and recovery

Brain owns scheduling receipts, leases and wakeups in its existing user-state
area. Org owns organizational decisions, task/run facts and focus history through
its CLI. Herdr owns processes and terminals. The console reads those records and
requests an operation through the owning CLI; it never appends events directly.
Add no stored task/goal status, no dependencies to core or lanes, and no model
calls in core. Older folds must ignore new event types safely.

Use one logical planning owner for a configured project/org association, with a
lease and fencing token. Capacity and edit-scope reservations also use canonical
Git common-directory identity so two projects/worktrees sharing a repository
cannot independently consume the same slot. A user tab label is never identity.

The intended request lifecycle is derived from recorded facts:

```text
requested → claimed → reviewed → applied / deferred / no change
                      ↘ recovery needed
```

This is orchestration state in Brain, not a new status column on org items.

| Situation | Required behavior |
| --- | --- |
| Double click / daily tick and event together | Deduplicate by project and request key; join the current pass. Merge new event revisions into one pending follow-up. |
| Work changes while review runs | Recheck affected records and effective authority before effects. Stale changes are reconsidered; do not overwrite an operator edit. |
| Several unrelated projects | Independent planning leases; shared repository/resource limits still apply. All-project scope does not invent a global goal rank. |
| Two pickers choose the same task | A dedicated conditional start/claim operation checks expected state and absence of an autonomous claim atomically under the org lock. Existing manual parallel-start semantics remain available. |
| Crash after intent, before org mutation | Reuse the same action key and expected revision. The owning CLI returns the previous receipt or applies once. |
| Crash after run creation or launch timeout | Reconcile the exact run, request receipt and live pane before retry. Keep capacity reserved while start is uncertain; never replay `lane dispatch` on a guess. |
| Lease expires while worker may exist | A new owner first reconciles effects; expiry alone neither frees a possibly used slot nor proves failure. A fencing token prevents the former owner committing later. |
| Host sleeps through several ticks | Coalesce into one overdue review on wake; do not replay every missed morning. Record configured timezone and last handled calendar period, including daylight-saving transitions. |
| Herdr unavailable or credentials missing | Retain one failed/retryable receipt and back off transport retries. Do not start model sessions repeatedly to diagnose the same outage. |
| No material change | Cheap no-change receipt; no inference and no new item/note per tick. Exclude the planner's own bookkeeping from the material-change fingerprint. |
| An exception is still unanswered | Reuse its project + issue + authority-revision key. Add new material evidence to the same question; capacity waits are not human questions. |
| Paused or STOP | No new launch. Record paused/pending reason. Resume coalesces current work; it does not replay stale selected tasks. |

Schedule revisions affect future due times. Persist a stable request key, source
watermark, lease owner/fence, intended effects and observed receipts before acting;
an ephemeral agent name or registry entry cannot authorize retries. Avoid a
distributed transaction across Herdr and org: use durable intent, conditional
effects and reconciliation. Unknown launch outcomes remain explicit.

## How the console should explain it

Keep the accepted project overview rather than adding a process dashboard.
Add one compact focus strip above the work sections:

```text
This week   Reliable imports  ·  recover safely after interruption
Next work   Failure-path tests  ·  waiting for the retry lane to finish
Reviewed    Today 09:04  ·  direction unchanged                 [Details]
```

The review detail shows **Applied**, **Suggested**, **Waiting** and **Next
review** only when each has content. The operator can read the evidence,
request one review, change direction within their authority, or pause future
pickup. Review and pickup need distinct labels. Show “Review not configured”
truthfully until the feature exists; never simulate a successful scheduled pass.

In a goal reader, show linked **Active work** with task title, run, agent,
checkout and a native-terminal action. In a session reader, lead with goal,
task and the brief summary of why it is running; offer the recorded pickup
decision separately. The relationship comes from org task parents and
run-to-item records, then resolves the recorded live agent/pane in the correct
project. Show unlinked, ambiguous, historical and unavailable explicitly.
Titles, branch names and inferred terminal prose cannot manufacture links or
permission. Preserve a run's recorded goal/focus at pickup even if the task's
current goal changes; show both when relevant.

Needs you contains decisions the operator can actually resolve. A stale blocker
is investigated first. Ordinary dependency/capacity waits stay in the work view.
The focus strip and queue show last successful observation and source errors
so stale data cannot masquerade as a fresh review.

## Projects that have only ideas

An idea-only project gets an optional **Explore** review: summarize the original
notes, identify the useful unknown and suggest one experiment or conversation.
No fabricated goal, ticket swarm or obligatory weekly sprint. Store the review
with the draft project's durable notes until an org exists; registration and
idea persistence follow the shared project-catalog design.

Opening a folder discovers existing work without enrolling it in automation.
When a goal becomes useful, review a proposed outcome, success criterion and
first task; keep links back to the ideas. Enabling a project review cadence is a
separate explicit setting. Enabling pickup requires its own concrete authority
envelope. A project with no goals can continue exploring indefinitely.

## Deliver in three useful stages

**1. A real planning study with existing tools.** A manually requested, short
session can read the full org snapshot/status/log, inspect the relevant goals
and reports, and write a proposed daily/weekly review. Existing notes and an
ordinary scoped question can carry an accepted direction where authorized.
Use a dedicated review brief; the existing Continue wrapper can dispatch and
is not a read-only review command. Deliver one report with suggested changes,
clear evidence, missing authority and next feasible work. Test on a copied org
first, then read real data without applying. This stage can run now; no cadence
or dispatcher has been installed by this design.

**2. Reliable review records and maintenance.** Implement the focus/review read
contract, effective-authority references, conditional mutation receipts and
acceptance editing; add the review prompt/role, request deduplication and
console evidence. Show a concrete diff for undelegated changes. Prove a retry
cannot duplicate notes, questions or tasks. Feed a real example back into the
operator walkthrough before adopting automatic maintenance.

**3. Delegated pickup with scheduled checks.** Add durable claims/reservations,
launch reconciliation, per-project cadence and event coalescing at Brain's
dispatch boundary. Retain STOP, explicit resource brakes and promotion gates.
Pilot one narrow goal with existing authority, then expand scope based on
recorded decisions and exceptions. The console remains optional for progress.

### Acceptance missions

These are required future tests, not a claim that the automation is implemented
or was executed during this design task.

| Mission | Observable pass condition |
| --- | --- |
| Rank versus feasibility | Rank #1 is blocked; the pass selects an authorized independent task, names the skipped reason and leaves the original rank intact. |
| Goal → task → session | An operator reaches the actual linked session from a goal and reads why it was picked; a closed session remains a historical run. |
| Missing success criteria | The empty state says what is missing and a proposed check has provenance; completed work does not receive retrofitted acceptance silently. |
| Weekly focus change during review | The stale pass cannot overwrite new direction or dispatch against withdrawn authority. Running work is not interrupted by reorder alone. |
| Duplicate and stale blockers | One duplicate proposal survives retries; dropping it checks dependents. A declined question is not auto-unblocked or asked again under a new ID. |
| Simultaneous triggers | Daily tick, report and Review now produce one effective pass plus at most one material follow-up. |
| Crash/timeout injection | At every effect boundary, recovery yields one receipt/run/start or an explicit uncertain state; never a second worker from blind retry. |
| Competing lanes | Two worktrees of the same canonical repo cannot claim overlapping edits or exceed configured capacity through different project labels. |
| No-change and sleep | Unchanged daily checks cost no model call; one overdue review follows sleep, including daylight-saving boundaries. |
| Draft project | Notes without goals remain useful; a review suggests an experiment without creating goals, an org or a schedule silently. |
| End-to-end delegated work | The console can close while authorized work proceeds; pickup evidence survives restart and the exact-review promotion gate still refuses unreviewed head changes. |

Measure false starts, duplicate effects, stale decisions, repeated questions,
operator corrections, time to discover a blocked top outcome and reasoning cost
per useful review. Compare the proposed next step with independent operator
judgment. A passing simulated workflow establishes behavior under those cases;
it does not establish that the executive's prioritization is consistently good.

## Source map

- `AGENTS.md`: dependency boundaries, derived state, advisory budgets, canonical
  lane identity and display-only session metadata.
- `lib/state.mjs`, `lib/store.mjs`, `bin/org.mjs`: current ordering, state/lock
  semantics, available mutations and parallel-start behavior.
- `README.md`: report proposals create work; approval categories, declined
  answers and deterministic read models.
- `supervisor/SETTLE.md`, `supervisor/continue.sh`,
  `contrib/settle-watch.mjs`: current Continue/settle authority and launch limits.
- `brain/README.md`, `brain/bin/brain.mjs`: capture versus requested actions.
- `lanes/lane.mjs`: lifecycle safety and partial-success dispatch warning.
- `console/modern/model.mjs`: current live project/session and org link reads.

No live organization, schedule, authority envelope or worker session was changed
while preparing this recommendation.
