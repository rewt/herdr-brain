# A finite owner for lessons

ENG-1283 / R-1731, 31 October 2026. Design stage: one line-owned Opus review,
then a separate Sol xhigh build. This is D17 of the
[supervisor retirement design](supervisor-chat-retirement.md). It does not
activate an owner, change lessons or advance the digest cursor. Implementation,
backlog application and the outcome window remain **UNRUN**.

## Owner and completion boundary

Assign the learning edge to a **finite learning owner**: an ordinary selected
engineering work item and its source-bound run, started by the existing line.
The role is a duty, not a new agent identity, daemon or standing conversation.
Its bounded input is a saved digest page plus a fixed-cutoff lesson inventory.
It compares original learnings/findings and existing claims, proposes short
lessons, decides activate/merge/retire with reasons, names the consumer and
observes whether a later action applied the lesson. It also reviews stale active
lessons, without treating age or lack of a recorded citation as proof of harm.

The learning item's recorded planner selects the pass through ordinary project
authority. A report/review event is a signal, never permission to start work.
For the initial handoff, the selected LO1 build owner files the initial pass and
its bounded observation obligation; selection still follows the existing owner
path. Subsequent passes name their next input event and finite selection owner
in the previous handoff. There is no timer, new background loop or generic
backlog judge. If no pass is selected, intake is visibly waiting. An unavailable
line retains the original obligation and recovery custodian; it cannot prove
retirement by silence. BCH and ARCH-21's remaining scope stay with their owners.

The pass has one independent other-family judgment review on the normal record
queue-review path, cap1 and zero reviewer suites. It ends with a report and the
usual guarded closeout. A fresh finite apply continuation, bound to the original
item/packet and review, executes accepted decisions and reports; no session stays
open waiting. That continuation performs mechanical application, not a second
judgment review. Findings follow the existing one-correction/fix-forward rules;
Majors block application of the affected packet until specifically corrected.
An apply continuation that needs a new substantive decision returns to a new
scoped pass rather than silently revising the reviewed packet.

The standing supervisor is not the proposal reviewer, activation executor,
cursor owner or measurement analyst in the target path. Until LO1 supplies a
supported handoff, the existing supervisor procedure remains the actual owner;
this design alone cannot retire it. Exceptions retain the project's current
durable supervisor-inbox route and original receipt. D17 cannot grant canonical
supervisor, release, native recovery or reserved authority.

## Existing seams and the missing transfer

At inspected source `76d66f43693c15da61649f5459d0bc44fda3db9c`:

| Seam | Existing capability | Transfer required in LO1 |
| --- | --- | --- |
| Intake | `brain/lib/signals.mjs` builds bounded, provenance-linked digest pages; report learnings are signals, not confirmed causes. | Bind a page, cutoff and lesson inventory to one selected learning item/run. Preserve the current pending pass and cursor; do not overwrite another owner's page. |
| Judgment | `brain/distill.md` compares existing claims and requires two independent signals or one confirmed gate failure with a cause. It currently permits proposals only. | Distinguish proposer, one reviewer and finite apply duty; preserve this evidence bar and inspect actual review severity/source. |
| Lifecycle | `bin/org.mjs` exposes proposal, activation, retirement and atomic supersession with actor/time/sequence; `lib/lessons.mjs` selects by literal scope/path/module. | Validate a reviewed decision packet and apply through the existing CLI, retaining the actual worker actor and per-decision receipts. No second lesson store or model in the core. |
| Completion | The existing line starts selected work, records reports, queues one review and closes finished sessions/worktrees. | Bind review completion to one finite apply continuation using its original item, packet hash and attempt, rather than a supervisor callback or replacement launch. |
| Cursor | `brain/bin/brain.mjs digest --ack PASS` verifies the current pending pass and prefix. `brain/README.md` and `docs/reference/lessons.md` document the supervisor as owner. | Acknowledge only the exact completed pass after every included candidate has a durable disposition; keep new signals for the next page. |
| Consumption | `lib/render.mjs` injects active lessons into worker briefs. | Record intended target and an actual later application; a brief excerpt or activation alone proves neither changed policy nor usefulness. |

