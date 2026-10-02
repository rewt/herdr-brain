# Promote

The supervisor or settle enqueues lanes with one command from any checkout of
any project. No project configuration, record initialization, service installation
or model call is needed:

```sh
node /path/to/herdr-monitor/promote/promote.mjs first-lane second-lane
```

The command durably enqueues the topics, acknowledges a detached worker and exits.
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

After **every** attempt, including unknown lanes, refusals and interrupted attempts,
`herdr agent prompt` sends a compact `[promote-queue]` message to `supervisor-herdr`.
The queue records delivery separately from promotion. Delivery retries default to
five attempts, ten seconds apart; exhaustion uses a Herdr notification and retains
the undelivered message/error. It never turns an undelivered success into a new
promotion. Gates have no invented time budget.

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
override, lane configuration is resolved when promotion runs. `--herdr` and
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
A crash in the message acknowledgement window can cause a duplicate notice with
the same request ID; receivers can deduplicate it. For an exhausted delivery,
the saved `message`, `to` and `delivery_error` are the retry evidence; the supervisor
can deliver that exact message without re-enqueuing promotion.

Offline tests in `npm test` use real disposable Git worktrees, the default npm
gate, detached workers and a fake Herdr delivery endpoint. They cover ordered
promotions, dirty/red/conflicting refusals, continuation, concurrent enqueues/direct
promotion, actual crashes during the promoted cleanup checkpoint, legacy recovery,
a direct gate overlapping queued closure, conditional removal checks, duplicate
entries, delivery exhaustion and post-gate mutation. `acceptance/run.mjs` also has
an unconfigured-project queue case using its owned supervisor PTY. That release
harness is separate from offline tests.
