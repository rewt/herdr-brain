# Permanent close-on-report decision

Decision owner: ENG-852 / R-1192, 2026-10-28. Authority: the explicit engineering
decision ask, within the existing lifecycle and decision-routing boundaries.
This is an implementation and proof contract. The runtime described below is
not implemented, released or proven by this document. Current behavior remains
documented in [CLOSEOUT.md](CLOSEOUT.md).

## Stage and release

Make this a dedicated stabilization milestone within Stage 2, delivered as
**Herdr Brain 0.2.0**, a narrow closeout fix release. The operator's 15:0x
direction makes this the single top priority; other Stage 2 work yields to it.
A separate broad roadmap stage would add no missing
technical boundary. A dedicated release does add a useful boundary: one immutable
runtime, its compatibility/migration evidence, its acceptance results and a
measurable observation window. Do not bundle unrelated feature work into that
candidate or make this depend on the Stage 3 message bus / ENG-685.

The source currently declares 0.1.0. Keep the existing immutable candidate ID
shape `rc-YYYYMMDD-SHORTSHA`; the candidate's committed package version becomes
0.2.0 in ENG-856's release preparation. Record a one-to-one mapping from the
selected candidate ID to its full commit and package version in the existing
release evidence. Multiple failed candidate IDs can belong to planned 0.2.0;
exactly one accepted candidate becomes that release. A correction after acceptance
gets a new version/candidate. Do not rename, rebuild or relabel the already active
date-based release, and do not use a version string as an identity/trust pin.
No release helper or manifest schema change is needed just to express the label.

The canonical release coordinator owns candidate selection, full final-release
coverage, specific Major corrections, actual live acceptance, activation and
rollback. Each project owner owns adoption and service changes. This decision
performs none of those effects and grants no new native permission. The operator,
not this worker, authorized the priority change and dedicated minor release.

The decision task is complete when this contract and its ordered work are filed.
The permanent repair is complete only when implementation, release/adoption and
the observation gates below are complete. A source landing is not that claim.

## Evidence and reconciliation

Read in full for this decision, in the owning record under `.org/`:

- `evidence/CLOSE-ON-REPORT-PERMANENT-20261028/{sol.md,claude.md,COMPARISON.md}`.
  The comparison was initially unavailable; the supervisor supplied notice of
  completion and it was consumed before finalizing this decision.
- `runs/R-1176/report.md` (ENG-837): projected report/session event order was
  wrong; targets became empty; slow intake/review exhausted cleanup selection.
  Three source repairs landed, but the 19:24:45Z snapshot still retained 26
  clean finished worktrees and four finished sessions older than two hours.
- ENG-757 and ENG-761's recorded ruling, and `runs/R-1141/report.md` (ENG-812):
  an uncertain native effect cannot be replayed or reobserved into completion;
  only its actual original completion or the narrowly admitted positive
  never-started proof advances it.
- `evidence/CLOSEOUT-MECHANICS-20261027/COMPARISON.md`: duplicated ready/landed
  requests, nonproducing waits, main movement between intent and invocation,
  and separate session/physical passes already produced stranded closeouts.

The recurrence class is incomplete allocation accounting and progress. Repairing
one ingress bug or increasing a budget does not ensure that every finished
allocation reaches an effect outcome or a resolvable exception. Hand cleanup
can conceal this. The current implementation already has some owned-stage
continuations and ENG-812 cases have progressed; the research phrase "nothing
ever retries" is too broad. The gap is total coverage and valid continuation,
not an absence of every continuation mechanism.

Research observations have different cutoffs and denominators. For example,
Sol's 75 direct targets and Claude's 163 reports are not interchangeable cohorts.
Their snapshots are evidence of the defect, not a fresh census or a measured
post-fix success rate. No live recount is needed to decide this design.

Accept the shared proposals for independent closeout scheduling, fast ingestion,
typed facts, complete allocation accounting, explicit partial outcomes, no bus
dependency and sliced proof without hand closes. Retain the completion/resume
pointer so a fresh reviewer/fixer reconstructs work from durable evidence.