LO1 should extend these seams, not replace the digest, dispatch or record. Its
owner must inspect the current source before selecting files: this design is
not authority to edit saved effects, jobs, routes, pins or installed runtime.

## Where a lesson acts

Keep the claim short, agent-agnostic and in mindset form: a useful tension and
an action before work, not every incident retold as a new rule. Evidence remains
in the record. A lesson has three possible consumers:

| Target | Use and owner | Proof of application |
| --- | --- | --- |
| Worker brief | Local judgment when the trade-off recurs; the active lesson uses narrow literal selectors. | A distinct later run cites the lesson and explains a concrete plan/action changed, with its check or outcome. Text injection alone is only exposure. |
| Planning | Scope, sequencing or method selection; the finite planner with current delegated authority. | A later recorded planning decision links the lesson, considered alternative, chosen action and source result. Selection/priorities still belong to their real owner. |
| Line policy/source | A repeatable mechanical boundary or default; the affected source owner through a separately selected ordinary change. | Landed change and focused evidence, followed by the relevant installed/live witness. Activation is not authorization to change routing, holds, gates, cleanup or runtime. |

The decision packet records `lesson`, disposition/reason, exact evidence,
intended target, consumer item/owner, next event and observation owner. These
links use existing owning notes/reports; do not add target fields to the core
lesson schema merely to finish this slice. A missing consumer remains an open
handoff, not a fabricated success. Policy proposals that touch reserved effects
take the existing actual-operator path.

## Review/apply and recovery contract

Capture project/record identity, selected item/run/claim, digest pass ID and
prefix hash, input cutoff, each lesson's proposal/state event sequences, and
the immutable packet hash. The one review must identify that packet and its
source, with the actual verdict and unresolved findings. A reported PASS on a
different packet is inapplicable. Existing native/run/claim/source and
STOP/HOLD checks remain fresh at every mutation; a role label grants nothing.

Application records each successful CLI event before moving on. Merge means a
qualifying replacement is proposed and activated with `--supersedes` and a
reason, retaining every original; supersession is permanent, so a recommendation
must not be executed speculatively. Retirement records why a claim is stale,
unsafe or insufficiently supported; it does not erase history or claim its
original incident never occurred. Exact repeated activation/retirement can be
idempotent, but generic retries are not a recovery policy.

If a reply is lost or application stops halfway, inspect the original receipts
and current lesson events. Apply only proven unexecuted decisions still matching
the reviewed inputs. A concurrent proposal/state change, permanent supersession
conflict, failed review or UNKNOWN native effect holds the affected decision with
its original owner. Do not reconstruct a success or replace an uncertain launch.
The digest cursor does not advance over an unresolved candidate. A deliberately
declined signal may have a durable reason without creating a lesson. A new pass
must compare that prior reason, so retired claims are not automatically
re-proposed just because the digest no longer suppresses their evidence.

Test both an interrupted multi-decision apply and a stale/failed-review refusal.
The recovery must retain completed event IDs, the pending candidate and unchanged
cursor; a permitted continuation finishes once. No approval, refusal or lost
receipt may be bypassed with another actor, new packet ID or fresh digest state.

## Fixed-cutoff baseline and backlog

Evidence is saved under
`/Users/rewt/development/rewt/.org/evidence/ENG-1283-R-1731/`.
`baseline.json` captures record cutoff **61232**, **2026-10-31 20:44:18.478 UTC**,
with the normalized event-prefix hash, every lesson and its original provenance.
`lesson-events.jsonl` preserves the lifecycle source rows. There are **49
proposals, 24 activation events, 22 currently active, 24 waiting, two superseded
and one retired**. Activation-event count is not current-active count.

Across the captured 4–31 October history, supervisor-herdr proposed 47/49 and
activated 23/24. Non-supervisor actors proposed 2/49 (4.08%) and activated 1/24
(4.17%): L-19 is by brain-bch-coordinator; L-49 is by the ENG-1254 worker.
These are recorded actors, not proof of who typed or influenced a decision.
The ask's approximately 22 waiting was an estimate; the complete current fold
contains 24. Retirements and supersessions must also be measured as decisions.

The table below is the design owner's **recommendation for each waiting ID**,
not 24 live decisions. The finite learning owner must re-read original evidence
and record the actual lifecycle result through LO1 after this design's review.
None has been applied here. Do not count a completed table as cleared backlog.

