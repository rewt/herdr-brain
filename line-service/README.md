# Minimal line service

For the contained startup-notice backlog, the owning native supervisor can run
this explicit source control from its canonical project checkout:

```sh
HERDR_BRAIN_ROOT=/Users/rewt/development/rewt/herdr-brain /Users/rewt/.nvm/versions/node/v20.19.4/bin/node /Users/rewt/development/rewt/herdr-brain/supervisor/prompt-supervisor.mjs --handle-pending-line --org /OWN/RECORD --id STABLE_BATCH_ID
```

It selects all currently safe PENDING `[line-service]` notices addressed to
`brain-chat` in that record, not an old startup manifest. One immutable bounded
manifest and one existing `session.message.v1` record envelope precede explicit
handling. Original inbox bytes, sent entries, uncertain/in-flight attempts,
obligations, unrelated recipients and order remain. Existing `autopilot` handled
events let retained inbox readers recognize the disposition; no SENT, native
delivery or model consumption is claimed. Retry the same ID only for the same
saved batch. New arrivals stay pending and are returned explicitly.

The control requires actual project/record/caller/recipient/source bindings and
uses the SAME drain and journal locks without owner probes/recovery. An occupied
lock, source/native change, redirected receipt, unknown project or changed
notice state refuses before further handling. It never prompts, resumes,
restarts or signals the inbox owner. A refusal is not authority to use an
alternate executor or edit the journal. Only the project owner executes this
control; the worker supplies source/affected evidence. This is not permission to
restart either stopped line service.

## Phase1 source contract

The operator approved the whole Phase1 implementation on 2026-10-26. Source
landing and offline checks do not claim live acceptance. Brain must first prove
one existing small item through start, land, report, review, verdict, source close,
worktree removal and session retirement without a chat session operating it.
Then BCH's own supervisor performs the same proof. No Fera or public effects.

Each model-free launchd pass uses the existing record, native dispatch, route,
claim, closeout queue and transport. It never promotes another owner's work or
calls a model API. The supervisor installs from committed canonical development
source with pinned Node20.19.4, actual native path/socket and its own project.
BCH effects belong only to BCH's supervisor. No pins, saved consumers, old
watchers, claims or retained ambiguous/native-refused attempts are replaced.

```sh
node line-service/launchd.mjs install --repo /OWN/CANONICAL --org /OWN/RECORD --to PROJECT_SUPERVISOR --herdr /ABS/herdr --socket /ACTUAL/herdr.sock
node line-service/launchd.mjs status --repo /OWN/CANONICAL
node line-service/launchd.mjs stop --repo /OWN/CANONICAL
node line-service/launchd.mjs restart --repo /OWN/CANONICAL
```

Stop writes this service's STOP and boots out its exact saved job. Restart proves
the saved job absent and archives its STOP before one bootstrap. Refusal or
uncertainty retains STOP and its receipt; it grants no alternate-executor retry.
Project STOP/HOLD, actual native identity, claims/generation, source cleanliness,
main CAS/FF and archives remain mandatory. Ordinary lock recovery requires fresh
positive ESRCH, existing recovery serialization, owner re-read/CAS and original
owner archive; live, EPERM and unknown stay held. There is no force entry.

The original service cutover remains immutable. Before Phase1 activation, the
owning native supervisor records its designated intended pre-Phase0 SOURCE
boundary with the existing stopped-service helper:

```sh
HERDR_BRAIN_ROOT=/Users/rewt/development/rewt/herdr-brain /Users/rewt/.nvm/versions/node/v20.19.4/bin/node /Users/rewt/development/rewt/herdr-brain/line-service/cutoff.mjs --repo /OWN/CANONICAL --org /OWN/RECORD --id STABLE_PHASE0_ID --cutover --phase0-head FULL_DESIGNATED_HEAD --evidence /DESIGNATED/PRODUCER/LOCATOR
```

This appends one `line-service.phase0` event under pass/promotion/record locks and
fresh own native/project/source guards. It never rewrites the earlier cutover or
starts a runtime. Brain's designated intended source boundary is
`ff88cae6cc7db0140debe47bc3f55fafed46d6c7`, archive
`archive/phase0-land-first-20261026-pre`, captured before Phase0 instruction edits.
The original receipt qualified the exact18:55 head as UNKNOWN. Later designated
owner evidence confirms Brain's same head at18:55 (move18:54:47), and BCH's own
`8add6fb831a20f8a2db3e91b805ea8ba83a01903` (move18:53:55). Preserve both the
original qualification and later evidence; completion measurements alone are not
an18:55 observation. Brain's SHA supplies no BCH authority. Without any valid
boundary, the installed service records its first actual clean canonical main
once under pass/promotion/record guards, with no invented historical time.

