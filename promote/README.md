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
The worker snapshots ready pending requests in FIFO order, then exits when empty. It never waits to accumulate a batch or uses a timer/window. Repeated enqueues of a current or
pending topic reuse its request. Independent enqueues serialize their writes;
exactly one worker owns the drain. A project is its canonical Git common directory,
including calls from linked worktrees. Nothing depends on a project name, remote,
workspace label or session registry.

Compatible requests (same validation override and lane configuration) form a
batch. `lane promote-batch` holds the existing Git promotion lock, checks clean
canonical and lane worktrees, and stacks the captured lane commits in an owned
scratch branch using native Git rebases. Each replay must equal Git's mechanical
merge tree; conflicts, merge commits and custom external merge drivers refuse
that lane without touching its worktree. Preparation runs in scratch. The
project's promotion tier runs once on the stack, followed immediately by a
local fast-forward to that exact validated commit. An existing green receipt
for the same tree, command and environment is reused. No pushes or merge commits
are created. Settle performs only code/report review and never runs a suite.

A red batch splits into FIFO halves and retries; green halves land, red singleton
lanes remain available for a correction. Each subsequent green half is validated
on the main that already includes earlier landed work. This keeps unrelated
work moving and checks the actual combined tree before every fast-forward.
Bisection depth is logarithmic; total gate executions are not universally
logarithmic. With three lanes and the last lane broken, there are three executions
(one red batch, one green pair, one red singleton). With the first or second lane
broken, ordinary bisection can take five. A universal two-extra-execution bound
cannot also guarantee arbitrary combined-tree validation from exit-code-only
commands; the train preserves the green gate requirement.

Direct `lane promote` retains its single-lane behavior. Direct promotion, train
integration and all lane closures share the Git-common-directory lock. Gates
recheck trees, branches, captured lane tips, STOP and record readiness before
integration. Promoted lane refs adopt only their proved replay after main moves;
post-integration edits preserve the lane with a warning rather than overwriting it.

For reviewed work, bind the request to one exact commit and, when applicable,
its authorized record run:

```sh
node promote/promote.mjs topic --expected-head FULL_COMMIT_HASH --if-current-run R-123 --org /record
```

`--expected-head` accepts one lane and a full commit hash. The queue persists it
and the train checks it under the shared promotion lock
before replay and again before integration. A changed tip emits a clear
`refused` notice with both hashes and preserves the lane. A bound head may be replayed onto a moving main in scratch only after the full
merge-tree preservation proof. The original authorization stays bound to
`source_head`; `tip` identifies the proved replay. Supervisor handling checks the
train receipt, green log hash and Git tree/ancestry proof before closing the run.
Preparation cannot replace the captured scratch commit. The final fast-forward
names the validated commit directly, so moving a lane branch cannot redirect it.
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
Remaining workspace shells/chats stay for the operator. A red gate, dirty lane
or conflicting replay leaves that lane intact and continues with the other
requests. Replay conflicts live only in the train's scratch worktree and are
aborted there; the original lane never acquires a paused rebase.

After every completed attempt, including unknown lanes, refusals and legacy interrupted attempts,
[the shared supervisor input gate](../supervisor/README.md) journals a compact
`[promote-queue]` message before attempting `herdr agent prompt`. The pane must be
idle/done with an empty composer on two ANSI reads three seconds apart. Typing or
unavailable input queues the message and raises a non-focusing Herdr notification.
`SUPERVISOR_INPUT_WAIT_SECONDS` defaults to 7200; capped messages stay in the inbox
with an acknowledged delivery owner, and drain before newer notices when input
clears, even after the queue caller exits. Housekeeping restarts a dead owner.
The queue records delivery and its inbox/notice ID separately from promotion.
An interrupted train retains its current batch and receipt for `--drain`; its
local error names the receipt and log, and completion notices follow recovery.
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
batch receipts, full train logs and per-request cleanup JSONL. Each promoted
result includes `report_at`, `integrated_at` and `report_to_main_s` (null when no
record run was bound). The worker records the same timing through the record
CLI as a run note, so `record show R-n` exposes report-to-main velocity. This keeps a fresh checkout clean without
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
requests. A current train resumes its saved scratch candidate and tree-keyed evidence.
Interruption before a green fast-forward leaves main untouched. Interruption
after the fast-forward accepts only the exact planned validated tip already on
main, and resumes bookkeeping without repeating the gate or integration.
A batch with some halves already landed retains those green integrations and
resumes its remaining groups. Dirty scratch evidence is retained for inspection.
Legacy single-job receipts still produce an `interrupted` notice and preserve
the lane rather than guessing an external effect; saved freshness never authorizes
replay.
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

Internal response waits adapt to measured machine load; see the
[deadline inventory](../docs/reference/load-deadlines.md) for allowances and preserved safety checks.

Direct and queued promotions [wait for memory pressure to clear](../docs/reference/memory-gate.md)
once before acquiring the promotion lock and starting validation, then finish
the fast-forward without another memory wait. Queued waits are visible in the
job log; they do not produce a refused result.
