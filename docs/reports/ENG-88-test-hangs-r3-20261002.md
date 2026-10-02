---
run: R-85
outcome: done
summary: |
  Fixed both round-three Majors with regression tests. A guardian outside the worker group stops test producers and discovers unregistered descendants before the final ledger snapshot; spawn rollback is installed before registry writes can fail. Every fixture signal now requires a fresh successful start-time and full-command match, with failed or incomplete lookups reported and refused. Rebased onto main, preserved its atomic discovery receipt writer, and bounded newly merged MCP, console, and acceptance tests. Full, parallel-load, acceptance, MCP, and lane suites passed. The report-inclusive lane check runs last.
headline: Cancellation now reaps children spawned during cleanup and refuses unconfirmed process signals
blockers: []
proposals: []
learnings:
  - A ledger snapshot cannot close the spawn race while test files can still produce detached children. Stop producers outside their process group, discover descendants, and only then take the final snapshot.
  - Capture completion and install teardown before registration; hand the positively identified process tuple to rollback before a ledger append can throw.
  - A failed process query is different from confirmed absence. Neither failure nor an absent historical group leader authorizes a signal.
  - A batch snapshot enumerates candidates but never authorizes later signals. Reconfirm start time, full command, and group leadership immediately before each signal without an intervening await or fallback.
  - Normalize process lookup locale and timezone so an owned birth tuple survives caller timezone changes.
artifacts:
  - "Commit: Stop test producers before cleanup and require fresh process ownership"
  - "Commit: Bound newly merged MCP console and acceptance tests"
  - "Earlier retained commit: Reap nested test workers on outer cancellation and refresh reused PIDs"
  - "Earlier retained commit: Prove atomic receipt publication and wait for filesystem watch readiness"
  - "Branch: lane/test-hangs, rebased onto main"
  - test/helpers/processes.mjs
  - test/helpers/run.mjs
  - test/helpers/child.mjs
  - test/processes.test.mjs
  - test/test-hangs.test.mjs
  - "Final cleanup regressions: 37 passed, no failures or skips"
  - "Three concurrent full npm test runs: each 501 passed, 4 existing skips, no failures; 154.7–155.2 seconds"
  - "Nine focused load repetitions: each 60 passed, no failures or skips; 30.7–65.1 seconds"
  - "Heavy campaign process audit: 2,010 ledger entries, 1,605 distinct birth-time and command tuples, zero matching survivors"
  - "npm run test:lanes: 147 passed, no failures or skips; 432.2 seconds"
  - "Latest-main npm test: 519 passed, 4 existing skips, no failures; 70.6 seconds"
  - "Latest-main npm run test:acceptance: 59 passed, no failures or skips; 35.7 seconds"
  - "npm --prefix mcp ci and npm --prefix mcp test: 7 offline stdio tests passed, no failures or skips"
  - "Three more concurrent focused runs after rebase: each 62 passed, no failures or skips; 17.4–18.1 seconds"
  - "After-rebase process audit: 408 ledger entries, 321 distinct birth-time and command tuples, zero matching survivors"
  - /tmp/eng88-r85-full-parallel-1.log
  - /tmp/eng88-r85-full-parallel-2.log
  - /tmp/eng88-r85-full-parallel-3.log
  - /tmp/eng88-r85-load-process-check.json
  - /tmp/eng88-r85-rebased-npm.log
  - /tmp/eng88-r85-rebased-acceptance.log
  - /tmp/eng88-r85-rebased-mcp.log
  - /tmp/eng88-r85-rebased-process-check.json
  - /tmp/eng88-r85-lanes.log
  - "record check docs/reports/ENG-88-test-hangs-r3-20261002.md"
  - "Final action: node lanes/lane.mjs check after the report commit; .lane/gate.json records the report-inclusive HEAD and result"
decisions:
  - text: Quiesce producers from a separate guardian before reading the final ledger, and start an external replacement reaper if that guardian disappears.
    category: tooling
    why: A blocked test file cannot clean itself, and outer or guardian SIGKILL must still reap a detached fixture frozen before its first registration append.
  - text: Refuse and report signals when a current process identity cannot be positively confirmed; retain the cleanup ledger when cleanup is unconfirmed.
    category: security
    why: The operator explicitly prohibited signalling recycled or unconfirmed PIDs and process groups because other sessions are live on this machine.
  - text: Use deterministic lookup and signal injection for failure and reuse cases, alongside real nested-process cancellation regressions and scoped read-only survivor audits.
    category: prover
    why: Failed lookups and unrelated replacements must produce zero signal calls without risking any operator process; real subprocess tests separately prove escaped-worker cleanup.
  - text: Preserve main's atomic discovery receipt writer during rebase and apply the common execution bounds to main's newly added tests.
    category: prover
    why: The supervisor confirmed the receipt fix was already on main; integration still needs every new active suite and fixture to follow the bounded execution contract.
