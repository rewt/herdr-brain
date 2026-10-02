# Promote

The supervisor or settle enqueues lanes with one command from any checkout of
any project. No project configuration, record initialization, service installation
or model call is needed:

```sh
node /path/to/herdr-monitor/promote/promote.mjs first-lane second-lane
```

The command durably enqueues the topics, acknowledges a detached worker and exits.
Promoted commits accumulate on the integration branch. At a quiet point the
canonical supervisor uses the [release module](../release/README.md) to tag and
gate a batch once, then request the operator's ship or activation decision.
The worker drains FIFO, then exits when empty. Repeated enqueues of a current or
pending topic reuse its request. Independent enqueues serialize their writes;
exactly one worker owns the drain. A project is its canonical Git common directory,
including calls from linked worktrees. Nothing depends on a project name, remote,
workspace label or session registry.

Each attempt runs the existing `lane promote`: clean canonical and lane worktrees,
clean replay onto the configured base, preparation, green validation and local
fast-forward. Its default gate is `npm test`; `.lane.json` keeps the lane CLI's
existing configuration rules. Direct promotions, queued promotions and all lane
closures share a Git-common-directory lock. Direct contention refuses with the
lock path rather than racing a gate. Validation rechecks clean trees, branches, lane tip and base
before the fast-forward. There are no pushes or merge commits.

For reviewed work, bind the request to one exact commit and, when applicable,
its authorized record run:

```sh
node promote/promote.mjs topic --expected-head FULL_COMMIT_HASH --if-current-run R-123 --org /record
```

`--expected-head` accepts one lane and a full commit hash. The queue persists it
and passes it to `lane promote`, which checks it under the shared promotion lock
before preparation and again before integration. A changed tip emits a clear
`refused` notice with both hashes and preserves the lane. A bound head that needs
rebasing is also refused: rebase, settle and authorize the resulting head again.
Preparation cannot replace the expected commit. The final fast-forward names the
validated commit directly, so moving the branch cannot redirect integration.
Without this option the existing multi-lane automatic-rebase workflow remains.
Pending requests with different head/run bindings cannot deduplicate each other.

`--if-current-run` requires `--expected-head` and a record. Before promotion and
again after validation, the lane checks that this run has a recorded done report,
belongs to this Git lane, is not superseded and has no changed outcome, closure,
unresolved/declined blocker or overlapping work. The final check holds the record
lock across the fast-forward, inside the promotion lock. It never writes events
or trusts session metadata. Canonical supervisor STOP also refuses integration.

On success the worker runs one cleanup pass limited to the promoted lane, with
resume disabled. It discovers the record and uses housekeeping's existing live
occupant, record, Git and topology checks to close eligible finished worker tabs.
It never starts the project-wide housekeeping loop. Missing records, unavailable
Herdr, blocked/open workers and operator chats preserve tabs. Cleanup failures
appear in the outcome. Then `lane close TOPIC --git-only --expected-tip COMMIT`
takes the same promotion lock and rechecks the saved promoted tip, base ancestry
and clean worktree before removing the worktree and merged branch. Contention with a direct gate preserves
the lane and is included in the supervisor outcome as a closure warning. It does
not repeat promotion. Git-only closure preserves the Herdr workspace and its
protected tabs.
Remaining workspace shells/chats stay for the operator; promotion does not close
unrecognized tabs merely because a lane was merged. A red gate, dirty tree or
conflicting rebase leaves the lane intact and continues with the next request.
The merge-tree preflight checks final trees; an intermediate replay can still
conflict. In that case the notice names the conflicting files and the lane keeps
its paused rebase for the implementer to resolve or abort before retrying. Its
branch is retained and neither validation nor fast-forward runs for that request.

