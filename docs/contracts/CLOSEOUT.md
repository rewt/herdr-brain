# Event-driven lane closeout

**Option B implementation (ENG-536), 2026-10-22.** Implements the accepted
[ENG-530 authority amendment](../reviews/closer-locks/5f6af1c-r1.md). Adoption
still requires the project owner to replace legacy cleanup and inspect surviving
children under the shared retirement ownership protocol; lane workers never
manage live schedules.

## Activation

Canonical project policy is selected from config-home `lane.json`, otherwise
`.lane.json`. Missing configuration enables train landing and named ready/recovery
requests. `true` enables all automatic sources, `false` opts out of queue effects,
and invalid/unavailable selected policy keeps. Automatic report, review and
dropped-item sources remain opt-in. A lane copy, inherited identity setting or
environment override cannot enable retirement. No historical sweep occurs.

A train landing is actionable only after the completion caller's durable
post-return handoff. Raw `promotion.reconciled` events retain their exact binding
but never start a closer. The caller checkpoints the successful receipt and
terminal references, publishes through the bounded completion outbox, and joins
its finite attempt outside lifecycle/queue claims. A KEEP or failure retains
cleanup-pending without repeating integration or validation.

The checkpoint lives under `<canonical-git-common-dir>/closeout/completions/`.
Receipts and gate logs inside any linked worktree are refused before handoff;
the caller must retain the original evidence outside those worktrees. Existing
handoffs backed by disposable paths also keep. After a named retry completes,
promotion bookkeeping and run-ownership readers reconcile only the exact
source/fingerprint, target key/run/topic/head and durable completion outcome.

Standalone callers explicitly invoke the tail after successful `finish` or
`complete-batch` returns (after child exit for a CLI):

```sh
node supervisor/closeout.mjs handoff --repo PROJECT --org RECORD --receipt PREPARED.record.json
node supervisor/closeout.mjs migrate EXACT-KEY --repo PROJECT --org RECORD --receipt ORIGINAL.record.json
```

A bare completion has no implicit tail. The migration command converts only the
named original v1 envelope after source/current-identity/completion verification;
its backup and journal precede atomic v2 publication. Completed keys stay pruned.
Git-only trains without a recorded run retain guarded foreground cleanup. Manual
Git landings use named recovery; unsupported historical sources are never rebound.

Updated housekeeping and promotion share `retirement/owner.lock` with the closer.
Queue ownership skips legacy tidy/sweep work. A legacy housekeeping owner without
the option B protocol marker (`retirement_queue_protocol: 2`) keeps; opt-out/downgrade never starts legacy cleanup over a
live drain. No release is installed or activated by this change.

## Sources and durable targets

The record CLI binds the target while committing the source event, before queue
publication. An interrupted publication can therefore recover the same target
from the record; it cannot bind a newly recreated lane under an old name.

| Source event | Request |
| --- | --- |
| `report.ingested` with `outcome: done` | `ready` |
| `lane.ready`, from optional `lane ready TOPIC [--run R-n]` | The same `ready` key |
| `review.verdict` | `review-done` |
| `promotion.reconciled`, including `record complete-batch` and reconcile finish | Bind `landed` for each exact run/head; await verified post-return completion handoff |
| `item.closed` with `as: dropped` | `parked`, for its recorded runs |
| `lane.recovery-requested`, explicit named recovery | `landed` or `parked`, still subject to all executor proofs |

`review.verdict` records run, verdict, evidence hash, reviewed head, current
bound head, pane, terminal, native session, native process and shell birth
identities, and `followup_expected`. Settle publishes it after committing its
review evidence and completing its callback; the lane reviewer first preserves
the existing launch/verdict receipt. This avoids binding the queue to the head
before settle's review-only commit. Direct lane reviews record their verdict at
their existing completion point. An adapter without proven native launch
identity cannot invent that identity from a label or verdict; its pane stays.
`lane review ... --run R-n --followup-expected` and `settle R-n
--followup-expected` explicitly retain the reviewer for a same-session follow-up.
The declaration defaults to false, is preserved on settle retry, and is carried
through the native verdict receipt into `review.verdict`. Finish the follow-up
with the named `followup-ended` command below; silence never releases it.

Queue entries are `closeout-entry/v2`, stored at
`<canonical-git-common-dir>/closeout/entries/<key>.json`, next to `promote/`.
The key is SHA-256 of `[absolute lane path, run, signal]`. Publication uses a
fsynced temporary file, exclusive hard-link publication, and directory fsync.
Repeats retain the first binding. An entry references the source event's
sequence/type and binds common directory, canonical project, record, run/item,
worktree path and filesystem identity, registered Git directory identity,
branch/head and exact pane/native-session identities. The record source contains
the same binding. These are requests to evaluate, never stored eligibility.