Reject the comparison's claimed consensus that pane/terminal alone replaces the
native session identity: Sol explicitly requires immutable allocation identity,
and the existing guards require the actual session. Capture late session binds
correctly; never weaken identity to conceal a missing bind. Also reject deleting
UNKNOWN/intents, automatically retrying every native failure, expiring refusals,
and stopping leftover processes merely from uid/cwd or vacancy. These are not
authorized by the ask or ENG-761. Original process owners must finish their
teardown or supply admissible recovery evidence. Prose can falsely classify a
refusal; that does not prove that every historical refusal was false.

## One obligation per allocation, one effect executor

Use the existing durable record and guarded retirement executor. One logical
obligation is keyed by owning Git common-directory identity, run/claim generation
and immutable allocation generation; topic names and agent labels are locators,
not authority. Preserve source report hash/sequence, original launch and late
session evidence, pane/terminal/session, registered worktree and branch generation,
head, author packet and saved-session resume pointer. Legacy keys/events remain
immutable aliases to their original scope, never a second opportunity to act.

Every final report outcome (done, blocked, failed, needs_human) and abandonment
creates the obligation or an explicit binding exception in its source transaction.
An empty pane array cannot silently mean both "not applicable" and "lost identity".
The latter is a visible defect. A never-prompted idle agent is not finished by
age: its original dispatch producer must record its terminal result and an
authorized abandonment. Report availability alone requests validation/ingestion;
it does not authorize closing an active or foreign occupant.

Track session, folder and branch outcomes independently within one operation:

| Resource | Desired result | Required exception/proof |
| --- | --- | --- |
| Finished session | Close the verified non-working occupant and its tab | Working/replaced/missing identity, real refusal, uncertain invocation or STOP/HOLD stays scoped and retained |
| Lane folder | Preserve evidence, then remove a clean unused folder | Unsaved bytes retain the folder; active process/reference, ownership or preservation uncertainty blocks removal |
| Branch | Delete only if already on main | Otherwise retain the exact ref/head for a fresh fix; never infer integration from the item status |

"Same step" means one bounded owner operation records all three dispositions
after attempting admissible work. Native and Git effects are not an atomic
transaction: a closed session and dirty retained folder is a valid partial
result. It does not wait for a review, and a fresh fix receives the report,
immutable diff, failed/unrun proof, Major obligations and resume pointer.

Reuse the birth-aware consumer/retirement owner and actual dispatch exclusion.
No allocation can be reused while retirement owns it. Do not hold a record
transaction during a native command or hold the general pass lock to finish
closeout. Preserve tab/promotion lock separation and fresh native/claim/source,
clean tree, expected head, CAS/FF, STOP/HOLD and preservation checks at effects.

## Scheduling and durable progress

Make a finite closeout turn a dedicated role of the existing line installation,
independent of its general intake/review pass lock and allowance. It invokes the
existing guarded closer, not a parallel cleanup implementation. A validated
report availability hint first runs bounded ingest, then requests this turn
after source commit and lock release. Future original watcher code can emit the
hint; retained/saved watchers and their recipients are not replaced.

The owning service supplies a separate approximately 60-second finite wake and
startup reconciliation of committed obligations. This is a small justified
scheduling addition: a wake behind the 22-minute general pass cannot meet the
latency contract. It is not a background loop in the core, a model call, a
general message bus, a per-allocation queue or a second native executor. Its
installation and sole-owner transfer belong to the canonical project owner in
the release. General-pass and legacy entry points delegate to the same role;
they cannot race it with another drain.

Record the obligation/continuation before acknowledging a wake. Coalescing and
lost wakes cannot lose work because the record is the source of truth. Choose
fair finite batches, checkpoint before yielding and let kept targets yield to
independent targets. Each first turn writes a closed or typed-kept disposition
for every selected allocation, including pending native completion. A successful
midpoint supplies a continuation, never a missing-producer decision.

Separate ordinary pre-effect conditions from uncertain effects:

- A contended lock, working agent, owned teardown or dirty folder observed before
  invocation can be freshly observed on a subsequent admitted finite turn.
  A general OUTCOME_UNKNOWN label must not turn that observation into a native
  command with a lost reply. Record the actual condition and continuation.
- A native invocation has its original intent and exact producer-linked terminal
  outcome. A lost reply retains UNKNOWN. Another turn cannot resend, reobserve
  or substitute pane absence, a timer or another producer's result for it.
  Preserve the existing ENG-812 finite historical non-execution bridge.
- A real native/harness refusal stops that effect. No alternate executor,
  identity substitution or expired hold permits it. A missing original producer
  is an owned defect, not a fictitious event subscription.
- Use typed, effect-specific refusal/hold facts rather than scanning all report
  prose. New text saying "not a native refusal" creates no refusal. Preserve old
  bytes; ambiguous legacy prose requires scoped original-owner evidence and
  does not auto-clear historical uncertainty or a real refusal.

Every kept outcome names exact scope, reason, evidence, first-seen age, actual
owner and either an existing completion producer or an admitted pre-effect
observation. Retain one aggregate supervisor alarm with counts/oldest scopes;
do not mint a new decision item for each unchanged keep/pass. After three
no-progress turns or 30 minutes, expose that alarm, without changing authority
or stopping independent work. Native-refused/UNKNOWN effects are never retried
to reach that count. A clock detects a defect; it supplies no cleanup permission.

Scope observations/CAS to each effect's actual footprint. Unrelated canonical
index activity must not discard independent binding/progress transactions.
Actual policy/config, source epoch, allocation, target identity and mutation
inputs remain protected. A changed loaded code epoch still exits and hands off
through the existing guarded protocol; this design does not ignore main movement
or retrofit a newly loaded identity into an old attempt.

## Ordered implementation

File these as real work, not speculative report proposals; no dispatch or
supervisor cycle mutation is performed by the decision worker:

1. **ENG-854**: total allocation/source binding, fast report ingestion and the
   exclusive independently scheduled finite closeout role. Prove late session
   binding, wake loss, source/ingest crash boundaries, single ownership and
   nonstarvation under slow review. Includes terminal failed-dispatch accounting.
2. **ENG-855**, blocked by ENG-854: typed progress/keeps, partial resource outcomes,
   exact-producer completion, scoped legacy handling and narrow effect inputs.
   Prove useful pre-effect continuation, false-prose refusal versus real refusal,
   branch/dirty-byte preservation and zero uncertain-effect replay.
3. **ENG-856**, blocked by ENG-855: measurement/oracles, original-owner backlog
   inventory, 0.2.0 package/release mapping and coordinator release/adoption/live-
   proof handback below. Keep the acceptance item open until actual evidence
   satisfies every gate. All three items have dispatch priority 1 under the
   operator's direction; the existing scheduler applies it.

Each engineer selects affected checks once using the existing runner/lane check,
lands finished OWN source first and hands immutable base/head/evidence to ONE
asynchronous other-family record review, cap1, zero reviewer suites. No pre-code
concurrence or repeated full review is added. Subsequent Majors retain their
specific correction checks before release. Do not use same-batch unblocks links.

## Proof and observation

The measurement owner is the existing project service, implemented in ENG-856;
the release coordinator consumes its evidence once. Extend existing measurement,
summary and audit artifacts, with no new operator pushes or model observer.
At every closeout turn and at least every 60 seconds, retain complete current
native/Git/process inventory coverage, source version, record cutoff, report
cohort and effect receipts. Publish aggregate counts and oldest exceptions to
the existing project supervisor diagnostic/digest path. Real reserved questions
alone use the existing reserved channel.

Record separately: report availability, ingest, first disposition, actual session
close and actual folder removal. Use a trusted original producer/watch observation
bound to report hash for availability. A bare file mtime or first later scan
cannot prove earlier write-to-ingest latency; missing origin time is UNKNOWN.
Do not restart the age clock when eligibility changes, a run resumes or a source
epoch moves. Record real hold intervals separately and expose all exclusions.

