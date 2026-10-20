# Event-driven lane closeout

The canonical project's `.lane.json` can opt into one event queue:

```json
{ "retirement": { "closeout_queue": true } }
```

The default is off. Brain declares the opt-in in its own configuration. Each
other project, including BCH, adopts it in its owning checkout at its release
re-pin. A lane's copy of this file cannot enable retirement for its project.
This change does not install or activate a release in another project.

Activation transfers retirement ownership. Updated housekeeping and promotion
cleanup acquire the same project retirement claim as the closer; under that
claim, opted-in housekeeping skips both its every-tick tidy and integrated-lane
sweep, and promotion delegates cleanup to the queue. Other housekeeping work
continues. Before activation, the supervisor stops any older housekeeping
runtime and inspects any surviving children, then restarts it from the adopted
release. The closer refuses effects while a default housekeeping lock lacks
the new ownership protocol marker, including a stale lock pending inspection.
Explicit custom state-directory schedules must also be stopped/replaced by the
project owner. No lane worker starts, stops or restarts a real schedule.

## Sources and durable targets

The record CLI binds the target while committing the source event, before queue
publication. An interrupted publication can therefore recover the same target
from the record; it cannot bind a newly recreated lane under an old name.

| Source event | Request |
| --- | --- |
| `report.ingested` with `outcome: done` | `ready` |
| `lane.ready`, from optional `lane ready TOPIC [--run R-n]` | The same `ready` key |
| `review.verdict` | `review-done` |
| `promotion.reconciled`, including `record complete-batch` and reconcile finish | `landed`, for each exact recorded run/head |
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

Queue entries are `closeout-entry/v1`, stored at
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
There are no timers, debounce windows, idle polling or workspace sweeps in the
closer. It reads queue entries and their targeted record/native/Git references,
processes them in source sequence/key order, and exits when no new revision is
pending. A deferred target does not block a different eligible target.

Each entry invokes the existing guarded retirement adapter on its named path.
It re-observes identity, HOLD, focus, protected roles/slots, processes, references,
run/chain disposition and Git facts before effects. A stale head, recreated
worktree, reused pane/session, dirty checkout or unknown fact keeps the target.
Ready/reviewer requests can release only their bound panes. Workspace and Git
removal require a separate landed/parked request and the executor's independent
proofs. Parking alone never overrides an open run, reference or protected path.

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

Landed requests run immediately, apart from lifecycle-lock contention. The
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

Supervisor inbox notification from `review.verdict` is a separate follow-up:
the existing notice wire formats and delivery paths remain unchanged here.
Completion is durable in the record, independently of background shell exit.