## Consumer and outcomes

An enqueue starts a detached finite closer unless a live closer owns the project
claim. Concurrent starts use the existing birth-aware retirement lock. Enqueue
and the consumer's empty-exit handoff share a short queue lock: an enqueue either
reaches the existing consumer or starts another after its claim is released.
A contended drain returns `already_running` immediately without evaluating
targets, including detached starts and same-process re-entry. Callers that need
completion observe the running consumer's recorded outcome and claim release.
An explicit key set restricts selection, pruning and stale-code successor
handoff to those keys; an empty set does no work. Omitting it drains the queue.
There are no timers, debounce windows, idle polling or workspace sweeps in the
closer. It reads queue entries and their targeted record/native/Git references,
processes them in source sequence/key order, and exits when no new revision is
pending. A deferred target does not block a different eligible target.

Closeout publication and consumption act only on the project's own record,
resolved from its canonical checkout/fleet binding independently of `ORG_DIR`.
A CLI write that explicitly selects another record does not bind or publish
closeout work, start a closer, record queue diagnostics, or prune project entries.
An empty matching set is a quiet no-op. Within the owning record, consumption
ignores entries for other records, while a committed source binding still makes
a changed record/project field a recorded refusal. Foreign entries are retained;
their presence never supplies pruning or retirement authority.

Each entry invokes the existing guarded retirement adapter on its named path.
It re-observes identity, HOLD, focus, protected roles/slots, processes, references,
run/chain disposition and Git facts before effects. A stale head, recreated
worktree, reused pane/session, dirty checkout or unknown fact keeps the target.
Ready/reviewer requests can release only their bound panes. Workspace and Git
removal require a separate landed/parked request and the executor's independent
proofs. Parking alone never overrides an open run, reference or protected path.
A clean lane's open item, parent, review or correction chain is no longer a
hold when its tip is contained in main, its non-merge patches all have complete,
stable `git cherry` matches, or `archive/lane/<topic>` resolves to that exact tip.
Patch matches describe historical integration, including matches followed by a
revert; they never claim current behavior or ancestry. Patch-based release is
enabled by default; canonical `retirement.archival_retirement: false` retains
the historical explicit opt-out. Patch release creates and verifies the exact
archive before removal. Existing archive tags authorize recoverable release
independently of that patch-scan setting; mismatched tags never do.

Here a **superseded attempt** means a run with an explicit record abandonment
and an exact-tip archive for its lane. Completion's explicit `superseded` run
list produces that abandonment. A newer run, a title, pane label or report word
alone never proves supersession or authorizes archiving an open unlanded lane.
An archive also preserves explicitly rejected/parked work; its content can
release without closing the item's long-lived parent. Untagged, unlanded work
retains the existing chain checks. Local open runs, unknown run bindings, warm
review follow-ups, native identities, agent exit then shell close, live panes,
processes/references, HOLD, protected paths, evidence and scratch guards remain.
A worker's signal also binds older ended sessions in that same lane. Distinct
predecessors are evaluated before their retained successors; reused panes bind
only their latest recorded native occupant. This allows an exact supersession
release to complete while its successor is still observable.

`closeout.effect` records each successful release/observed agent exit, shell
close, archive, preservation preflight, worktree removal, branch removal, lane
removal and workspace close. Native close/exit intents are also recorded before
input. Existing exit receipts reconcile an unchanged shell after a partial
close. A record-bound preservation manifest and current Git/native absence
reconcile a partial worktree/branch/workspace removal; the archive, copied
evidence and remaining branch identity are revalidated. A retry cannot adopt a
replacement occupant, head or worktree. Evidence remains outside the removed
lane; wallet secrets, protected paths and live state retain the existing refusal.

`closeout.evaluated` is an observation receipt in the record, including its
revision, completion or KEEP reason, named resolving event, and explicit retry
command. It is not status in the state fold. Completed effects remain
idempotent. Older folds ignore these new event types and older releases do not
read the queue.
Once a matching completion receipt is durable, the next queue transaction
prunes its request file and fsyncs the directory. The append-only source binding,
evaluation and effects retain all exact-run evidence; replaying the source cannot
recreate a completed request. Only deferred requests remain in the active queue.
Promotion completion retries only its own exact run/topic/head entries whose
latest evaluation awaits `lifecycle-lock-released`, and only if no resolving
revision is already pending. An empty promotion drain never retries history.
The promotion completion checkpoint carries a bounded notification outbox until
that targeted enqueue succeeds, so a restart can recover an interrupted handoff.