| Waiting ID | Recommended decision | Reason and intended consumer |
| --- | --- | --- |
| L-14 | Retire | Report-before-landing is overtaken by the land-first waiver; D07/owning producer retains incomplete evidence honestly. |
| L-15 | Retire | Blanket release pre-runs conflict with current focused-check and non-blocking full-suite policy; release owner retains historical incident evidence. |
| L-16 | Merge into N1 | Preserve the confirmed shared-history leak without the incident narrative; fixture source owners consume isolation judgment. Original R-343 and its review/correction must be read. |
| L-17 | Retire | Another blanket release rerun prescription; its old runner limits cannot authorize current extra suites. |
| L-18 | Retire | Historical BCH-specific candidate environment is not a Brain-wide lesson or authority over BCH; exact installed canary completeness belongs to the release owner. |
| L-19 | Activate | Durable completion accounting and preservation of green evidence remain useful; finite report/notice owners must verify ENG-313/314 originals before applying. |
| L-21 | Retire | Legacy lane-review delivery workaround does not govern the current record queue-review path; keep original W-1 evidence. |
| L-22 | Merge into N2 | A changed contract needs affected consumers considered once, not a default broad suite; combine with L-41's confirmed release escape. |
| L-28 | Retire | Archive execution shape is a specific release acceptance control; preserve ENG-345 as precedent and let the release source owner encode the control. |
| L-29 | Retire | A universal no-overlap prescription and a historical duration are not a current admission contract; named proving/resource owners decide actual containment. |
| L-30 | Retire | Actor attribution belongs in supported command/identity bindings, not another global worker reminder; the run actor still remains mandatory. |
| L-31 | Retire | A fixed pane plus a polling loop would recreate the chat dependency; durable owned callbacks and D11 carry the obligation. |
| L-32 | Merge into N3 | Keep release-before-capacity reasoning for finite planners; remove historical counts and speculative universal ordering. Verify ENG-436/438 causal evidence first. |
| L-33 | Merge into L-19 | Tracked completion rather than an unread background result is the same durable-handoff tension; no new shell/background mandate is needed. |
| L-34 | Retire | Hand close-at-landing and retry-on-authority-change contradict the source-bound finite report/closeout contract. |
| L-35 | Retire | Git optional-lock hygiene is a concrete tooling control/reference, not a standing learned mindset; source owners retain ENG-444 evidence and current integration guards. |
| L-36 | Retire | Historical timeout/load inference cannot impose a universal concurrency ban or authorize replay; retain actual resource and proving contracts. |
| L-37 | Retire | Current failed/affected/unrun controls and release-offer rules supersede its unconditional final full-gate prescription; do not reinterpret it as release authority. |
| L-38 | Retire | One host copy observation is a diagnostic lead, not a broad platform claim; retain ENG-523 for an affected troubleshoot owner. |
| L-39 | Retire | Fresh-name/executor workaround advice risks bypassing a native refusal; the original guarded closer and exception owner retain the effect. |
| L-40 | Retire | Framework-wide config-home relocation advice crosses trust/pin and other-project boundaries; retain incident evidence without instructing an unscoped rollback. |
| L-41 | Merge into N2 | Preserve the confirmed missing-consumer failure, bounded by current selected affected checks and native exclusions; ENG-534 event 14986 names the cause. |
| L-47 | Retire | Current brief/AGENTS already say no default suite and unrun is never PASS; retire the obsolete generic-default premise. |
| L-48 | Retire | Blanket watcher recreation, abandonment and outage reruns can discard original attempts; current recovery needs exact receipts and actual authority. |

The proposed merges yield these candidate mindsets, each below 400 code points.
They are not new L IDs or activated claims. If the finite owner cannot verify
the required cause/independence, it records a reasoned retirement instead of
merging on the strength of this summary.

- **N1:** A disposable worktree can still write shared state. Keep fixtures
  cheap, but redirect every state root in both the product process and its
  children, then verify that the real roots stayed unchanged.
  Evidence lead: R-343's confirmed gate-history leak and correction; consumers
  `test/helpers` and `test-slot`. Compare active L-3 before creating a duplicate.
