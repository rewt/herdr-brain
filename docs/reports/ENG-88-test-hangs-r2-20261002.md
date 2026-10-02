---
run: R-78
outcome: done
summary: |
  Fixed both round-two findings with regression tests. Nested runners now register worker groups before starting tests and forward fixture registrations to every ancestor watchdog; a worker losing its parent also reaps its own descendants. Registrations refresh when a reused PID has a new start identity. Rebased onto moved main, retained its actor metadata, and bounded its new priorities and acceptance tests. Full, repeated parallel, acceptance, and lane validation passed; the report-inclusive lane check runs last.
headline: Killing an outer test runner now reaps its nested workers and fixture descendants
blockers: []
proposals: []
learnings:
  - Replacing an inherited watchdog registry lets detached nested workers escape outer cancellation; descendant registrations must reach every ancestor watchdog.
  - Worker startup needs an acknowledgement after group registration, and IPC disconnection supplies cleanup when the outer runner receives SIGKILL.
  - A cached numeric PID does not identify a process generation. Refresh its start identity and append the new ownership entry to every registry.
  - Deterministic injected process identities prove PID reuse without depending on the host PID allocator; real subprocess tests separately prove descendant cleanup.
artifacts:
  - "Commit: Reap nested test workers on outer cancellation and refresh reused PIDs"
  - "Commit: Keep newly merged priority tests within the execution bounds"
  - "Commit: Bound acceptance cases introduced by the latest main update"
  - "Earlier retained commit: Prove atomic receipt publication and wait for filesystem watch readiness"
  - "Branch: lane/test-hangs"
  - test/helpers/run.mjs
  - test/helpers/processes.mjs
  - test/processes.test.mjs
  - test/test-hangs.test.mjs
  - test/priorities.test.mjs
  - "Baseline npm test: 463 passed, 5 explicit skips, no failures"
  - "Three concurrent npm test runs: each 468 passed, 4 existing skips, no failures; 166.4–166.9 seconds"
  - "Nine parallel focused runs covering guards, watch and discovery lifecycle: each 36 passed without skips; six in the heavy campaign and three after rebase"
  - "After-rebase npm test: 477 passed, 4 existing skips, no failures; 84.3 seconds"
  - "Final-rebase npm test: 477 passed, 4 existing skips, no failures"
  - "After-rebase npm run test:lanes: 147 passed without skips; 397.0 seconds"
  - "npm run test:acceptance: 29 passed without skips; 41.0 seconds"
  - "Latest-main npm run test:acceptance: all 51 passed without skips; 36.9 seconds"
  - "Negative controls: prior runner and PID-only cache produced exactly the three expected regression failures; 8 other tests passed"
  - "Scoped process check: all 86 captured identities from this run's heavy workload were gone afterward"
  - /tmp/eng88-r78-validation.json
  - /tmp/eng88-r78-process-snapshot.json
  - /tmp/eng88-r78-process-check.json
  - "record check docs/reports/ENG-88-test-hangs-r2-20261002.md"
  - "Final action: node lanes/lane.mjs check after the report commit; .lane/gate.json records the report-inclusive HEAD and result"
decisions:
  - text: Forward registrations through the full ancestor registry chain, acknowledge worker registration before test startup, and reap descendants on worker IPC disconnection.
    category: tooling
    why: Outer cancellation must reach detached nested workers, including when SIGKILL prevents the runner's own handlers from executing.
  - text: Refresh each PID registration using its current start identity while retaining stale entries for identity-checked cleanup.
    category: tooling
    why: A newly owned generation must be killable, while a later unrelated replacement must survive both direct teardown and batch watchdog cleanup.
  - text: Keep existing execution bounds and use the bounded wrapper for priorities and acceptance tests introduced by main.
    category: prover
    why: New tests need the same finite execution contract; the overload experiment should fail within the bound rather than silently extend it.
questions: []
challenges:
  - premise: Registering fixture children only in their immediate runner's ledger covers outer cancellation.
    verdict: wrong
    evidence: Restoring the prior runner in disposable helper copies leaves descendants alive after both SIGTERM and SIGKILL. The new tests detect those survivors and their fallback cleanup reaps them.
  - premise: Repeated registration of a numeric PID always describes the same owned process.
    verdict: wrong
    evidence: The injected-generation regression fails with the old PID-only cache, verifies the new generation reaches both watchdog ledgers, and preserves unrelated replacements during direct and batch cleanup.
---

The Major fix addresses the escaped worker, rather than only extending a timer.
Each nested runner keeps its local ledger and passes the complete ancestor chain
to its worker. Both detached workers and fixture children register with that
chain. Worker startup waits until its group has been recorded. An independent
worker observes its runner's IPC disconnection and reaps registered descendants,
including itself last, even when the runner was killed with SIGKILL.

The two cancellation regressions create two nested runners. The inner test
starts a shell with a sleep child, writes complete receipts atomically, then
blocks its event loop indefinitely. The enclosing test kills the outer runner
with SIGTERM or SIGKILL and checks all eight known process IDs: outer runner,
outer worker, enclosing test process, nested runner, nested worker, blocked test
process, shell, and sleep. It requires every one to be gone within five seconds
and verifies an unrelated sentinel remains alive. Fallback teardown also reaps
the reproducer if an assertion fails. Temporary negative controls restore the
prior runner and fail both named cancellation tests with surviving descendants.

The Moderate regression simulates one numeric PID across owned, unrelated, newly
owned, and later unrelated generations. It verifies refreshed identities reach
both local and ancestor registries, repeat registrations do not duplicate an
acknowledged generation, direct teardown and batch cleanup kill the new fixture,
and neither stale entry kills an unrelated replacement. Restoring the PID-only
cache fails this regression. A separate test verifies ancestor path deduplication
and registration with an additional ancestor.

The discovery receipt fix from the first round remains intact. All nine focused
parallel runs include `next entry sweeps killed untouched owners and preserves
every form of work` and the deterministic paused-partial-write regression.
Writers still use same-directory rename; readers retain strict JSON parsing.
No receipt parse failures occurred in those runs or the full suites.

The heavy campaign ran three full suites, six focused suites, acceptance, lanes,
and the negative controls concurrently. The first lane run finished in 450.4
seconds with 146 passes and one failure: its dispatch start-failure scenario hit
the synchronous command bound and returned a null status. After that campaign,
the unchanged bounds passed the same scenario and all 147 lane tests in the
separate rerun. The captured 86 process identities from the heavy campaign had
no survivors after it finished. Raw logs and disposable negative-control helpers
remain under `/tmp/eng88-r78-*`.

Main advanced while validation was running. The completed rebase retains its
test actor changes alongside the cleanup helpers; its newly added priorities
suite now uses the bounded wrapper. The after-rebase full run and three focused
parallel repetitions validate that integration. An overbroad conflict-resolution
script was caught before final validation; the rebase was redone from the clean
committed tip, preserving all surrounding tests. Main subsequently added
acceptance cases and overlapping watcher teardown changes. A final rebase keeps
the centralized watcher guards, adds bounded wrappers to the three new
acceptance files, and passes another full run plus all 51 acceptance unit tests.

The pre-existing untracked review artifact was preserved at
`.lane/review-preserved/e4646d2-r1.md` so it does not dirty the final gate. The
supervisor's scratch review was read in place and was not copied into the repo.
The report is checked and committed before the final lane check; that last
command records the final clean HEAD in `.lane/gate.json`.