Landed requests await their exact completed handoff. The
lanes view exposes `finishedLanesOpenOver30Minutes` and a worktree's
`finishedAt`, `finishedAgeMs` and `finishedOpenOver30Minutes`; the project summary
publishes `lanes.finished_open_over_30_minutes`. This measures reconciliation to
still-open worktree, including lanes kept by HOLD or references. A KEEP is
recorded, never overridden to satisfy the thirty-minute objective.

## Resolving a deferral or recovering after interruption

Related record events wake pending entries; release, handoff, follow-up end,
settle completion and promotion completion carry the relevant revision. HOLD
removal, focus changes and external reference-file removal currently have no
recorded producer. Their receipts explicitly require a supported retry after
the condition is resolved; there is no filesystem watcher or silent sweep.

```sh
node supervisor/closeout.mjs status --repo PROJECT --org RECORD
node supervisor/closeout.mjs retry TOPIC --why 'hold-removed' --repo PROJECT --org RECORD
node supervisor/closeout.mjs drain --repo PROJECT --org RECORD
node supervisor/closeout.mjs event --seq N --repo PROJECT --org RECORD
node supervisor/closeout.mjs followup-ended REVIEW-ID --why 'follow-up finished' --repo PROJECT --org RECORD
node supervisor/retire.mjs sweep --lane ABSOLUTE-LANE-PATH --repo PROJECT --org RECORD
```

`drain` recovers queue entries only. `event` republishes a committed source's
original target binding after an interrupted publication; a legacy source with
no binding stays unbound. `sweep --lane` is the explicit named recovery path
for legacy lanes. With the policy enabled it records a newly bound recovery
request (or retries an existing removal request); with the policy off it uses
the same guarded executor directly. It never discovers targets by workspace
scan. A stale bound head needs new exact-run evidence, not a target rewrite.
Named recovery recognizes ancestry, complete stable patch matches and an
existing exact-tip archive while the item remains open. Its source and target
retain the observed proof kind, lane head and integration branch/tip. The
consumer observes the content again; a saved patch match or archive observation
cannot authorize removal after the underlying proof disappears. Patch-based
removal binds the fresh main tip and repeats the history/policy checks in the
guarded adapter, then creates and verifies the exact archive before removal.

Supervisor inbox notification from `review.verdict` is a separate follow-up:
the existing notice wire formats and delivery paths remain unchanged here.
Completion is durable in the record, independently of background shell exit.

## ENG-530 amendment: completion before closeout, narrow removal lock

### Implementation input map

The pure planner still selects the original `laneRemovalToken`. The adapter
compares that selected token with `validateLaneRemoval`, which calls the same
token function without running the planner or choosing a different candidate.
The final snapshot is a new native observation. The external preflight seals
local sources and preservation claims before that observation; under the immediate removal lock it
checks their current filesystem identities and metadata again. A changed source
requires a new preparation, even if a newly convenient plan could remove it.

| Token / additional removal input | Fresh boundary check |
| --- | --- |
| Common directory, decision/removal proof, exact lane Git head/branch/content | Canonical common directory, registration, filesystem identities, branch tip/reflog generation, clean index/untracked state, metadata locks, current main branch/tip and ancestry are re-read under the lock. Patch history is prepared externally and bound to unchanged refs, policy, replace/graft/shallow inputs. |
| Workspaces, tabs, panes, agents, process trees and vacancy | A full new executor observation follows evidence hashing and permission preflight; the immediately preceding native/process proof participates in the recomputed token. There is no promotion-lock wait. Native changes before that observation invalidate selection. Herdr remains non-atomic with Git. |
| Relevant runs, items, links, references and standard slots | Final observation reads the record, callbacks, jobs, watcher/resource ownership and CWD references. Under-lock folding rechecks the relevant record and seals recheck reference/callback/queue/slot files; source/handoff and canonical policy are independently verified again. Unknown facts keep. |
| HOLD, policy and errors | HOLD and canonical policy are read again under the lock; selected config-home policy/digests and native errors remain in the proof. The option A policy guards remain intact. |
| Preservation manifest, evidence, scratch intent and archive destination | Full copy/hash verification and Git permission probes run externally. Current identity/ctime/mtime/size and directory inventories detect changed source/copy inputs without rehashing evidence payloads inside the lock; the manifest and scratch intent are sealed too. Tag presence/target and branch generation are rechecked before creating a tag or removing Git state. |