- **N2:** Focused checks save time only when they follow a changed contract's
  consumers. Map affected assertions across module boundaries once, run that
  selection, and retain unrun native controls with their real owner.
  Evidence leads: W-2 and ENG-534's confirmed release escape (event 14986);
  consumers are affected source/check planners. This does not select new suites.
- **N3:** A capacity gate can protect a system or stop its recovery. Before
  enabling a new limit, verify that its matching release path is usable and
  that held work retains its owner.
  Evidence leads: ENG-436/438; consumer is the finite planner/source owner.
  No activation without verified causal evidence under the normal bar.

This recommendation intentionally includes 18 retirements, five merges and one
activation. Retirement is an evidence-based disposition, not a quota; the
review/new owner may change recommendations with a reason. Existing active
claims are outside this backlog application, not presumed current or useful.

## Outcome window and proof

LO1's initial pass owns a **seven-day observation window**, beginning at the
first successful reviewed application, not this document's timestamp. This is
a proposed bounded observation period, not a promised time-to-decision SLA or
new schedule. At that application the finite owner records the start event,
end time, observer item and next ordinary completion event to inspect. The
observer ends in a report even if no matching demand occurred; no waiting chat
or new polling loop is required. Inconclusive demand remains inconclusive.

At fixed start/end cutoffs, report:

- All `lesson.proposed` events and each first activate/retire/supersede decision,
  by exact actor, with numerator/denominator for non-supervisor share. Show
  activations separately for baseline comparability. Idempotent commands and
  reactivation are not new first decisions. Retain unknown/ambiguous actors.
- Proposal-to-first-decision elapsed time per ID, median and range for decided
  IDs; list undecided IDs and their ages separately. Cohorts are by proposal
  time; initial backlog is a separate cohort. Never silently omit waiting IDs.
- All 24 initial IDs joined to actual decision event/reason, with any changed
  recommendation, missing evidence and retained owner. Target: 24/24 terminal
  decisions and no standing-supervisor proposal/decision in the new-path cohort.
- At least one genuinely new proposal and decision through that path, and at
  least one distinct later run or line/planning decision applying an active
  lesson. Capture lesson event, later run/decision, changed action, observed
  result and limitations. Self-citation by the activation pass is insufficient.

The new path passes only with the backlog decisions, new proposal/decision,
later application and the failure/recovery witnesses. A table, digest ACK,
activation total, exposure in a brief or a quiet supervisor proves less. Missing
demand, a pending policy change, unavailable original evidence or supervisor
intervention remains explicit. No source check here proves that future window.

## One build slice and review handoff

**LO1 / ENG-1286 — Bind a finite learning pass to review, application and observation.**
Filed unselected under ENG-1283, with an accepted dependency on this design.
The full ask is saved in the owning record's
`evidence/ENG-1283-R-1731/build-ask.md`. Use Sol xhigh after this design's one
Opus review and any assigned correction. Extend existing selected dispatch,
report/review continuation and digest seams; implement input/packet validation,
per-decision receipts, interrupted-apply recovery and exact-pass ACK. Update the
three supervisor-owned distillation procedure surfaces together:
`brain/distill.md`, `brain/README.md`, and `docs/reference/lessons.md`. File the
initial backlog/new-proposal pass and its observer with actual owners and next
events, leaving selection with the recorded planner. Do not claim that filing
or an offline fixture witnesses live application.

Producer verification for this design selects only existing
`test/lessons.test.mjs` through `test/helpers/run.mjs` and the lane check, once on
the clean committed candidate. It verifies the lifecycle, atomic invalid-input
refusal, evidence retention, idempotence and active-brief behavior relied upon;
it does not exercise LO1. LO1's own owner selects its changed-focused tests,
including interrupted apply and stale review/cursor cases. Full suites,
installed canary/soak, absence, live learning and BCH adoption are UNRUN here.

The report supplies immutable landed base/head, the actual check receipt and
the saved baseline to the existing single queue-review path, route `review`
(Claude Opus), cap1, zero suites. No pre-code review or parallel settle review
is started. The line retains the review callback and guarded worker closeout.
The initial learning pass/new-path window remains the build successor's explicit
handoff obligation; the original retirement observation owner must consume D17
before claiming all supervisor duties transferred.