Reviews are owed for each actual landed build commit strictly after that source
boundary, including a closed item or removed producer worktree. Two Git reads
index the interval; old reports outside it perform no per-report Git, hashing or
native inventory. Canonical `rev-list` defines owed commits; immutable reports
and native landing facts attribute them. Unclaimed/unreported commits remain
visible in health and the record inbox. Immutable report bytes and original
dispatch/source attribution bind the delivered diff. Unknown attribution holds
only that review branch.
Red checks or a blocked report do not disqualify genuinely landed changed code.
Only an existing attempt for the SAME source item/head or immutable producer
item/run/report group blocks a new review.
Unrelated old private review directories do not establish an attempt. A real
same-change UNKNOWN/native refusal remains held. Routine recovery requires strict
original-request proof; a timer or missing run never establishes inactivity.

The current queue helper creates ONE ordinary reviewer item for the whole
immutable producer report/source group, keyed by its item, final delivered head
and report hash. Its explicit source/base range or captured owned commits include
intermediate and final source; interleaved commits attributed to other producers
remain context with independent coverage. It never creates a separate review for
each intermediate/final tuple in the same report. Red producer checks still
permit review of genuinely landed source. Existing partial/active/UNKNOWN
reviews, independent verdicts and cap1 remain immutable: no retarget, cancellation
or replacement. Their exact coverage is counted without claiming the whole
producer has been reviewed. Strictly later attributed commits outside every
retained capture receive one immutable `supplemental-review/v1` target through
the same record queue. Its evidence binds the prior targets, exact owned commits
and recorded landing/report provenance. Earlier captures, native attempts,
verdicts and cap1 stay unchanged. Overlap, an UNKNOWN prior scope or a gap inside
an earlier captured interval remains held; none permits a duplicate or retarget.

Commits with no recorded producer use `queue-review canonical:FULL_SHA` in the
genuine installed canonical service context. The ordinary reviewer item owns
the **current** review responsibility and references itself as its source item,
with a null source run. Its `canonical-unattributed/v1` evidence preserves null
historical item/run/owner, binds the recorded boundary and exact canonical diff,
and never emits a synthetic producer run or landing. The canonical index keeps
that historical attribution missing while counting the exact queued/verdict
coverage. Ambiguous attribution and exact-head UNKNOWN attempts remain held.
Verdicts and linked Major corrections use the existing record path and cap1;
release still requires actual Major correction checks.
Its bound immutable target/evidence is checked again before every native effect.
New source dispatch uses the configured normal review selection (review-sol-max)
and a registered `review-` worktree at that exact head. The review pool defaults
to three sessions, separately from the seven-build default. An explicit
`dispatch.max_total_sessions` shared ceiling remains mandatory when configured;
otherwise the combined ceiling is the sum of the two pool limits. Legacy
combined callers retain their old bound. Old settle reviewers and uncertain
native attempts still consume review and combined capacity.
Saved owner/pinned consumers retain their original selection. A matching explicit
source selector does not fabricate native/run authority. Unknown queue/helper
capability holds before launch.
An already loaded development helper keeps its immutable target/group capability
when unrelated source files land; a global eighteen-file equality check cannot
invalidate the in-flight request. Immutable saved bundles keep their byte fence.
Matching source selection, actual run/controller ownership and fresh native,
record, target/evidence and worktree guards still precede effects. Capacity
continuations use typed original guard receipts plus positive prelaunch evidence
and fresh admission, not words such as "unknown" in another session's occupancy
diagnostics. Real native/identity/ownership refusals stay stopped. An unavailable
native-launch flag is recorded as null, never defaulted to false.

Every review error is recorded in the existing record inbox on its first
occurrence, with a durable count and stable deduplication. Each real pass records
owed/queued/running/done producer groups and separate commit coverage,
attribution gaps and formal-fix exemptions. More than three real passes with a
queue/coverage gap create one deduplicated notice. The morning digest includes
these observations; no extra scan, native prompt or benchmark is started.

