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
node verify/verify.mjs status [JOB_ID]
node verify/verify.mjs admit JOB_ID=SPEC_SHA256 OTHER_JOB_ID=SPEC_SHA256
node verify/verify.mjs status --group regression-1
node verify/verify.mjs recover
node verify/verify.mjs init [--state-dir ABS_PATH]
node verify/verify.mjs probe-store [--state-dir ABS_PATH]
```

Submit prints `{"job":"…","receipt":"/absolute/path/receipt.json","spec_sha256":"…"}`. Jobs stay
`pending-admission` until `admit`; the supervisor can use `submit --admit` for its
own jobs. No permission comparison or auto-admission policy is inferred from
harness/session metadata. Admission while a worker is active refuses: an existing
worker cannot inherit a later admitting process's native permissions. Admit a batch
together, or admit the next batch after it finishes. Unadmitted jobs do not hold
up admitted work; admitted jobs run in submission order, regardless of the order
of IDs passed to `admit`. There are no priorities, classes or group verdicts.
Submission writes only the untrusted inbox at `GIT_COMMON_DIR/verify-inbox`.
Admission copies the selected immutable specifications into the trusted store,
captures their SHA256 digests and passes the exact ID/digest allowlist to the
worker through argv. Inspect `status` before admission: a job that never started
and holds no current admission displays its current inbox specification and
`spec_sha256`. Admitted, started, retry-required and completed jobs display the
trusted spec that was admitted.
`admit` requires `JOB=SPEC_SHA256`; bare IDs refuse, and a changed inbox digest
refuses before a worker starts. It prints `{"admitted":{"JOB":"SPEC_SHA256"}}`.
A trusted admitted spec is never overwritten. A pending job requires a fresh
explicit admission against its current inbox digest; changed content after a
prior admission requires submission as a new job. `submit --admit` binds the
specification created by that submit call. Submitter-supplied admission,
completion and publication fields are discarded. After admission, drain and
recover read only the trusted
store; inbox edits, injected jobs and planted inbox receipts have no authority.
A changed trusted specification halts the batch before execution. The receipt
records `admitted_spec_sha256`. All submit fields,
including prepare, expectations, bounds and delivery settings, are bound. The
admitted snapshot also travels through argv to both slot phase processes;
`jobs/JOB/spec.json` retains an evidence copy.

The trusted store defaults to
`${XDG_STATE_HOME:-~/.local/state}/herdr-monitor/verify/<sha256 of canonical Git common directory>`;
`--state-dir ABS_PATH` selects another. The module refuses a trusted store inside
the repository, its Git common directory, any registered worktree, any job's
desk or record, or system temp (`/tmp`, `/private/tmp`, `$TMPDIR`). Paths are
resolved through existing ancestors before checking, including symlink aliases.
Repeat `--untrusted-root PATH` to list additional worker write roots, or set
`VERIFY_UNTRUSTED_ROOTS` to a colon-separated list. Both sources apply together;
the detached worker inherits the CLI roots as well as environment roots.

The trusted store **must be outside every submitter's sandbox write roots**.
The module cannot inspect native sandbox policy; mode 0700 alone does not
separate processes running as the same user. Adoption requires the supervisor
to run `node verify/verify.mjs init` from its trusted permission context, then run
`node verify/verify.mjs probe-store` from each worker sandbox with the same
`--repo`, `--state-dir` and root options. Init applies the admission location
guards, creates the store with mode 0700 and prints its path. It is idempotent
and refuses an existing store with a different owner or mode.
Require `state: protected` with `writable: false` and code `EACCES` or `EPERM`
before relying on any receipt. The probe attempts exclusive creation of a unique
file and removes it if created; it creates no directory and changes no permissions.
It always includes `code` (`null` on success) and `error`. A missing directory
reports `state: absent`, `writable: null`, code `ENOENT` and a nonzero exit,
with instructions to run `verify init` from the trusted side. Any other error
reports `state: unknown`, `writable: null` and a nonzero exit. Neither proves
isolation. `state: writable` with `writable: true` means adoption must fix the
store location or worker sandbox policy first. An unsandboxed worker with write
access to the trusted store cannot provide this boundary. Existing Git-local
queue state is not imported as trusted
execution evidence; resubmit jobs after configuring the store.

`--repo` selects the repository on every command. `--desk` is
per job: a name (default `default`) under `STATE/desks/`, or an absolute path.
Named desks under the trusted store are recommended. Desks need the same
isolation from every submitter's sandbox write roots as the trusted store.
Submission, admission and execution each refuse desks under the repository,
Git common directory, other registered worktrees, the record, system temp or
configured untrusted roots, resolving symlink aliases. An already registered
runner-owned desk can be reused; its own worktree entry is the sole exception
to the worktree check, and all other roots still apply.
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
every captured process, escaped or still in the phase runner's group, is confirmed gone,
including after a job timeout.

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

When the job watchdog wins the cleanup race, every captured process without an
individual signal entry, whether escaped or in the shared phase group, is recorded
with its birth identity, `signal: null`, `source: job-watchdog` and `confirmed_gone: true`;
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
no job and never rewrites a receipt. Immediately after exclusive publication,
the runner records `receipt_sha256` on the trusted job row, before delivery.
Recovery requires a started job, a matching admission and that exact hash.
Other receipts, including receipts with no admitted trusted job, are listed in
`unverified` with no note or notice. A worker refuses any pre-existing receipt
with `runner.error`; only recovery can finish a prior worker's verified delivery.
An interrupted job without a verified receipt becomes `needs-retry` and
cannot be admitted again: inspect its desk and surviving owned processes and
submit a new job. Recovery returns unstarted jobs to `pending-admission`, saves
the old runner as `last_runner`, and clears the active admission. If delivery
fails again, the admission remains for another recovery attempt. Retain state
and logs. Never remove a live worker or host-slot lock to restart a queue.

Offline fixtures: `node --test verify/test/verify.test.mjs` (private temporary
slots only; no models, live Herdr sessions or project gates).