| Measure | Required result |
| --- | --- |
| Allocation accounting | 100% of every report outcome, abandonment and terminal dispatch failure has closed or typed-kept session/folder/branch outcomes in its first bounded turn |
| Report availability to first disposition | p95 <= 2 minutes; include ingestion delay and report the separate ingest clock |
| Eligible finished session close | p95 <= 2 minutes, maximum <= 5 minutes from report availability; separately expose genuine held intervals |
| Finished sessions still open over 2 hours | 0, including protected/held finished sessions; a justified hold does not make this absolute count green |
| Clean idle folders after a completed drain | 0; show transient in-pass backlog separately, and retain every safety-held clean folder in the absolute count |
| Orphan processes in finished vacant lanes | 0; owners resolve them through authorized teardown, never a generic cwd/uid kill |
| Manual assistance / unexplained disappearance | 0 supervisor hand closes or sweeps; absence without an exact automated receipt is unexplained, never presumed automatic success |
| Safety | 0 wrong-occupant closes, lost unsaved bytes, deleted unlanded refs, replayed UNKNOWN commands or bypassed STOP/HOLD/refusals |
| Exception visibility | 100% typed scope/evidence/owner/age/completion route; 0 unaccounted or fictitiously subscribed waits |

Split every numerator/denominator, latency and oldest age by **project**, **Codex
or Claude**, and **line or supervisor dispatch**. Unknown origin remains its own
visible bucket. An empty slice supplies no evidence for that slice. Measure
manual cleanup separately from receipt-backed removal; a missing inventory,
disappeared target or unknown classification cannot improve the success rate.
Dirty retained work is allowed and listed with its owner; clean retained work
keeps the absolute-zero folder gate unmet. Report the untouched historical
guarded cohort separately as well as in absolute counts; never remove it from
the denominator to claim success.

The coordinator's release evidence includes disposable failure/recovery controls
for wake loss, process/service restart, late session identity, concurrency,
main/source changes, partial effects, refusal, UNKNOWN, STOP/HOLD and dirty work.
Metric oracle controls must deliberately inject a manual close, missing inventory,
false refusal and cohort exclusion and show that they prevent a green result.
Worker/reviewer suites never substitute for full final-release and live acceptance.

The narrow candidate contains these slices, their necessary compatibility,
packaging and correction work, and required acceptance evidence, with no unrelated
Stage 2 feature bundle. Existing immutable release snapshots necessarily contain
their base history; this is no request to rewrite main or remove unrelated already
landed work. The coordinator records the actual base/head and included fixes.

After full required preactivation checks and actual live acceptance, the
coordinator can activate the narrow release under existing authority. Shipping
and the sustained permanence claim are separate: keep the milestone open while
proving the candidate in the owner-authorized
Brain pilot for **72 continuous hours and at least 100 actual closeouts**, whichever
takes longer. Include both harnesses and both dispatch origins, overnight work,
an owner-controlled service restart, release cutover and an hour with at least
10 real landings. BCH's owner adopts under its own checks, then demonstrates
**48 continuous hours and at least 100 actual closeouts** with the same coverage.
Low traffic extends observation; this is no authorization to generate live load.

Then require **seven consecutive days with all measures met in both projects
simultaneously**, retaining the same slices and no manual assistance. Any safety
breach, hand sweep, unexplained disappearance, missing measurement coverage or
closeout-affecting source change invalidates/resets the affected proof window.
Coordinator-owned restarts count only with complete continuity evidence.
Neither waiting seven days nor passing a test proves a universal guarantee;
these gates establish sustained observed closure under specified exposure.
Continue the same watch afterward and reopen a regression from its exact scope.

Current status: implementation and live gates **UNRUN / NOT MET** by R-1192.
The original guarded backlog remains owned and protected. The decision worker
does not hand-close it, restart a service, alter a watcher/pin, kill a process,
edit BCH files, activate a release or certify permanence.
