# Goals, authority and the next task

ARCH-4 / R-25 · 19 September 2026 · design proposal, fixture prototype only.

## Field notes, before designing

These notes were written before the prototype extension. Sources were checked
on 19 September 2026. Product observations below come from official documentation,
not hands-on use of those products. “Take” and “Reject” are my design judgments.
The earlier [terminal survey](console-screens-2026-09-18.md#field-notes-before-drawing)
still governs layout, input ownership and navigation; this study does not repeat it.

**Kubernetes: importance is separate from feasibility and interruption.** Its
PriorityClass supplies an integer priority. A non-preempting pod can precede
lower-priority pods in the queue while waiting for resources; it cannot evict
them. Backoff also means a lower-priority feasible pod may run first. Take the
distinction between importance, eligibility and execution; expose why the most
important goal cannot use a free slot. Reject preemption as the normal response
to a goal reorder: a coding session holds valuable unfinished work.
[Pod priority and preemption](https://kubernetes.io/docs/concepts/scheduling-eviction/pod-priority-preemption/)

**Buildkite: a ranked queue needs an explicit tie-break and an execution boundary.**
The documented command-job order is descending priority, scheduling time, upload
order, then internal id. A build can supply a default priority that steps override;
an urgent job waits for a busy agent to finish. Take inherited intent, stable
ordering and a clear “applies to the next start” boundary. Reject copying its
step override literally: an R&D subtask should not silently outrank another
strategic goal because it carries a large local number. These are documented
scheduler rules, not an observation of its queue screen.
[Job priority](https://buildkite.com/docs/pipelines/configure/workflows/job-priority)

**Linear: coarse urgency and exact order answer different questions.** The issue
UI documents five choices including no priority, a `P` picker, and drag ordering
within priority-ordered views, with relative positions shared across the workspace.
Take the visible ordering and deliberate, low-effort adjustment. Reject adding
both five tiers and a manual rank to this small goal list: “which outcome next?”
needs one answer. A terminal can express relative order with Earlier/Later.
[Priority](https://linear.app/docs/priority)

**PagerDuty: an escalation has an owner and a lifecycle.** Escalation policies
route to successive responders until acknowledgement; acknowledgement stops
escalation but does not resolve the incident. Take deduplication, explicit
ownership and the separation of looking, acknowledging and resolving. Reject
paging on every autonomous dispatch, and reject treating every unknown as an
operator approval. File one substantive authority question, link subsequent
deferrals to it, and continue independent work.
[Escalation policy basics](https://support.pagerduty.com/main/docs/escalation-policies)

**Warp / Oz: a fleet index is useful; it does not establish a goal scheduler.**
The documented web app has a Runs page with status/source/creator filters and
transcripts, an Agents page for skills, and Schedules with next run, status and
history. Those specific surfaces are documented; I have not inspected a signed-in
instance. Take a stable run identity, source of a start, and a route into its
session. The idea of joining those runs to ranked goals is my inference, not a
claim that Oz displays goal rank or a “why picked” record. Reject copying its
dashboard, suggested-agent catalogue, environment forms and schedule builder into
Herdr's console.
[Oz web app](https://docs.warp.dev/agent-platform/cloud-agents/oz-web-app)

The field supports bounded automatic execution with legible exceptions. It does
not prove that a coding-agent executive will choose well. That must be measured
on this organization's handoffs; a polished fleet page is not evidence of it.

## Local evidence and corrections to the brief

`lib/state.mjs:sortItems` sorts **larger numbers first**, with id ties and null
last. There is no priority inheritance. `lib/today.mjs:unblocksPrioritized`
counts transitively blocked, explicitly prioritized items to order human
questions; it is not the ready-work selector. Neither function interprets goal
authority. The existing prototype's ascending fixture values were illustrative,
not evidence of production priority semantics.

`supervisor/SETTLE.md` section 7 already chooses ready work in priority order,
skips open runs, limits simultaneous engineering lanes and avoids overlapping
files. It reads authority from goal decision notes. `settle-watch.mjs` blocks on
Herdr events without an idle model call, has STOP and daily launch brakes, and
opens a fresh executive with `--open`. Its busy-session check relies on agent
names/status; it is not a durable task claim or an atomic check-and-dispatch.
The north-star capability table still conservatively says planning is unproven:
working handoffs do not establish autonomous goal formation.

The promoted ARCH-3 design object and the product renderer are separate files.
This proposal extends `console/proto/`, preserving its cascade and reader
contract. The product print path can still launch cached question explanations;
inspection uses a worktree-local copy of its configuration with `explain: false`.
No live organization or configuration is changed.

## The recommendation

Keep the cascade. Give goals a visible project-local rank, give the executive a
bounded authority envelope, and give every pickup a short durable explanation.
The console reads those facts without inference. It offers steering and an
explicit “Run executive now” action, while ordinary authorized work proceeds
without a per-task confirmation.

The visual signature is one quiet line between the existing breadcrumb and
cascade: **Next work — the latest recorded choice**. It is an index into durable
reasoning, not a live prediction or a new queue the operator must service.
Sessions remain the place to find workers; Needs you remains the place to find
decisions requiring human authority.

### 1. What priority means

**Recommendation: rank goals within a project; tasks inherit their goal's
importance, with an optional preference within that goal.** Keep the existing
numeric `priority` as the compatible storage representation (higher first).
Display its derived ordinal as `#1`, `#2`, etc. “Earlier” changes relative goal
order without asking the operator to invent score magnitudes. The prototype
corrects its goal fixtures to 50, 40, 30, 20, 10; these are not a migration of org.

Task priority is a secondary preference, not a way to leapfrog an unrelated
goal. A hot fix that truly outranks the other outcomes should change recorded
goal direction, or be an explicitly justified exception by an executive with
that authority. This avoids contradictory scores at every tree depth. The
operator normally sets outcomes; the executive decomposes and orders tasks.

The proposed candidate order is: goal importance descending; task preference
descending with unset last; creation sequence then id. Readiness, open runs,
authority, capacity and file overlap determine whether a candidate can actually
start. They are not hidden terms in a numeric urgency formula. The executive
can select a lower-ranked feasible candidate and must explain the skip. A
cross-goal prerequisite can be chosen to unblock a higher goal, but both the
task's home goal and the benefited goal must be named, and the task still needs
authority in its own scope. “Rank #1” is neither “running” nor “next guaranteed.”

For nested work, the nearest containing goal supplies importance; an unranked
nested goal inherits its nearest explicitly ranked ancestor's score, showing the
source. Equal scores have a deterministic id tie-break, not fabricated intent.
Unranked roots and orphan tasks remain visible as **unranked / no goal**; they
are candidates for executive classification, not reasons to refuse useful work.
The fixture uses six explicitly ranked roots and one level of nested tasks; it
does not simulate missing/nested goal ranking.

Age, repeated deferral and advisory budget consumption belong in the decision
context. They may motivate an explicit priority revision; they do not silently
raise rank or terminate research. At each meaningful planning pass, inspect the
oldest eligible deferred goal and record continued deferral if it is still
skipped. No forced round robin for file-conflicting work, no automatic priority
inflation, and no daily re-ranking chore for the operator.

Ranks are local to configured project + canonical org identity. All projects
shows each project's own order, labeled with its project, never a fictitious
global `#1`. Cross-project resource allocation remains the existing configured
authority/capacity policy, not a consequence of where the console cursor sits.
Introducing a global portfolio order can wait for evidence of actual contention.

### 2. Where picking lives, and how to invoke it

**Recommendation: keep judgment in the fresh executive role represented by
Continue mode; give the console an explicit optional trigger and an authority
reader/editor.** The deterministic core produces state and sorted candidates;
the executive interprets the goal, evidence and scope, chooses, records, exits.
Neither a worker pane, its session metadata nor a console reducer becomes the
scheduler. The console is not required to stay open for progress.

Prefer completion/settlement, answered authority questions and materially changed
direction as wakeups. A cheap external trigger coalesces these by project and
state revision. An optional daily planning wake can check a durable “changed
since last planning” marker without inference; meaningful new evidence or an
explicit operator request may open a session. An unchanged no-work state must
not keep opening heads. The existing blocking watcher is compatible with the
economics of the north star; its process lifetime is not the problem. Retain
its useful wakeup behavior, then consolidate triggers into brain when ENG-23's
dispatch boundary is ready. Do not build a second console-owned watcher.

`e` opens **Next work**, showing past choices with absolute date/time, outcome,
project and a reader. `n` there requests one project-wide executive pass. Review
names the project, the permitted effect and that reasoning uses a model; it does
not preselect or require approval for the executive's eventual task. All-project
scope requires choosing a project. Existing goal/task/search filters never narrow
the requested authority. A duplicate request joins or focuses the existing
request rather than launching another session. The prototype demonstrates the
request receipt only; no model or worker is actually started.

Goal detail offers `a` **Authority**: issuer, revision, allowed work, matters to
ask about, pickup permission and promotion conditions. The fixture can edit the
allowed-work text and explicitly allow/pause future pickup, with a before/after
review. Existing ask boundaries and promotion gates remain visible. Missing
authority has an honest empty state and cannot be enabled by a one-key toggle.
The first envelope requires an executive to propose concrete terms and a
recommendation for the operator, in the existing decision reader.

In a product, editing appends a new authoritative decision through org with an
expected prior revision; it does not overwrite history. Conflicting or partial
notes must be reconciled into one effective envelope with source references,
not “last note wins” for unrelated policy clauses. The issuer must be the
operator or an actor already delegated that particular power. Agents cannot
widen their own envelope. Pickup, review, promotion, push and deletion are
separate grants; allowing pickup alone grants none of the others. Hard resource
limits explicitly configured by the operator remain distinct from org's advisory
budgets. The fixture's operator labels are illustrative, not authentication.

### 3. Trust at the moment of autonomy

**Recommendation: show the live session and keep a durable choice record; do
not create an attention entry for an ordinary start.** The overview's one-line
latest choice links to Next work. The session reader's `w` **Why this work**
opens the same record. Days later, Next work still lists it, independent of
Today, transcript availability, tab closure, and read receipts. No model call
is required to reconstruct why the task was picked.

Write the intended choice before dispatch, then append the observed result.
Render “selected; start not confirmed,” “started,” “start failed,” “deferred,”
or “needs authority” from those facts. A pane appearing or a model asserting
success is not proof of a successful start. The fixture demonstrates a confirmed
start, authority deferral, capacity deferral and no pick. It does not implement
the production transaction or crash recovery.

Each record should be short enough for a fresh executive to read selectively:
one plain headline and roughly 150–250 words, with these facts:

| Fact | Why it belongs in the record |
|---|---|
| Stable identity, project/org, actor, absolute time, trigger, observed sequence | Establish who decided against which state |
| Task, goal and rank at the time, benefited goal if different | Connect the work to an outcome |
| One or two sentences explaining the choice | Preserve the reasoning without replaying chat |
| Effective authority revision **and relevant text**, with evidence references | Survive later policy changes and avoid transcript archaeology |
| Eligibility checks and the main skipped alternative(s) | Explain why a superficially higher candidate did not run |
| Run/lane/request identity and observed start result | Distinguish intention from execution |
| Reconsideration condition or linked substantive question | Explain what happens next without another status inquiry |

The current goal rank and envelope are separate links. Editing either must never
rewrite the recorded rank or authority at pickup. A record is the executive's
account, backed by references, not independent proof of the reasoning's quality.
Review and promotion retain their existing verification gates.

An authority exception joins the existing one-line Needs you index, with context,
options, recommendation and the precise power required in its reader. Repeated
encounters reuse that question. Capacity, normal dependencies and a lower-ranked
goal waiting its turn are not human questions. A failed launch becomes actionable
only if recovery needs operator input; uncertainty about whether a worker started
must be reconciled before retrying. This distinction prevents autonomy telemetry
from becoming an approval queue.

The cold start contains current ranked outcomes, current effective authority,
ready candidates and active claims, unresolved substantive questions, and the
last relevant choices. Summaries are written when reasoning happens, not generated
on every console read. Older records remain addressable for audit; they are not
automatically stuffed into each prompt. Advisory token targets for this packet
should be measured, never used to reject a useful investigation.

### 4. Priority's place in the console

**Recommendation: keep priority in the existing goals column and goal reader;
do not add a ranking screen.** Six outcomes already fit the column. A second
backlog would create a second place to interpret order and a second selection
state to maintain. Goal rows show `#rank id title`. At 80 columns, the existing
moving window still reveals goals when they have focus; the selected goal's rank
and source are available in task detail. Task status keeps its fixed word column.

`[` moves a selected goal earlier, `]` later, within its project. Named clickable
buttons make these terminal-native operations discoverable; goal detail offers
them too. The selected identity, goal/task filters and session population remain
stable. An intentional reorder changes visible order immediately, leaves an
explicit receipt, and can be reversed with the opposite action. No confirmation
dialog for this routine reversible steering. If priorities change elsewhere,
retain the cursor and show “order changed; refresh” rather than shuffling rows
under a pending click. Refresh re-sorts by the latest authority-approved order.

No drag handles, hidden mouse modifier, numeric-entry dialog or top-level tier
selector. An exact ordinal setter could be added for dozens of goals; it buys
little here. Rank and permission remain independent: moving a paused goal first
does not resume it. The fixture verifies this distinction and keeps old pickup
records immutable after moves.

### 5. How much autonomous pickup now

**Recommendation: automatic pickup inside a narrow, explicit envelope now;
do not adopt “propose every task, press Enter to continue” as the default.**
The working Continue protocol already supplies a foothold. Putting an approval
in front of every ordinary task would assign scheduling to the operator and
teach the wrong interaction, even if described as a temporary trust step.

Earn trust by limiting initial scope, making each choice explainable, retaining
review/promotion gates, and making future pickup easy to pause. Initially use one
project and an already authorized class of reversible local work. Observe a few
real handoffs, including a no-work result and an authority exception. Measure
unauthorized starts, duplicate starts, incorrect goal choices, avoidable human
interruptions, planning calls per productive run, cold-start tokens, and total
tokens per useful item. Expand scope only when that evidence supports it; no
arbitrary fixed number of “successful approvals” unlocks more power.

A proposal-only rehearsal is useful for a *new* envelope or migration, with a
defined end and a comparison against actual choices. It should be opt-in and
should not send one human question per otherwise ordinary task. If the system
cannot establish authority, it presents a substantive envelope decision first.
No permission is inferred from silence, a high rank, available budget, a model
name or an apparently idle pane.

### 6. What fits Ink inside Herdr

**Recommendation: transfer fleet identity, provenance, exception routing and
direct session access; leave the web control-plane furniture behind.** The
existing cascade already answers what the work serves, and the sessions pane
already locates workers. One compact choice line, a lasting index and readable
evidence add the missing explanation. `w`, `G/T/S`, Enter, Back and the existing
pane jump are enough; no second transcript viewer or live topology graph.

Do not import animated agent cards, utilization gauges, a drag canvas, schedule
builders, template marketplaces, or a wall of intermediate model thoughts. Those
surfaces can be appropriate in a cloud product, but here they consume scarce
terminal rows and ask the operator to maintain orchestration. A constantly
recalculated “next task” would also spend tokens on a prediction that readiness
could invalidate immediately. Show the last recorded choice with its timestamp
and the current facts separately.

Use the existing palette (slate `#101820`, paper `#dce4e8`, secondary `#98a9b4`,
focus blue `#80c6df`, decision amber `#efbd76`, selected slate `#293e4b`) and the
terminal's monospace font. Bold titles orient; regular text carries reasons;
aligned cells carry rank/date/state. Color never carries permission by itself.
The one new line is the deliberate visual emphasis; extra width buys prose,
not cards. No new dependency or Herdr keybinding is needed.

## Interaction changes and layout critique

| Context | Key / mouse target | Effect |
|---|---|---|
| Overview and readers | `e` / Next work | Open recorded decisions for the project, independent of goal/task filters |
| Next work | Enter / row disclosure | Read one lasting decision; Back restores cursor and scope |
| Next work | `n` / Run executive now | Review one explicit project-wide reasoning request; duplicate requests are coalesced |
| Goal column or goal detail | `[` Earlier / `]` Later | Reorder this goal inside its project, preserve selection |
| Goal or decision detail | `a` / Authority | Read the current envelope, separate from the historical receipt |
| Authority | `r` / Edit work | Edit allowed-work text, then review old/new text and unchanged boundaries |
| Authority | `1` Allow / `2` Pause pickup | Review an explicit permission revision; affects future pickup only |
| Task/session detail | `w` / Why this work | Open its pickup receipt, or say no receipt was recorded |
| Decision with a question | `o` / Question | Open the existing substantive decision reader |

All editor input ownership, Tab-to-Cancel, disclosure versus selection, wheel
regions, Back stack, global needs count, session reservation and existing keys
remain as in ARCH-3. In authority edit, literal `b`, `!`, `1` and bracketed paste
are text, not actions. Permission review and model-launch review are about
explicit operator changes, not a compulsory approval step for every task.

First sketch: add rank, autonomy mode, next-task badge and last choice to every
goal row. At 100 columns this consumed the entire title cell; at 80 it hid the
relationship. Rejected. The delivered sketch retains just rank in the goal row,
puts authority in its reader, and spends one overview row on the latest choice.
The task/status cells and one-line waiting rows keep their existing widths.
At 80, the new decision reader shows reason, rank, authority, checks, alternative,
outcome and revisit before scrolling; older provenance and full gates are below.
Sessions and global attention remain visible throughout.

The prototype's editor is deliberately simple, like the existing reply editor:
append/backspace, review and cancel. It edits one scope field; arbitrary promotion
policy editing and first-envelope creation are not simulated. Those require the
full proposed text and all applicable source notes in a product review. The
prototype also lacks refresh concurrency, actual scheduling, persistence and
live execution failure recovery. It must never be mistaken for those features.

## Proposed changes outside the console (not implemented)

1. **Org priority/read contract.** Agree the goal-first candidate semantics,
   inherited source, null/tie behavior and task-local preference above. Keep
   existing numeric direction and older event folds compatible. Add an atomic
   CLI operation for relative goal reorder with an expected revision, and a
   deterministic read projection for ranks, effective authority, active claims
   and decision references. Do not silently reinterpret legacy task priority
   globally: migrate under a recorded decision and show the before/after ready
   order. Console writes use CLI argument arrays only. No stored item status.
2. **Authority and choice record convention.** Specify versioned envelope notes
   with issuer, source revisions, allowed work, ask boundaries, pickup control,
   promotion rules and explicit limits. Specify durable selection/outcome notes
   linked by decision/request id, with compact text and immutable evidence
   excerpts. A read-only projection should return the effective current envelope
   and historical choices without a model; unknown note formats remain visible
   as raw notes, never interpreted as grants. Existing logs remain authoritative;
   avoid a second status database or an ever-growing mandatory prompt.
3. **Brain/executive continuation, coordinated with ENG-23.** Consolidate wakeups
   and explicit requests around the dispatch layer; serialize choices by
   canonical project/org identity and reserve task + conflicting work before
   dispatch. Recheck org revision, open runs, authority and configured capacity
   at the execution boundary. Record intent, reconcile run/lane/agent evidence,
   then record the outcome. A crash after `org start` must not blindly dispatch
   again. Org currently permits parallel runs with a warning, so merely reading
   ready order cannot supply this protection. Preserve every lane lifecycle
   check, canonical Git identity, review/rebase/validation/fast-forward gates
   and archive-on-close behavior. Session annotations stay display-only.
4. **Console integration after these contracts.** Build on the ARCH-3 product
   integration, join by project + canonical org + record id, expose read errors
   as unavailable/stale, and disable writes based on stale revisions. Requests
   are asynchronous: show queued/running/result from recorded facts, and retain
   a receipt after tabs close. No polling inference, silent explanation model
   calls, auto-start on view open, automatic push or new promotion authority.

These are proposals for the operator's implementation backlog, not prerequisite
approvals for inspecting this design. None of the core, brain, lanes, supervisor
or `console/lib/` is changed in this run.

## Trial and remaining operator choices

Try goal Earlier/Later, then read the existing pickup receipt: current rank should
change and historical rank should not. Pause future pickup, inspect its reviewed
terms, return to the same goal, and verify the running session is still present.
Open the authority deferral, follow its question, then Back twice; the same
receipt and global count should remain. Request an executive in Harbor, repeat
the request, and try All projects: the fixture should demonstrate deduplication
and an explicit scope boundary. At every step no live command runs.

Only the operator can grant real authority or choose a cross-project resource
policy. Recommend reusing the existing per-goal grants and configured launch
limits for the first product trial, keeping pickup separate from promotion, and
adding no global portfolio rank yet. Whether rank exceptions or new goals are
delegated to the executive must be written in that envelope; recommend allowing
task decomposition and within-goal ordering immediately, with strategic goal
changes only where already delegated. This design needs no answer to finish;
those choices belong to adoption of the proposed production behavior.

<!-- GENERATED AUTONOMY: node console/proto/render-autonomy.mjs -->

## Exact changed regions

These are unaltered crops from the same frame Ink renders. Full frames under
`console/proto/snapshots/autonomy/` retain global attention, the session pane
and navigation. They use 80×30, 100×40 and 140×45. Blank unused body rows are
omitted here; the old cascade, waiting reader and session table are not redrawn.
The original ARCH-3 snapshots remain historical evidence of that design.

### Rank in the existing cascade

**80×30** — `node console/proto/main.mjs --print 80x30 --goal G-1 --keys Tab,Tab`

```text
 [e Next work] 14:10 Started retry recovery / harbor
> Goals 5 / rank          │  Tasks 10
  All goals              >│* All tasks                                         >
> #1 G-1 Reliable impor… >│  ENG-1  Validate imports                   active  >
  #2 G-2 Clear account…  >│  ENG-2  Retry interrupted batches          active  >
  #3 G-3 Fast search     >│  REV-3  Review error messages              blocked >
  #4 G-4 Calm releases   >│  RES-4  Measure slow requests              ready   >
  #5 G-5 Useful audit t… >│  ENG-5  Explain recovery steps             active  >
```

Changed controls (same frame):

```text
 [Tab focus] [j/k select] [Enter detail] [/ Find] [t Stage]
 [Goals] [Tasks] [Open items] [[ Earlier] [] Later] [? Help]
 [b Back] [! All needs you] [s Sessions] [: Screens] [e Next work]
```

**100×40** — `node console/proto/main.mjs --print 100x40 --goal G-1 --keys Tab,Tab`

```text
 [e Next work] 14:10 Started retry recovery / harbor
> Goals 5 / rank     │  Tasks 10                 │  Open items 5
  All goals         >│* All tasks               >│* Q-1     Choose a retry poli… harbor   reply    >
> #1 G-1 Reliable…  >│  ENG-1  Validat… active  >│  Q-2     Keep the existing f… harbor   decision >
  #2 G-2 Clear acc… >│  ENG-2  Retry i… active  >│  Q-3     Accept the message…  harbor   decision >
  #3 G-3 Fast sear… >│  REV-3  Review…  blocked >│  HUM-1   Choose the recovery… harbor   decision >
  #4 G-4 Calm rele… >│  RES-4  Measure… ready   >│  REV-3   Error review is rea… harbor   read     >
  #5 G-5 Useful au… >│  ENG-5  Explain… active  >│
```

Changed controls (same frame):

```text
 [Tab focus] [j/k select] [Enter detail] [/ Find] [t Stage]
 [Goals] [Tasks] [Open items] [[ Earlier] [] Later] [? Help]
 [b Back] [! All needs you] [s Sessions] [: Screens] [e Next work]
```

**140×45** — `node console/proto/main.mjs --print 140x45 --goal G-1 --keys Tab,Tab`

```text
 [e Next work] 14:10 Started retry recovery / harbor
> Goals 5 / rank            │  Tasks 10                          │  Open items 5
  All goals                >│* All tasks                        >│* Q-1     Choose a retry policy                        harbor   reply    >
> #1 G-1 Reliable imports  >│  ENG-1  Validate imports  active  >│  Q-2     Keep the existing file format                harbor   decision >
  #2 G-2 Clear account re… >│  ENG-2  Retry interrupte… active  >│  Q-3     Accept the message review                    harbor   decision >
  #3 G-3 Fast search       >│  REV-3  Review error mes… blocked >│  HUM-1   Choose the recovery wording                  harbor   decision >
  #4 G-4 Calm releases     >│  RES-4  Measure slow req… ready   >│  REV-3   Error review is ready                        harbor   read     >
  #5 G-5 Useful audit tra… >│  ENG-5  Explain recovery… active  >│
```

Changed controls (same frame):

```text
 [Tab focus] [j/k select] [Enter detail] [/ Find] [t Stage]
 [Goals] [Tasks] [Open items] [[ Earlier] [] Later] [? Help]
 [b Back] [! All needs you] [s Sessions] [: Screens] [e Next work]
```

### Lasting decision index

**80×30** — `node console/proto/main.mjs --print 80x30 --screen decisions`

```text
> When / result / what happened / project
> 09-19 14:10 started         Started retry recovery                harbor     >
  09-19 14:08 needs authority Deferred account changes              harbor     >
  09-19 13:55 deferred        Waited for a free lane                harbor     >
```

Changed controls (same frame):

```text
 [Tab focus] [j/k select] [Enter detail] [/ Find] [t Stage]
 [n Run executive now] [0 Clear filters] [? Help]
 [b Back] [! All needs you] [s Sessions] [: Screens] [e Next work]
```

**100×40** — `node console/proto/main.mjs --print 100x40 --screen decisions`

```text
> When / result / what happened / project
> 09-19 14:10 started         Started retry recovery                                    harbor     >
  09-19 14:08 needs authority Deferred account changes                                  harbor     >
  09-19 13:55 deferred        Waited for a free lane                                    harbor     >
```

Changed controls (same frame):

```text
 [Tab focus] [j/k select] [Enter detail] [/ Find] [t Stage]
 [n Run executive now] [0 Clear filters] [? Help]
 [b Back] [! All needs you] [s Sessions] [: Screens] [e Next work]
```

**140×45** — `node console/proto/main.mjs --print 140x45 --screen decisions`

```text
> When / result / what happened / project
> 09-19 14:10 started         Started retry recovery                                                                            harbor     >
  09-19 14:08 needs authority Deferred account changes                                                                          harbor     >
  09-19 13:55 deferred        Waited for a free lane                                                                            harbor     >
```

Changed controls (same frame):

```text
 [Tab focus] [j/k select] [Enter detail] [/ Find] [t Stage]
 [n Run executive now] [0 Clear filters] [? Help]
 [b Back] [! All needs you] [s Sessions] [: Screens] [e Next work]
```

### Why a task was picked

**80×30** — `node console/proto/main.mjs --print 80x30 --screen decision`

```text
  > D-18 Started retry recovery
  STARTED / 2026-09-19 14:10 / harbor
  Why: The first-ranked goal has a ready retry fix; completed imports must
  stay safe.
  Priority then: #1 Reliable imports. Task: ENG-2.
  Authority then: G-1/note-42 by operator; pickup allowed.
  Allowed: Implement and test import recovery in local lanes; keep the saved
  format.
  Checked: Ready, no open run at claim, one lane available; import edits do
  not overlap account work.
  Other work: ENG-1 already has an open run. G-2 needs wider authority. Search
  can wait.
  Outcome: Started R-2 in lane-2; worker batch-retry observed working.
  Revisit: Reconsider remaining work when this run reports or direction
  changes.
```

Changed controls (same frame):

```text
 [a Authority]
 [m Actions] [? Help]
 [b Back] [! All needs you] [s Sessions] [: Screens] [e Next work]
```

**100×40** — `node console/proto/main.mjs --print 100x40 --screen decision`

```text
  > D-18 Started retry recovery
  STARTED / 2026-09-19 14:10 / harbor
  Why: The first-ranked goal has a ready retry fix; completed imports must stay safe.
  Priority then: #1 Reliable imports. Task: ENG-2.
  Authority then: G-1/note-42 by operator; pickup allowed.
  Allowed: Implement and test import recovery in local lanes; keep the saved format.
  Checked: Ready, no open run at claim, one lane available; import edits do not overlap account
  work.
  Other work: ENG-1 already has an open run. G-2 needs wider authority. Search can wait.
  Outcome: Started R-2 in lane-2; worker batch-retry observed working.
  Revisit: Reconsider remaining work when this run reports or direction changes.
  Trigger: A completed review freed a lane. By executive-1410; org sequence 245.
  Boundaries then: Ask before changing saved formats, shared rules, spending money or publishing.
  No push or lane deletion. Budgets are advisory. Existing project launch limits still apply.
  Gates then: Promotion needs the exact reviewed head, clean worktrees, green validation and a
  fast-forward.
  [a] Read current authority; this decision keeps its original evidence.
  [G] Related goal: Reliable imports
  [T] Related task: Retry interrupted batches
  [S] Related session: batch-retry
```

Changed controls (same frame):

```text
 [a Authority]
 [m Actions] [? Help]
 [b Back] [! All needs you] [s Sessions] [: Screens] [e Next work]
```

**140×45** — `node console/proto/main.mjs --print 140x45 --screen decision`

```text
  > D-18 Started retry recovery
  STARTED / 2026-09-19 14:10 / harbor
  Why: The first-ranked goal has a ready retry fix; completed imports must stay safe.
  Priority then: #1 Reliable imports. Task: ENG-2.
  Authority then: G-1/note-42 by operator; pickup allowed.
  Allowed: Implement and test import recovery in local lanes; keep the saved format.
  Checked: Ready, no open run at claim, one lane available; import edits do not overlap account work.
  Other work: ENG-1 already has an open run. G-2 needs wider authority. Search can wait.
  Outcome: Started R-2 in lane-2; worker batch-retry observed working.
  Revisit: Reconsider remaining work when this run reports or direction changes.
  Trigger: A completed review freed a lane. By executive-1410; org sequence 245.
  Boundaries then: Ask before changing saved formats, shared rules, spending money or publishing. No push or lane deletion. Budgets are
  advisory. Existing project launch limits still apply.
  Gates then: Promotion needs the exact reviewed head, clean worktrees, green validation and a fast-forward.
  [a] Read current authority; this decision keeps its original evidence.
  [G] Related goal: Reliable imports
  [T] Related task: Retry interrupted batches
  [S] Related session: batch-retry
```

Changed controls (same frame):

```text
 [a Authority]
 [m Actions] [? Help]
 [b Back] [! All needs you] [s Sessions] [: Screens] [e Next work]
```

### Current authority, separate from past choices

**80×30** — `node console/proto/main.mjs --print 80x30 --screen authority`

```text
  > G-1 Reliable imports / authority
  Goal rank #1 in harbor: Reliable imports
  Pickup: allowed / G-1/note-42
  Recorded by operator at 2026-09-19 13:40.
  Allowed work
  Implement and test import recovery in local lanes; keep the saved format.
  Ask the operator
  Ask before changing saved formats, shared rules, spending money or
  publishing.
  No push or lane deletion. Budgets are advisory. Existing project launch
  limits still apply.
  Promotion
  Promotion needs the exact reviewed head, clean worktrees, green validation
  and a fast-forward.
  Changes govern future picks. A running session keeps its explicit task.
```

Changed controls (same frame):

```text
 [r Edit work] [1 Allow pickup] [2 Pause pickup]
 [? Help]
 [b Back] [! All needs you] [s Sessions] [: Screens] [e Next work]
```

**100×40** — `node console/proto/main.mjs --print 100x40 --screen authority`

```text
  > G-1 Reliable imports / authority
  Goal rank #1 in harbor: Reliable imports
  Pickup: allowed / G-1/note-42
  Recorded by operator at 2026-09-19 13:40.
  Allowed work
  Implement and test import recovery in local lanes; keep the saved format.
  Ask the operator
  Ask before changing saved formats, shared rules, spending money or publishing.
  No push or lane deletion. Budgets are advisory. Existing project launch limits still apply.
  Promotion
  Promotion needs the exact reviewed head, clean worktrees, green validation and a fast-forward.
  Changes govern future picks. A running session keeps its explicit task.
  [r] Edit allowed work [1] Allow pickup [2] Pause pickup
```

Changed controls (same frame):

```text
 [r Edit work] [1 Allow pickup] [2 Pause pickup]
 [? Help]
 [b Back] [! All needs you] [s Sessions] [: Screens] [e Next work]
```

**140×45** — `node console/proto/main.mjs --print 140x45 --screen authority`

```text
  > G-1 Reliable imports / authority
  Goal rank #1 in harbor: Reliable imports
  Pickup: allowed / G-1/note-42
  Recorded by operator at 2026-09-19 13:40.
  Allowed work
  Implement and test import recovery in local lanes; keep the saved format.
  Ask the operator
  Ask before changing saved formats, shared rules, spending money or publishing.
  No push or lane deletion. Budgets are advisory. Existing project launch limits still apply.
  Promotion
  Promotion needs the exact reviewed head, clean worktrees, green validation and a fast-forward.
  Changes govern future picks. A running session keeps its explicit task.
  [r] Edit allowed work [1] Allow pickup [2] Pause pickup
```

Changed controls (same frame):

```text
 [r Edit work] [1 Allow pickup] [2 Pause pickup]
 [? Help]
 [b Back] [! All needs you] [s Sessions] [: Screens] [e Next work]
```