The installed service observes normal queue progress across real passes. With
unchanged source/request evidence it can archive one inactive attempt and create
one normal-route replacement, without a supervisor command. It first serializes
the ORIGINAL request under its existing lock: live/denied/unknown owners stay
held, and only the existing positive-ESRCH recovery applies. A persisted
pre-record-start protocol barrier, or an ended fully bound reviewer process plus
positive native pane absence, must establish inactivity. Working reviewers,
incoming reports, native refusals, unresolved exit intents, partial/ambiguous
producer groups, source/claim changes and STOP/HOLD all retain the attempt.
Original journals and UNKNOWN/native flags are archived unchanged, no verdict
is invented, callbacks are retained, and cap1 permits only one replacement.
Prepared archives resume with the same bytes when an unrelated service update
occurs. Neither this path nor the explicit legacy recovery launches a reviewer;
the ordinary guarded queue dispatcher owns the new worktree/session.
An existing pre-start partial request with disjoint immutable sibling scopes can
instead continue its ORIGINAL request, target and cap. The service records and
archives a positive serialized prestart proof; its old UNKNOWN launch flag stays
null. Current source validates the captured landed range and evidence, and
refuses overlap, changed ownership, source/evidence, native presence and HOLD.
No new review item, replacement or target expansion occurs. A completed sibling
PASS remains scoped to its own exact range. This exception is for the proven
original request only; new producers still enqueue one whole report/source group.

A recorded `worker` barrier with explicit `native_launch_attempted: false` can
also continue the original run, including a captured partial range. The current
claim generation must match the saved ownership; no recorded worker, native
process or session binding may contradict that barrier. Old implementation-change
outcomes have an exact legacy mapping to a typed outcome, never a broad text
exception or conversion of TRUE/UNKNOWN launch evidence to NOT STARTED.
An unchanged `watch` or `prompt` request can finish its first prompt through
`dispatch --retry JOURNAL --continue-review` after the installed progress path
archives `review.original-continuation`. This requires the original fully qualified
session, terminal, pane, workspace, process birth and claim, with fresh idle native
readback. Unqualified sessions, working agents, `prompting`/complete requests,
reports and ownership changes remain retained. The dispatcher rechecks the same
process/session before delivery, uses the existing watcher contract and original
callback, and never adopts, relaunches or resends uncertain input. These proofs
authorize only the original request and captured range, without a replacement.

Reviewers inspect only the immutable diff and producer evidence, with zero
suites/edits. Their normal report says `outcome: done`, `verdict: PASS|FAIL` and
uses `- [Major] path:line - explanation` / `- [Minor] ...` findings. The record
stores verdict/findings against source item/head. FAIL/Major creates one linked
engineer correction; Minor creates one follow-up. Existing engineer proposals
are preserved and linked. Corrections retain the original review and never
create a re-review chain. The current service can record these facts from
immutable already-ingested bytes even when the selected record consumer is old;
it uses its actual owned pass/installation and fresh run ownership, without
changing that consumer, a pin or the report. Major correction checks remain
required before final release.
An explicit verdict may be in frontmatter or a standalone `Verdict: PASS`,
`FAIL` or `NEEDS-WORK` body line. Quoted/fenced examples grant no verdict;
missing, unknown or contradictory declarations hold intake. The fact records
the declaration location and original report hash; report bytes are unchanged.

An explicit review hold is a decision note on the source item or its run that
starts with `REVIEW HOLD:` (or an existing explicit hold/retained-reviewer
phrase) and names the change's full commit:
`record note SOURCE_ITEM "REVIEW HOLD: FULL_SOURCE_HEAD; reason" --decision`.
The service checks the note for each captured commit as an exact full string
(a label such as `head` may touch it; a longer hex run may not), so a hold for
another commit binds nothing. An explicit hold that names no full commit holds
its run conservatively. Other decision prose that mentions reviews, such as
"no duplicate worker/review", is never a hold. Queued/native/UNKNOWN attempts
still retain their original ownership and cap.

Each pass writes a heartbeat, ingests an actual valid report as soon as its file
exists, conditionally source-closes genuinely done integrated work, drains named
closeout keys and considers independent READY work. It does not wait for native
idle to ingest. A blocked report cannot start again until an actual note, answer,
unblock or changed brief arrives; unresolved dependencies/HOLD still refuse.