The existing occupants/exits readers ignore symlink directory entries. Their
immediate ignored entries remain inert inventory: seals retain their lstat
identity and link text without following the link. Changing that inventory
invalidates the preflight. A root input, receipt directory, Git input or other
authority path redirected by a symlink still keeps the lane.
| Source, completion and code epoch | Original committed target/source, receipt/checkpoint digests and completion fingerprint are revalidated. Loaded physical code identity and main epoch must still match before selecting work, native effects and guarded Git removal. |

The preflight and exact branch generation remain in durable effect evidence for
partial-removal recovery. Scratch disposal and empty-workspace observation/close
run after the Git lock is released. Code-change exit releases its claims in the
same short queue transaction that captures pending keys, so a racing producer
either enters that handoff or observes a released consumer. Its successor is
resolved once; another change or failed restart leaves explicit drain pending.

### Authority, scope and stable surfaces

The closer remains a finite, model-free consumer of exact bound requests. A
landing, report, closed item or elapsed time supplies no new deletion authority.
Keep the existing common-directory ownership, terminal-chain, native identity,
HOLD, focus, protected-slot/path, clean-Git, reference, preservation and archive
guards. Session display metadata still grants no authority. No new scheduler,
watcher, polling service or parallel retirement executor is introduced.

`supervisor/reconcile.mjs` and `contrib/settle-watch.mjs` retain their bytes,
paths, flags, output and completion semantics. In particular, reconcile retains
its immediate `lane-promote.lock` acquisition and exact-evidence replay checks.
The implementation seams are the existing completion callers/outbox, record CLI
publication, closeout consumer and shared retirement adapter. This design needs
no change to either stable file. Another identity's callers/configuration remain
that identity's work at adoption; this amendment does not edit or re-pin BCH.

R-731 is the motivating witness: a detached drain held `consumer.lock`,
`retirement/owner.lock` and `lane-promote.lock` throughout native observation.
Removing the report-ingestion trigger alone left landing closeout racing
reconcile replay and fixture teardown (424/444 passing). ENG-530 changes the
lock boundary and completion handoff, not the meaning of successful integration.

### Completion handoff and replay

The implementation round replaces option A's immediate landing-start rule with
the following post-reconciliation handoff.

`promotion.reconciled` commits the original run/topic/head binding. It is a
durable landing fact, **not a start signal**: neither `record complete-batch`
nor another event publisher may make that landing actionable or start its
closer while the enclosing completion operation is still running. An already
running drain must also skip such an unhanded landing. Publication and `event`
recovery cannot bypass this rule.

The native train uses its existing completion checkpoint and bounded
`closeout_pending[]` outbox for the following handoff:

1. Integrate once and reconcile using the existing successful gate and exact
   prepared evidence. A failure retains the integrated tip and successful gate
   with reconciliation pending; it creates no actionable landing closeout.
2. After reconciliation has returned successfully **and released its promotion
   lock**, durably mark that exact completion in the caller's checkpoint/outbox.
   Bind canonical common directory/project/record, batch/job, reconciled source
   sequence and fingerprint, run/topic/head and completion receipt digest. The
   caller's live integration/reconciliation/callback references must be terminal
   before handoff. Cleanup and notice delivery may remain pending.
3. Outside promotion and queue transactions, publish the bound request with a
   verifiable reference to that completion checkpoint. Acknowledge the outbox
   only after the exact request/handoff is durable. A source event, absence of a
   lock, PID disappearance or delay alone cannot substitute for the checkpoint.
   A handoff is a resolving revision only for its exact keys; unrelated or
   historical requests do not become runnable as a side effect.
4. Start or notify the finite closer. The completion caller awaits the bounded
   attempt for its own keys, outside locks/resource claims needed by the closer,
   before declaring cleanup complete or exiting as its last cleanup owner. A
   KEEP, deadline or startup failure becomes durable cleanup-pending with its
   resolving event/retry; integration remains successful. Completion does not
   wait indefinitely for human holds, nor claim that a launched detached child
   has finished cleanup.
   A deadline stops new effects and joins the finite attempt; it must not abandon
   a child still able to write into a fixture being torn down. An unresponsive
   surviving child retains its ownership/hold and requires inspection.