After **every** attempt, including unknown lanes, refusals and interrupted attempts,
[the shared supervisor input gate](../supervisor/README.md) journals a compact
`[promote-queue]` message before attempting `herdr agent prompt`. The pane must be
idle/done with an empty composer on two ANSI reads three seconds apart. Typing or
unavailable input queues the message and raises a non-focusing Herdr notification.
`SUPERVISOR_INPUT_WAIT_SECONDS` defaults to 7200; capped messages stay in the inbox
with an acknowledged delivery owner, and drain before newer notices when input
clears, even after the queue caller exits. Housekeeping restarts a dead owner.
The queue records delivery and its inbox/notice ID separately from promotion.
Refusals and lost acknowledgements retry through the input gate; every prompt
includes the same visible `notice-id`, making at-least-once duplicates recognisable. It never turns an undelivered success into a
new promotion. Gates have no invented time budget.

Optional overrides:

```sh
node promote/promote.mjs topic --repo /project --to supervisor-project --org /record
node promote/promote.mjs --repo /project --status
```

Tracked `/project/.promote.json` may contain `to`, `delivery_attempts`,
`retry_seconds` and `validate`. Command flags `--to`, `--delivery-attempts`,
`--retry-seconds`, `--validate` override them. `LANE_VALIDATE` takes precedence over
the promotion config's validation override. `LANE_CONFIG` retains the lane CLI's
explicit config selection. Request overrides are saved per entry, so a subsequent
enqueuer does not inherit the first enqueuer's gate or supervisor. With no gate
override, lane configuration's promotion tier is resolved when promotion runs. `--herdr` and
`--lane-cli` are CLI adapter hooks for isolated tests.

## Evidence and recovery

`GIT_COMMON_DIR/promote/queue.json` contains pending/current requests, results,
notice text, delivery receipts and errors. The directory also contains `worker.log`,
per-request gate logs and cleanup JSONL. This keeps a fresh checkout clean without
ignore setup. The record's event log is never written by this module. Queue state
is mechanical bookkeeping, not stored item/run status. Logs/results are retained
without a retention policy.

`queue.lock` serializes atomic queue replacements; `worker.lock` owns the drain;
`GIT_COMMON_DIR/lane-promote.lock` excludes overlapping gates, fast-forwards and
lane removals. Locks contain an owner PID and command. Crash locks deliberately
fail closed: inspect the saved owner, logs and any surviving validation child before removing only the
stale lock. Never remove a live lock. A worker exit between enqueue and empty
shutdown cannot strand the request: both transitions hold `queue.lock`.

After inspection/removing stale locks, `--drain --repo /project` resumes pending
requests. A current interrupted promotion receives an `interrupted` notice and
leaves its lane alone; the worker does not guess whether its gate/fast-forward or
cleanup already happened. Freshness is local to the dequeue operation; no saved
flag authorizes replay, including an older worker's leaked `fresh` flag. Inspect
Git/logs before explicitly enqueuing it again.
A recorded completed outcome awaiting delivery is delivered without redoing Git.
A confirmed refused job may be explicitly enqueued again; the prior result stays
in the queue history. A completed refusal awaiting delivery does not prevent a
new pending attempt. Supervisor requests use its guarded `promote RUN --retry`
command to preserve the run's acknowledgement history and recheck readiness.
A crash in the message acknowledgement window can cause a duplicate notice with
the same request ID; receivers can deduplicate it. For an exhausted delivery,
the saved `message`, `to`, `delivery_id` and `delivery_error` are the evidence;
the inbox owner retries delivery without re-enqueuing promotion. The saved queue
result describes its original wait window; current delivery is in the inbox journal.

Offline tests in `npm test` use real disposable Git worktrees, the default npm
gate, detached workers and a fake Herdr delivery endpoint. They cover ordered
promotions, dirty/red/conflicting refusals, continuation, concurrent enqueues/direct
promotion, actual crashes during the promoted cleanup checkpoint, legacy recovery,
a direct gate overlapping queued closure, conditional removal checks, duplicate
entries, delivery exhaustion and post-gate mutation. `acceptance/run.mjs` also has
an unconfigured-project queue case using its owned supervisor PTY. That release
harness is separate from offline tests.