Starts use `dispatch --detach`. The original journal reserves capacity before
spawn and returns immediately; each candidate and the child perform fresh
admission/readiness checks. Foreground commands stop only for measured silence
AND confirmed inactivity of their own unchanged child; elapsed time alone and
unknown activity never authorize a signal. The eight-minute work allowance
defers new scan/cleanup work and never terminates an active child. READY admission
gets its own unchanged allowance after those stages, with a passive stage receipt;
unrelated long productive cleanup cannot use it up. Native pool limits and fresh
source/readiness/STOP/HOLD checks still apply to every new start. The two
legacy-named memory phases now pause only for a genuine live proving reservation.
Memory pressure is observed, never an admission wait. Lost launches/prompts are
retained, never resubmitted. New detached watchers record callbacks without
prompting a session; already-saved watchers keep their original recipients.
An original preflight with positively recorded `native_launch_attempted: false`
can continue through `dispatch --retry JOURNAL --continue-preflight`. The service
uses that same entry after a deterministic preparation failure, once per actual
helper capability. It preserves the request, route, immutable target and first
launch receipt, and recounts admission under the existing locks before handoff.
Missing zero-native evidence, a live/unknown native attempt, permission/identity
refusal, a different saved helper or an already spent continuation remains held.

For the explicitly authorized inactive legacy attempts, the owning native
supervisor uses the existing record queue entry from its own canonical checkout:

```sh
HERDR_BRAIN_ROOT=/absolute/shared/brain node /absolute/shared/brain/bin/org.mjs queue-review SOURCE_RUN --head ACTUAL_HEAD --base ACTUAL_BASE --recover-inactive --role supervisor --resolution /own/inactive-review.json --decision-seq OWN_DECISION_SEQ --id STABLE_ID
```

The decision is an existing normal `record note SOURCE_ITEM "..." --decision`
by that actual canonical native supervisor, recording the delegated choice and
the full source item/head. No new approval round is required. The resolution
input names the actual tuple and original evidence, never a packet/admission head:

```json
{"item":"SOURCE_ITEM","run":"SOURCE_RUN","head":"ACTUAL_HEAD","base":"ACTUAL_BASE","evidence":"/own/.org/reports/SOURCE_RUN.md","attempts":["/own/archive/original-review.json","/own/archive/original-review.log"],"inactive":{"kind":"never-created","verified_by":"ACTUAL_OWN_SUPERVISOR","reviewer":null,"evidence":"/own/archive/OUTCOMES.md"}}
```

For a recorded absent reviewer use `kind: "absent"` and its known `reviewer.pane`;
unknown agent/terminal/session values stay null. The control requires fresh native
inventory and positive pane-not-found, source ownership/clean/head CAS, exact
landed nonempty claimed source and immutable report bytes. Completed same-head
verdicts are preserved. A durable intent precedes fsynced evidence copies and an
exact-change resolution event. Originals, native intents, saved jobs and old
caps remain; at most one fresh cap1 normal-route review is queued. No boundary is
reset and no direct lane-review or native start occurs in this control. Changed
evidence/native ambiguity refuses that effect. A damaged archive cannot block
an unrelated change. Brain and BCH supervisors alone execute their own controls;
the implementation worker performs no BCH action.

Ingest and conditional close retry through their idempotent contracts. Named
closeout retries automatically on new target revisions or a pre-effect lifecycle
mutex/budget deferral with no unresolved native intent. A pre-effect changed-code
handoff retains its original requests for the next fresh drain. An unresolved
bound agent-exit intent permits outcome observation only: no prompt, tab close
or removal in that pass. A fresh exact shell/native readback can record the exit;
only that positive receipt permits the next guarded cleanup pass. Still-live,
replaced, permission-refused or unknown outcomes remain held, without replay.
Durable effect IDs and original bindings remain intact. Conditional source completion binds a landed cleanup request;
the executor still proves current identity, actual integration, callback release,
clean Git and archive preservation before any retirement/removal. The installed
line owns routine cleanup; competing automatic kicks/unnamed drains yield to it.
A closer verifies its committed import graph and main branch, so unrelated main
landings no longer invalidate it. A changed closer payload still hands off.

Routine holds and status use the existing record inbox, never session prompts.
Service and detached-dispatch foreground commands use the existing measured
no-output AND confirmed-no-activity policy, with a fresh owned birth check before
signaling only their own child. There is no 120-second elapsed execution kill or
ten-minute detached-controller stop. Unknown activity never authorizes a signal.
A retained dispatch receives read-only original-request/record outcome readback;
its original error, receipt and ownership remain. A missing run or journal never
proves zero native work and never authorizes replacement. Native ambiguity stays
with the owning supervisor; independent work continues.

An explicit owner/delegate NOT STARTED disposition can resolve one original
elapsed-stop request through the existing dispatcher. The owning canonical
supervisor records its scoped decision naming the exact item, original journal,
stable ID and full changed-source commit, then uses:

```sh
HERDR_BRAIN_ROOT=/SOURCE node /SOURCE/dispatch/dispatch.mjs --repo /OWN/PROJECT --org /OWN/RECORD --resolve-not-started /OWN/RECORD/dispatch/ORIGINAL.json --disposition /OWN/RECORD/DISPOSITION.json --decision-seq N --id STABLE --changed-source FULL_SHA --role supervisor
```

The immutable disposition data names `original_request`, `conclusion` beginning
`NOT STARTED`, and the explicit delegate `disposition`. Data alone grants no
authority. The control requires actual native caller binding and the matching
scoped decision, unchanged open/no-run/no-worker request and raw elapsed-stop
effect, fresh native absence, committed changed source, ready/unreserved item,
and an unchanged clean registered lane. Existing request serialization recovers
only positive ESRCH; live/denied/unknown owners refuse. STOP/HOLD remain fences.
It archives original bytes and records one disposition without rewriting the
original journal/effect or launching anything. Only that exact recorded input
becomes fresh for the line; the old request can never be retried. Native or
record progress invalidates the disposition instead of authorizing a duplicate.
Three occurrences of the same normalized failure create one envelope; every raw
occurrence/count is retained. A pass over ten minutes creates one record alert.
Only an actual pending explicitly reserved human question naming its decider can
use the existing one-shot native decision pointer, with the original stronger
session binding. Record errors have no native fallback.

A typed exact-target verdict completes the current review task independently
of its linked engineer corrections. The service conditionally closes that
immutable done review and publishes its ordinary closeout target, even while
its own fix proposal remains open. It never closes the source or fix item.
Missing/contradictory verdicts, ownership changes, reopened reviews, human
questions and independent blockers remain held. Retirement checks the typed
verdict/closure against the current run and retains all native occupant,
source/integration, callback, HOLD and archive guards. A FAIL reviewer may retire;
its product correction remains separately owned without a second review chain.

Physical removal seals housekeeping's actual owner files and their directory
identities, rather than unrelated activity logs or state updates. New/replaced
owners, unknown/redirected locks, target references, source/CAS changes and HOLD
still refuse; this makes no owner probe, process signal or lock recovery.

The installed line selects one least-recently-evaluated bound session request
and one independent physical-cleanup request per pass. Named `drain` supports
`--sessions-only --deadline 0`: it uses measured activity for owned commands,
records actual exit/tab-close results, and leaves worktree preservation/removal
queued separately. Zero disables the elapsed retirement allowance for exact
named targets only. A successful session phase records `sessions_retired: true`
with full physical completion still false; later cleanup never replays quit.
Each new native mutation rechecks the original source, claim, actual binding,
callback, STOP/HOLD and archive guards. Uncertain original intents permit only
their existing outcome readback, never another exit/close attempt. Evaluation
timings are passive observations of real passes, not benchmarks.

`node supervisor/closeout.mjs status --owner --repo /OWN/PROJECT --org /OWN/RECORD`
is a read-only compatibility/claim snapshot. It does not acquire/recover a lock,
probe a process, drain a queue or start a successor. It reports the actual loaded
source capabilities separately from the normally selected fresh root, whose
capabilities remain UNKNOWN until that implementation executes. Pins and saved
requests retain their existing selection. Stored owner tuples and exact receipt
bytes are preserved; old evaluations, handoffs, logs and elapsed deadlines do not
establish the original consumer's outcome. Even absent locks leave that outcome
UNKNOWN. A retained original owner needs its own bound terminal/outcome receipt
and exact claim release before its owner considers a successor; this status
observation supplies no native, retry or recovery authority.

Positive post-FF `change.landed` facts also feed the existing review queue before
the producer's final report. Each immutable evidence snapshot includes the
actual native worker, current Brain claim, original dispatch, named landed
commits and their whole range at capture. A pathname, admission head or routine
phase note cannot substitute for that evidence. The ordinary queue command and
review route retain the actual selected-consumer and native-capacity guards.
There is one queue item for that producer group; an existing UNKNOWN/manual or
partial attempt still prevents another. The captured scope is never retargeted
when a final report or later source arrives. Later commits remain visible in
canonical coverage debt, without a duplicate reviewer, invented coverage or
product completion. Landing itself makes no test or final-release PASS claim.