For callers of the unchanged standalone reconcile adapter, the caller performs
the same tail **after successful `finish` returns**, following any required
refresh (after process exit for a CLI child). A refresh/delta-acceptance receipt
alone is not reconciliation completion. A direct `complete-batch` caller likewise
performs its tail after its CLI child exits successfully; the record writer
never infers that it owns the enclosing completion boundary. The tail explicitly
binds the completion it owns; do not guess from argv, ancestor PIDs or a worker
label. A bare/manual invocation with no post-return tail retains its source
binding as awaiting completion handoff. An explicit named recovery verifies
the original completion evidence and current
Git/record state, then records that handoff. It never silently launches from
inside the stable adapter's record-CLI child. Thus ordinary train landings are
automatic in every project, while unsupported manual completion stays safe.

Identical reconcile replay produces no new binding, handoff or cleanup effect;
only an unacknowledged exact outbox entry or a named deferral can be retried.
Changed evidence, a reopened item, a newer run or a different branch generation
cannot acquire fresh retirement authority from the old completion. If a caller
dies after the record commit but before handoff, resume bookkeeping, verify the
same receipt/fingerprint and terminal references, and publish the missing tail.
An uncertain or failed completion never becomes successful merely because its
lock disappeared. A refusal before record commit requires the existing
reconciliation repair/refresh; closeout does not accept a delta or rerun a gate.

Native bookkeeping covered by a separate manual reconciliation retains both
receipts. Its outbox binds the exact covering source, and verifies the original
whole-batch coverage and receipt digest before resolving the manual caller's
committed post-return tail. It cannot publish that caller's missing tail. Once
native bookkeeping releases its references, the manual owner performs the tail;
the native outbox can then join those exact keys without another handoff or gate.
Delayed native lane-head replacement finishes with its original Git CAS before
record completion captures the lane generation.

A replay during native observation/planning must be able to take the promotion
lock. There remains a real contention boundary: an arbitrary direct invocation
of the unchanged, zero-wait reconcile can arrive during actual Git removal and
receive its existing `locked:` refusal. The caller retains the same prepared
receipt and retries bookkeeping after that exact removal owner releases the
lock, within its ordinary operation deadline; a second refusal stays pending.
It never repeats validation or integration. Promise neither that a short lock
is contention-free nor that standalone reconcile has gained a wait/retry flag.
A requirement that even arbitrary overlapping raw replays never refuse would
need an explicit operator decision about the stable reconcile behavior; it is
not assumed by this design.

### Observe, prepare, then guard removal

The adapter must split its current `removeLane`/`resumeLaneRemoval` path; merely
moving the consumer's acquisition around today's whole `removeLane` still holds
the lock through native scans, evidence copying and workspace close.

| Phase | Permitted work and failure/recovery |
| --- | --- |
| Claim and select | Claim the finite consumer and shared retirement owner; validate owning record, policy, source and completed handoff. Missing/foreign/unknown input stays KEEP, with no guessed target. A contended live owner leaves the durable request for its existing handoff or explicit drain. |
| Observe and release | With **no promotion lock**, observe native/Git/record facts, plan, and perform separately guarded pane/session release and shell close under existing tab claims. Each effect has its existing pre-input intent and exact identity receipt. Re-observe/replan after each effect; never replay a pre-release plan. A changed occupant, hold, live reference or unknown observation keeps the remainder. An interrupted native effect resumes only through its bound intent/exit/absence evidence. |
| Prepare removal | With **no promotion lock**, collect and hash preservation evidence outside swept paths, prepare the scratch manifest without disposing it, and select one Git-removal candidate using the existing pure planner. Bind source/handoff, filesystem and registered Git identities, branch/reflog generation, exact tip, integration base/tip (or authorized archive disposition), native vacancy proof, relevant record/reference/policy inputs, code epoch and removal plan token. Copy/hash or preflight failure keeps the lane; a proven duplicate copy can be discarded only while its verified original survives. |
| Final observation | With **no promotion lock**, repeat the executor's final native vacancy/identity and live-process/reference checks after expensive copying/hashing. Compare the selected candidate's native inputs. No native input is made current by reading back a saved token. A detected change discards the candidate and keeps; a later resolving revision can plan afresh. |
| Guarded Git removal | Immediately try `lane-promote.lock`, with **no acquisition wait**. On contention discard the observation/plan, record `lifecycle-lock-released`, and keep; a retry starts at observation. Under the lock revalidate the inputs below and compare the recomputed candidate token before any Git mutation. Perform only the guarded archive-tag/worktree/branch operations and their necessary local checks and durable effect receipts. Release in `finally` on success, refusal or failure. |
| Finish | After releasing the promotion lock, execute only the already authorized scratch disposal and separately guarded empty-native-workspace close. Native observation/close, slow evidence work and reporting never extend the promotion lock. Record completion only after all required effects are witnessed; otherwise retain preservation evidence and cleanup-pending. Prune a request only after durable exact completion, under the short queue transaction. |

