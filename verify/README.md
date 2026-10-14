# Verification jobs

`verify.mjs` submits bounded jobs and exits. Explicit supervisor admission starts
one detached, finite FIFO worker; the model session never waits for the host slot.
The module has no dependencies and never changes native permissions or sandbox
settings. Run `admit` only from the project supervisor's intended permission
context. That process's environment and permissions are inherited by the worker.

```sh
node verify/verify.mjs submit --repo /project --org /project/.org --item ENG-1 \
  --sha FULL_COMMIT_SHA --group regression-1 --desk background \
  --timeout-seconds 900 --idle-timeout-seconds 120 \
  --expect exit=0 --expect-tap 'pass>=20,fail=0,skip=0' \
  --expect-test 'a specific test title' --expect-file 'out.json=SHA256' \
  --expect-json 'out.json#/results/passed=20' \
  --prepare pnpm build -- pnpm test --reporter=tap
node verify/verify.mjs admit JOB_ID OTHER_JOB_ID
node verify/verify.mjs status [JOB_ID]
node verify/verify.mjs status --group regression-1
node verify/verify.mjs recover
```

Submit prints `{"job":"…","receipt":"/absolute/path/receipt.json"}`. Jobs stay
`pending-admission` until `admit`; the supervisor can use `submit --admit` for its
own jobs. No permission comparison or auto-admission policy is inferred from
harness/session metadata. Admission while a worker is active refuses: an existing
worker cannot inherit a later admitting process's native permissions. Admit a batch
together, or admit the next batch after it finishes. Unadmitted jobs do not hold
up admitted work; admitted jobs run in submission order, regardless of the order
of IDs passed to `admit`. There are no priorities, classes or group verdicts.
Admission captures each job's immutable specification as a SHA256 digest and
passes the exact ID/digest allowlist to the worker through argv. Queue edits
cannot expand that allowlist; a changed specification halts the batch before
execution. The receipt records `admitted_spec_sha256`. All submit fields,
including prepare, expectations, bounds and delivery settings, are bound. The
admitted snapshot also travels through argv to both slot phase processes;
`jobs/JOB/spec.json` retains an evidence copy.

The default state directory is `GIT_COMMON_DIR/verify`; `--state-dir ABS_PATH`
selects another. `--repo` selects the repository on every command. `--desk` is
per job: a name (default `default`) under `STATE/desks/`, or an absolute path.
Only runner-created, registered detached worktrees are accepted. Each desk
keeps its own ignored caches and prepared state. Before a job the runner refuses
a dirty desk, saves `desk_previous_sha`, checks out the exact commit, verifies
its tree, and runs `git clean -fd`. After evaluation it restores the previous
commit and removes generated untracked files with `git clean -fd`; ignored files
survive. It never uses `-x`. Dirty/unknown restoration or process ownership halts
the batch for inspection. A job on one desk never touches another desk.

Prepare argv follows `--prepare` and consumes all arguments up to `--`; command
argv follows `--`. Put all submit options before `--prepare`. Neither phase uses
an implicit shell; use `/bin/sh -c '…'` explicitly when needed. The optional
prepare and command run in the same `test-slot run` hold with grant and result
sidecars. Preparation failure is `error` and skips the command. Every job has a
positive wall cap (default 4500 seconds), positive no-output cap (default 300
seconds), and bounded slot wait (`--wait`, default 86400 seconds). Caps cover
prepare plus command, starting after slot grant. Jobs never retry automatically.
An outer host hold leaves 60 seconds beyond those caps for cleanup; a nested
job watchdog enforces the requested caps. The coordinator keeps that hold until
observed escaped processes are confirmed gone, including after a job timeout.

`--expect exit=N` defaults to zero; repeatable `--expect-tap` and
`--expect-vitest` accept `pass`, `fail`, `skip` with `=`, `>=`, `<=` comparisons.
Missing totals fail. `--expect-test` requires an exact title from a TAP result or
verbose Vitest result; skipped titles do not count. Only command output supplies
these results, so select a reporter that prints the titles needed. `--expect-file`
checks SHA256, and `--expect-json REL#/json/pointer=JSON` checks structural equality
at an RFC 6901 pointer (empty pointer selects the whole document). Artifact paths
must stay inside the desk. Each expectation records its own actual result.

The first job with `--group ID` fixes that group's SHA and tree for the lifetime
of the queue. A later different snapshot refuses. Group status lists individual
receipt paths and outcomes; callers schedule multi-job runs and interpret them.

Each job publishes exactly one `verify-receipt/v1` using exclusive create. It
records snapshot/build identity, previous desk SHA, prepare argv/exit/duration
(or `"none"`), command argv, environment fingerprint, admission and slot timing,
holders seen, command exit/signal, totals, expectations, watchdog timeouts and
identity-confirmed reaped processes. Logs are private mode 0600 under state;
the receipt records their paths and SHA256, without silently redacting output.
Environment values are fingerprinted and are never stored. One plain item note
attaches the receipt path/hash; one durable supervisor notice goes to `--to`,
defaulting to `MONITOR_SUPERVISOR_AGENT` then `supervisor-herdr`.

When the job watchdog wins the cleanup race, escaped process entries record
their observed birth identities and confirmed disappearance with `signal: null`;
the unchanged slot protocol does not identify which individual signal won.

The existing process-tree snapshot and watchdog reap observed descendants,
including separate sessions/groups. A process double-forked and reparented before
observation remains outside the parent-walk boundary, as with the host watchdog.
Unknown identity fails closed. On a worker exception, `status` exposes
`runner.error` and unstarted jobs return to `pending-admission`. Run `recover`
from the supervisor's intended permission context after inspecting the failure.
It requires no existing `worker.lock` (including a stale crash lock), acquires
that lock to exclude other workers, and re-delivers published receipts' plain
notes and notices with the same IDs. Delivery is idempotent; recovery executes
no job and never rewrites a receipt. A receipt must match the job's admitted
specification. An interrupted job without a receipt becomes `needs-retry` and
cannot be admitted again: inspect its desk and surviving owned processes and
submit a new job. Recovery returns unstarted jobs to `pending-admission`, saves
the old runner as `last_runner`, and clears the active admission. If delivery
fails again, the admission remains for another recovery attempt. Retain state
and logs. Never remove a live worker or host-slot lock to restart a queue.

Offline fixtures: `node --test verify/test/verify.test.mjs` (private temporary
slots only; no models, live Herdr sessions or project gates).