Routine notes (including phase evidence/decisions) and notification metadata do
not make a blocked item eligible for another worker or change a saved request's
frozen readiness. Actual task/acceptance edits, answered blockers, link changes,
explicit reopening and the existing bound brief change remain genuine inputs.
If the original blocked run subsequently lands source, that recovery keeps its
ownership until an explicit item reopen hands the remaining scope back. A phase
PASS is not a done report. Every pre-effect check still refuses real task,
ownership, native, STOP/HOLD or source changes. Already-started uncertain jobs,
their claims and watchers remain retained; this adds no retry or NOT STARTED
disposition and does not mutate an earlier immutable report.

Each hold fsyncs a compact notice delta to the existing pass audit. Full effects
snapshots are checkpointed at stage/pre-effect and final boundaries, rather than
once or twice per historical hold. First review errors and their one record
inbox envelope share a transaction. Repeats add no per-key event: each batch
writes at most one `line-service.review-error-counts` event with the new
cumulative counts. An older journal row that cannot prove its boundary is kept,
counted as `review_error_unbound` in pass timings and skipped; it never fails
the batch.
The digest counts occurrences across these checkpoints, retaining older events.
A lost checkpoint replays only exact validated notice deltas and stable message
IDs, never native effects or launches. Every new record mutation still checks
the actual installed service/pass ownership. Passive pass timings include full
journal write counts, notice attempts and counter batches; no extra benchmark,
watcher or elapsed worker stop is needed.

Producer validation receipts are distinct from independent review attempts.
Only source-bound lane-validation identities (including red or unrun truth),
exact existing foreign review/closeout record copies, and read-only diagnostics
linked to that positive producer evidence receive that distinction. The actual
native landed worker/claim binds their source. Unrecognized/manual receipts,
native/qualification/stage markers, changed proof bytes and actual launch
journals remain held; a receipt name, later HEAD or claimed green is insufficient.

The existing supervisor-bound `queue-review --recover-inactive` accepts
`--predecessor-preparation UNUSED_ID` for one exact archive-copy input correction.
It requires the same actual canonical native caller, identical source tuple,
original decision/intent/archive, and a newer scoped decision linking both IDs
and the old intent. Every old attempt byte must be represented by the corrected
original named settle files. The old preparation must have no completed review
or effects, and another preparation cannot claim its one replacement budget.
Both decisions and all old bytes remain immutable. Dedup exempts only these two
validated authorization notes; new independent holds, actual UNKNOWN/native
progress, completed verdicts and archive/source/claim/CAS changes still refuse.
There is no native launch in recovery, and no callback/journal/report rewrite.

```sh
node line-service/line-service.mjs --digest --org /OWN/RECORD --since 2026-10-27T00:00:00Z
```

The morning digest derives landings, verdicts/findings, holds, idle hours and
build-to-main minutes from record facts. New own lane promotions record their
actual post-FF time under fresh native/claim/source CAS. Historical containment
observations have `landed_at: null`; incomplete idle intervals stay UNKNOWN.
The service directory retains `passes.jsonl`, `effects.json`, `heartbeat.json`,
installation, STOP and original native output. Pass timings separate record/scan
cost from effect command time; they are passive next-real-pass observations.

The focused Phase1 selection uses the existing runner, core files together and
dispatch files separately (at most four per group):
`test/line-service-phase1.test.mjs`, the `phase1` control in
`test/closeout.test.mjs`, and `dispatch/test/phase1-starts.test.mjs`.
All are discovered by the next full release. Run once through lane check on the
clean committed candidate after self-landing; no full/default/reviewer suite.
One independent async post-code review per landed change remains nonblocking.

Supervisor-herdr owns proof-based go/no-go and plain Git revert of the listed
Phase1 commits if it freezes a line or stops landing. The current
`OVERNIGHT-GUIDELINES-20261026.md` supersedes the narrower overnight plan; quiet
chat is the operator delegate, and the existing watcher remains the only one.
Fix local non-fence blockers in the same run, change approach after two or three
failed attempts, and leave new discoveries for morning. There is no ACK or
22:00/23:00 deadline wait. The pre-source archive is
`archive/phase1-land-first-20261026-pre` at
`f1a4abc30d3b08d2887612f19946c165603db43d`. Use ordinary `git revert` on the exact
newest-first Phase1 commit list, preserving record evidence; the older narrow
launchd revert allowlist is not this rollback entry. The last-good code stays
live if proof fails. Public, mainnet, secrets, other-identity files and unarchived
work stay fenced. The release coordinator retains the final full-release and
adoption obligations.