Under the promotion lock, check the exact project/record and canonical common
directory, source and handoff receipts, worktree and Git-directory filesystem
identities/registration, branch name/reflog generation and unchanged tip. Recheck
cleanliness including untracked files, index safety flags and Git metadata locks;
prove that the exact landed head is still integrated into current main (or that
the separately authorized parked/archive proof still holds). Recheck HOLD,
protected paths/slots, policy, relevant run/chain disposition, pending jobs,
callbacks and resource/CWD references. Revalidate the preservation manifest's
identity/digest and archive destination/collision proof, using the completed
external preflight rather than copying or rehashing the whole evidence tree
inside this lock. Changed preservation inputs require a new external preflight
and final observation. Recompute and compare the selected removal token using
those fresh local inputs and the immediately preceding native proof; a different
token, missing input or changed main/code
epoch refuses and keeps. Do not invoke the planner under the promotion lock or
replace a mismatching plan with a more convenient one there.

Native observation is not atomic with Git, and the promotion lock does not lock
Herdr or human actions today. Preserve the existing final native check directly
before the effect boundary: no lock wait, asynchronous yield, copying or other
slow work may intervene between it and the immediate acquisition/revalidation.
The implementation must identify every existing removal-token input and show
how it is freshly checked in this split. It may not drop native/protected-role
inputs, invent a native generation API, or claim that hashing an old snapshot
detects a new occupant. If an input cannot be validated with this boundary,
refuse that removal and return the unresolved guard to authority review; default
on must not be enabled on the strength of a stale-token workaround.

Create a needed archive tag only under the promotion lock, without overwriting
a differing tag; verify it resolves durably to the bound tip before removal.
Use non-forced worktree removal and exact branch-generation checks, retaining
the existing recoverable archive rule for unintegrated work. A tag-only success
does not complete retirement. If worktree removal succeeds but branch removal
or receipt append fails, keep the external preservation proof and pre-effect
intent; retry only after proving the original worktree's absence, current
integration/archive, unchanged remaining branch and current safety guards under
a fresh removal lock. Never adopt a replacement path, branch, pane or workspace.
Scratch/workspace failure retries that phase without repeating successful Git
effects. No failed archive/preservation step permits removal, and no failure
reclassifies an integrated landing as unlanded.

### Locks, order and crash recovery

All paths below are relative to the canonical Git common directory, except the
owning record lock. No new long-lived completion or reconciliation lock is
required; durable completion evidence is a prerequisite, not another lock.

Actual worktree/ref removal can outlast a quick local check; acquisition wait
and lock-holding duration are different. Bound each effect by the existing
retirement/Git deadline and reserve enough time for the removal steps before
starting, rather than describing this as a millisecond lease.

| Lock | Scope and recovery |
| --- | --- |
| `closeout/queue.lock` | Short publication, handoff acknowledgement, selection/pruning and empty-exit transactions only; no native calls, child waits or Git effects. The startup claim under it tries `consumer.lock` without waiting. Use the existing birth-aware dead-owner recovery, including its serialized `.recovery` claim; live/unknown owners keep. |
| `closeout/consumer.lock` | One finite drain, including observation; released atomically with the empty-queue handoff under `queue.lock`. Another enqueue either reaches that owner or starts a successor. Crash recovery proves process birth/death and does not duplicate an uncertain native effect. |
| `retirement/owner.lock` | The existing shared claim for the finite retirement pass and policy transfer. Updated housekeeping/legacy cleanup use it too. It may span observation; it cannot make a promotion/reconcile caller wait for a native scan. Live/unknown ownership keeps; proven-dead recovery retains the existing serialized recovery protocol. |
| `retirement/tabs/<tab-hash>` | Existing per-tab native intent/release/exit/close serialization; release before entering Git removal. Multiple tab claims use immediate refusals or a consistent order, never opposing waits. Resume only the same bound occupant/intent. |
| `lane-promote.lock` | For the closer, only guarded Git removal and local revalidation/effect receipts; never native observation/planning, agent exit waits, workspace close, evidence copying or scratch disposal. Closer acquisition is immediate. Promotion/reconcile keep their existing scopes and acquisition behavior. On crash, inspect owner and surviving Git/gate children; never automatically unlink this lock because a parent died. |
| `<record>/lock` | Existing short record transactions for immutable source, handoff, intent/effect and evaluation evidence. Release before publication, starting/joining a worker or waiting for any lifecycle lock. Unknown/torn record state keeps; use existing store recovery, never hand-edit `events.jsonl`. |
| `promote/queue.lock`, `promote/worker.lock`, `promote/cleanup.lock` and Git's own ref/index/worktree locks | Keep their existing owners. Queue transactions only publish/checkpoint; callers never wait for the closer while holding a queue transaction or promotion/cleanup claim that the closer needs. A train worker may retain its bookkeeping claim while joining only if its resource references are already terminal and the closer needs no such claim. Foreign Git locks are refusal inputs, not locks to delete. Standard-slot/controller or housekeeping locks are likewise read as KEEP/ownership evidence, never reclaimed by the closer. |

