---
run: R-224
outcome: done
summary: |
  Added a scratch-owned supervisor-events consumer to the restored legacy rollback canary, preserving the actual supervisor PTY receipt and requiring exactly one consumed outbox report. The copied consumer uses a kernel-assigned loopback port, explicit scratch queues and record, the scoped Herdr adapter, lifecycle receipts, and bounded teardown on success, failure and global cleanup. Wrote the failing offline regression first from the dated snapshot, then implemented the fix. The offline acceptance suite passed 193 of 194 tests; its sole failure was an existing discovery test refused by a concurrent promotion's host test slot, and that selected test passed on retry after the slot cleared. Final consumer regressions passed 7 of 7. Committed the fix and rebased onto main after the reviewed parent lane landed.
headline: The rollback canary now consumes queued reports in scratch and verifies supervisor delivery
blockers: []
proposals: []
learnings:
  - The snapshot's supervisor-events consumer accepts SE_LOCK_PORT=0; an import wrapper can receipt the actual kernel-assigned port without changing the copied service's rollback bytes.
  - A queued notify-watch report is not delivery proof. The canary now waits for the PTY receipt, the supervisor-events sent log and disappearance of that report from the outbox, then checks both receipt counts after stopping the consumer.
  - Inherited SE_ and NW_ variables must be scrubbed before executing copied legacy scripts; textual relocation alone does not prevent an environment override selecting live queues or ports.
  - Fixture consumers must stop before their scratch roots are removed. Failed receipt writes must not prevent signaling and awaiting the owned child.
artifacts:
  - "Code and evidence commit: 330db13 on lane/rollback-canary"
  - "Rebased onto main at 416612c; the parent update contains its passing independent review only"
  - acceptance/run.mjs
  - acceptance/legacy-consumer.mjs
  - acceptance/test/legacy-consumer.test.mjs
  - acceptance/test/harness.test.mjs
  - docs/reports/evidence/ENG-167/R-224-regression-red.tap
  - docs/reports/evidence/ENG-167/R-224-acceptance.tap
  - docs/reports/evidence/ENG-167/R-224-discovery-retry.tap
  - docs/reports/evidence/ENG-167/R-224-consumer-final.tap
decisions:
  - text: Start the restored event service before legacy dispatch, using scratch-only configuration and a kernel-assigned port, and stop it before declaring the legacy canary complete.
    category: tooling
    why: This exercises the snapshot's actual queued notification transport and retains strict supervisor receipt evidence without touching the live consumer's outbox, locks or fixed port.
  - text: Use an owned ChildProcess handle for bounded termination and retain startup, readiness, exit and stop receipts under acceptance evidence.
    category: tooling
    why: Saved PIDs are evidence only; partial startup and failed canaries still need deterministic cleanup before capturing evidence and completing scratch teardown.
questions: []
challenges:
  - "The full offline acceptance invocation had one TEST_SLOT_HELD failure in the existing concurrent-discovery test while the canonical promotion batch held the host slot. The selected offline retry passed after the slot cleared; no production test-slot behavior was changed. This is the already-recorded ENG-156 condition."
  - "No live acceptance or skip-live pass ran. Release cases 19 and 20 are not claimed green; their next release gate must establish that result."
---

The fix is in `330db13`. The canary starts the copied
`.lane/supervisor/supervisor-events.mjs` after restoring the exact relocated
baseline and before invoking legacy dispatch. It uses the existing independent
copied-code sandbox and scratch capability adapter, pins the scratch record and
supervisor name, and places waiter, gate-request and slot paths in a private
instance directory. Port zero lets the kernel allocate an unused loopback port;
readiness requires both its listening receipt and the service's own PID receipt
to match the spawned child. The copied service itself is unchanged.

The report must reach the actual scratch supervisor PTY. The canary additionally
requires a `supervisor-events` sent receipt and a drained report message, stops
the consumer, and then checks that both the delivery log and PTY contain exactly
one matching notice. The legacy outcome/verdict fields and watcher log remain
required. A queued file alone cannot pass. Lifecycle JSON, child output and
service inbox/notification logs are retained as evidence even on cleanup.

The handle is registered before the asynchronous startup wait. Canary `finally`
and global cleanup both stop it, with bounded SIGTERM then SIGKILL escalation.
Global cleanup drains it before auditing adapter producers or removing scratch.
Termination uses the owned child handle rather than discovering or signaling
processes from a live service PID file. All inherited legacy transport settings
are removed, including those that could redirect the restored watcher itself.

Validation ran through `node test/helpers/run.mjs` from an escalated shell where
macOS sandbox fixtures could apply their own policies. Tests remained offline:

- The first regression failed with `timeout: scratch supervisor receipt` after
  the actual snapshot watcher queued its done report and no consumer ran.
- `node test/helpers/run.mjs acceptance/test/*.test.mjs` exercised 194 tests:
  193 passed, with the host-slot refusal described above. All cutover, security,
  harness and new consumer cases passed.
- The selected concurrent-discovery retry passed its one selected test; the
  other two tests in that file were omitted by the name filter.
- The final `acceptance/test/legacy-consumer.test.mjs` run passed all seven
  tests, including real snapshot outbox delivery, busy input deferral, foreign
  configuration refusal, released instance port, early exit, readiness timeout,
  SIGKILL fallback, startup/stop receipt-write failures and the independent macOS
  copied-code sandbox.
- Node syntax checks and diff whitespace checks passed.

An exploratory focused invocation exposed a cleanup-order bug in the new test
fixture after its injected environment assertion failed. Its owned runner was
stopped through the runner's IPC/group cleanup, and fixture teardown was fixed
before the full suite. Both receipt-write failure paths now prove that the child
has exited even when evidence cannot be written. No live bch-cloak state or pane
was touched by these offline checks.

The parent lane landed while validation ran. This lane rebased cleanly onto
main, including the parent's passing review; its code did not change during
that rebase. This report is checked before its own commit. Per the brief, the
last operation after that commit is `node lanes/lane.mjs check`; its result is
returned in the session output rather than changing the report afterward.