questions: []
challenges:
  - premise: Reading and deleting the registry before stopping test files safely covers cancellation.
    verdict: wrong
    evidence: Four real regressions freeze a detached spawn before its first append, cancel the outer runner or guardian or trigger the file or suite watchdog, and require every captured producer and unregistered child to disappear before the registry is removed.
  - premise: A missing identity after a failed ps lookup permits killing the historical PID or group.
    verdict: wrong
    evidence: Individual and batch timeout, failure, incomplete-output and thrown-lookup regressions preserve simulated unrelated replacements and require zero signal calls; successful enumeration also cannot bypass a fresh individual lookup.
---

The first Major was a spawn and cleanup ordering bug. The outer runner now
starts a separate guardian, which registers the worker before allowing tests to
start. Cancellation stops the worker and known file producers, discovers their
children and group members, stops those too, then reads the final ledger and
reaps freshly confirmed identities. This catches a detached child whose first
ledger append has not happened. If the guardian is itself killed, the worker
delegates the same sequence to a reaper outside its own group. Node's file
timeout delegates cancellation to the guardian rather than killing the file
before its in-flight spawn has been accounted for.

The four cancellation-during-spawn tests block indefinitely in the first append
after a detached fixture has been created. They verify the fixture is absent
from the ledger, then exercise outer SIGKILL, guardian SIGKILL, the file deadline,
and the suite deadline. Each requires all five known processes to disappear
within eight seconds and waits for the reaper's inherited output to close before
checking registry removal. The nested outer-cancellation tests separately check
all ten captured processes after SIGTERM and SIGKILL, including guardians,
workers, test files, shell and sleep; an unrelated sentinel must remain alive.
A standalone fixture proves an append exception rolls back its child before
the test body finishes, without a nested guardian rescuing it.

The second Major was unsafe authority from failed lookups. Process queries now
return explicit success or failure, validate complete rows and snapshots, and
preserve the full command together with the birth time. Every PID or group
signal performs a new bounded query immediately before the syscall. A changed
command, changed birth time, changed group leader, malformed identity, failed
lookup, or timeout cannot license a signal. Confirmed absence never licenses a
historical group kill. Refusals are reported; unconfirmed cleanup fails and
retains its ledger. Test fixture crash signals and promoted-worker cleanup use
the same retained birth tuples. Native ChildProcess kill return values and
bookkeeping remain intact. A timezone regression verifies UTC-normalized
lookups continue to identify the same owned child.

The heavy campaign ran three full suites and three streams of three focused
repetitions concurrently with lane and acceptance validation. Every focused run
included the discovery sweep and paused-partial-receipt regression. One cleanup
diagnostic observed a changed start-time or command between enumeration and
SIGSTOP and correctly skipped that signal; the campaign still passed. Read-only
audits compared only recorded campaign tuples with current processes and found
no matching survivors. After main advanced, another rebase preserved its atomic
receipt writer without adding another change to that writer. The added MCP,
console housekeeping and acceptance snapshot tests now use the shared bounds;
MCP's stdio fixtures also install spawn-time ownership and cleanup. The latest
full, acceptance, MCP and three parallel focused runs all passed.

The pre-change npm test used a temporary external signal guard to honor the
operator's rule even while the old implementation was present. That baseline
completed with 470 passes, two failures, one cancelled test file and four skips
in 325.4 seconds. The guard lacked ownership entries for the discovery handoff
and promoted-worker crash fixtures, so it refused their signals; the file bound
cancelled discovery. This guarded baseline is not a green validation result.
Its subsequent scoped audit found no positively matching live survivors. Final
validation uses the corrected native ownership implementation without that
preload. Installing MCP from the offline cache initially failed because one
locked package was missing; the required normal npm ci then succeeded. All
tests were offline and made no model calls.

The pre-existing untracked review artifact is preserved at
`.lane/review-preserved/56fbe2a-r2.md`. The supervisor's scratch findings were
read in place and were not copied into the repository. The report is checked
and committed before the final lane check; that last command records the clean,
report-inclusive HEAD and validation result in `.lane/gate.json`.