The blocking order is consumer claim, then retirement owner, then **either** tab
claim(s) for native effects **or** promotion lock for Git effects, then a short
record append if needed; tab claims and promotion lock never overlap. A running
consumer can take short queue transactions while retaining its claim/owner,
but no queue holder waits for those claims: startup tries the consumer claim,
and record writers release the record lock before entering the queue. If a
queue transaction needs a diagnostic append, queue precedes record; no record
transaction waits on queue. Promotion/reconcile may hold promotion then record,
but must not acquire/wait for retirement-owner, consumer or tab claims from
there. The completion tail and closer join occur after releasing such claims.
Recovery claims nest only inside recovery of their own birth-aware lock, with
the existing dead-owner recheck. A lock timeout is a deferral, not deletion
authority, a new timer or a reason to repeat a successful gate.

### Default-on policy and older readers

Enable the new default only in the implementation release that supplies both
the completion handoff and narrowed guarded removal with their witnesses.
Current option A requires explicit `true` for every queue source, including
train landing and named requests. The implementation round changes absent
configuration to the default-on policy below; automatic report, review and
dropped-item sources remain opt-in.
Read project-only policy from config-home `lane.json` when selected, otherwise
canonical `.lane.json`; a lane copy, inherited identity setting or environment
override cannot enable or weaken retirement. Missing configuration is distinct
from unreadable/malformed selected configuration: the latter always keeps.

| Canonical `retirement.closeout_queue` | Implemented option B policy |
| --- | --- |
| Absent, including no project config or empty config | Train `landed` closeout and explicit named ready/recovery are enabled in every project. Automatic report, review and dropped-item sources remain off, as in current option A. No retrospective discovery/sweep. |
| `true` | Retains explicit opt-in to the full set of automatic sources and their existing signal-specific guards; landed work still requires the completion handoff. It is redundant for train landing alone; removing it does not disable landing. |
| `false` | Explicit queue opt-out: no new bindings, publication, worker start or queue effects. Retain pending requests/evidence. Explicit direct guarded recovery remains available under the current contract. Re-enabling requires a fresh guard evaluation, never a cached permission. |
| Invalid/unavailable selected policy | KEEP with a policy diagnostic; never treat an error as an absent/default-on config. |

Activation still transfers retirement ownership under the shared claim. Before
using the new default, the project owner stops/replaces legacy housekeeping
(including custom schedules) and any old drain, and inspects surviving children;
unknown old ownership keeps. Updated housekeeping skips its legacy lane/tidy
executor for enabled queue sources and promotion delegates to the closer. There
must never be two executors. Opt-out or downgrade also requires an orderly
owner-controlled transfer, rather than starting legacy cleanup over a live
drain. Lane workers do not manage real schedules or another identity's files.

The new handoff is safety-critical: do **not** add an ignorable field to a
`closeout-entry/v1` request and expect old consumers to enforce it. Use a
`closeout-entry/v2` execution envelope in the same entries directory, preserving
the original immutable target/source/key and binding the verified completion
handoff for landed work. Existing v1 queue readers reject the unknown schema
and keep; pre-queue releases ignore the directory. Neither behavior is default-on
support. Old policy readers still see absent as off and `true` as opt-in; an
upgrade/re-pin is required to obtain the new default. Old folds ignore additive
handoff/effect events and derive their existing status normally.

Pending v1 requests are held by the new consumer until a named migration/recovery
verifies their original source binding, exact current identities and required
completion tail. Under the shared owner and short queue transaction, retain a
durable copy/digest of the old envelope and append migration evidence before
atomically publishing v2 with the **same target**, never rebinding from a topic.
An interrupted conversion resumes only that recorded conversion; conflicts keep
both evidence and target. The migration is a resolving revision only for the
converted keys. Completed v1 receipts stay completed and pruned; no
historical source is re-enqueued merely because the default changed. The
implementation updates the format registry/inventory and compatibility probes
alongside the v2 writer/reader; this design-only amendment changes neither.

