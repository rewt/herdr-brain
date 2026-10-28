# Source conflict retry and closer append boundaries

ENG-853 adds a maximum of 32 fresh preparations to `withRecordGuard`, including
watcher reservation/completion bookkeeping and own-promotion preflight. Each
attempt reloads/folds the record and rechecks all ownership generations, native
identity, source, STOP/HOLD, queue and observed-file fences. Changed authority
still refuses. The operation starts only after exact validation under the lock;
once it starts, no exception can cause it to replay. Explicitly prepared guards
and all-record batch FF fences retain their existing single-use contract.

Only source conflicts created by the observation/store module qualify. A native
refusal with the same error code does not. A nested record transaction or
configuration audit also revokes replay, including effects during preparation.
Generic `planTransaction` callbacks still require `replaySafe:true`; legacy
`transact` effects remain single-shot. Report intake already opts in and retains
one immutable publication. Post-FF landing receipts now opt in for read-only
derivation, comparing each fresh native read to the original binding; their
final worktree status/validation callback and append never replay.

`record-conflicts.jsonl` is best-effort diagnostic evidence outside the lock,
with source fingerprint/path, caller, Node, attempt, retry decision and effect
state. Its rows distinguish retried conflicts from exhaustion and ineligible
effects. It is not authority, nor proof that older loaded processes adopted the
change. Live acceptance needs a qualified busy hour and actual final notice
receipts; an empty or short journal alone proves neither zero losses nor zero
unretried conflicts. Existing watchers, services, runtime bindings and pins are
left in place.

The retained live timing for PID 82587 is more specific than the initial
whole-drain diagnosis: `lib/closeout-executor.mjs:393`, actor `lane closeout`,
held the record for 268515.456416 ms, ending 2026-10-28T19:45:32.189Z. That callback
derives `registerCloseoutWait`; the drain itself has no enclosing record lock.
All eight executor transaction sites now use audited read-only planning outside
the lock, with exact record/file CAS and only append/fsync under it. Intent IDs
and closed-session derivation restart from their original inputs on each plan;
deduplication and positive never-started requirements still use fresh events.
Native/Git/Herdr effects, code freshness, consumer/retirement/queue/promotion
locks, pre-command guards, original UNKNOWN/refused intents and archives retain
their boundaries. The producer's promotion-queue reads now use the observation
facade. Status linking skips impossible matches before scanning prior statuses,
avoiding repeated full-history copies for unrelated completion candidates.

Producer selection: `test/record-conflict-retry.test.mjs`,
`test/record-outer-locks.test.mjs`, `test/record-planning.test.mjs`, once through
the existing runner and canonical lane check, on clean committed source. The
new watcher restart/race control and affected closeout contention controls are
provided for the release coordinator; native process-source/fs.watch files are
unrun by this worker under L-43. No default, tier, full-release or reviewer suite
is substituted. Actual receipts and any red/correction belong in R-1191's report.