### Code freshness

At launch bind the closer's physical code root and immutable release/manifest
identity (or clean checkout commit), plus the project's current main-tip epoch;
verify that identity across module loading, before selecting each entry and
again at the guarded removal boundary. A moved main or changed/unprovable code
identity invalidates the plan: retain the request, release claims and exit before
evaluating the newer landing or performing another effect. Hand the exact keys
to one fresh finite process through the existing outbox/empty-exit protocol,
resolving code again under the project's adopted release rules; a mutable Brain
checkout must load the newly landed bytes, while an immutable installed release
keeps its explicit project pin. Do not hot-reload modules, override a run's bound
release or follow `current` mid-effect. Record old/new epoch and code identity
so a drain begun just before a fast-forward cannot silently process that
landing using its pre-landing imports. Failed restart leaves cleanup pending
for explicit drain, without a restart loop or a new service.

The CLI captures its launch binding before dynamically importing the queue and
retirement graph. The library consumer bootstrap likewise captures code before
its dynamic executor import. The executor rechecks the original launch binding;
it never recaptures a newer commit or main epoch after loading old modules.

### Required implementation witnesses (not tests run by this design)

Use disposable offline projects, explicit scratch fleet/native/process sources,
deterministic barriers and joined finite children; never touch a live project
schedule or native workspace. Preserve the existing oracle and lifecycle guards.
The implementation round selects focused tests within its own ask; this list is
an evidence contract, not authorization to run a tier in the design lane.

- Pause native observation, agent exit and evidence preparation separately:
  show consumer/retirement claims, absence of `lane-promote.lock`, and successful
  real reconcile/replay while paused. Pause guarded Git removal: show promotion
  exclusion, immediate closer deferral if reconcile already owns the lock, and
  the documented direct-replay refusal/recovery if removal wins.
- Mutate tip/branch generation, worktree registration/filesystem identity,
  cleanliness/index flags, integration, source/handoff, relevant record/job/
  callback/reference, HOLD/protected slots, preservation/archive destination and
  token inputs between preparation and guard. Each negative control keeps, with
  no unauthorized tag/removal. Include native occupant/vacancy changes before
  the final check and lock-contention invalidation; show the token-input mapping.
  An unchanged positive control removes exactly the bound integrated lane.
- Reproduce R-731's exact reconcile replay case, including inherited wrong
  `ORG_DIR`, repeated finish and finish after reopen: same-evidence replay stays
  idempotent, changed evidence refuses, and reopening supplies no new cleanup
  authority. Show no closer starts/evaluates before the successful tail, even
  when another consumer is already active.
- Reproduce the asked-and-answered question followed by a **plain note**:
  original finish refuses its delta, explicit refresh preserves the accepted
  evidence, finish then hands off once. The decision-note control still refuses
  refresh. Join the targeted closer before fixture teardown; no late writer
  recreates Git metadata or produces `ENOTEMPTY` during teardown.
- Exercise real autopilot/settle/train landing paths: awaited and unawaited
  supervisor wake, deferred test evidence, record-ingest proof variants and the
  non-blocking proposal case. Show one successful gate/integration, post-reconcile
  closeout, durable cleanup outcome and no detached writer beyond fixture exit.
  KEEP cases retain their exact reason and recovery without another gate.
- Interrupt before/after reconciliation commit, completion-tail checkpoint,
  outbox publication/ack, archive, preservation intent, worktree removal, branch
  removal, native workspace close and completion/prune. Restart/replay proves
  exact identity and no duplicate effects, lost handoff or stranded request;
  unknown owners and surviving children stay held. Show producer/empty-exit races
  and the declared lock order, including migration versus a legacy executor.
- With absent/empty/true/false/invalid project policy, prove the policy table in
  another disposable project as well as Brain, and canonical/config-home
  precedence over lane/inherited/foreign-record inputs. Show v1 pending recovery,
  v2 rejection/KEEP by old readers, old-fold behavior, re-enable/downgrade holds
  and no blanket historical sweep.
- Start a drain before a fast-forward, release its barrier after the newer
  landing, and show it exits without evaluating/effecting that landing. Its
  successor records the newly resolved code identity and epoch, processes the
  original binding once, and retains explicit installed-release pins. Finally
  verify both BCH stable files byte-for-byte and exercise their unchanged flags,
  outputs, exact-evidence refusal and replay behavior.
