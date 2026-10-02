---
run: R-72
outcome: done
summary: |
  Bounded all active offline test suites, synchronous commands, and fixture children, with spawn-time completion capture, guaranteed process-group cleanup, and an independent suite watchdog. Replaced watcher startup/grace sleeps with observable fixture handshakes and atomically published discovery lifecycle receipts. Deliberate leaks, failures before waiting, child/test timeouts, blocked event loops, and partially written receipts have regression evidence. Rebased onto main and retained its new console and promotion tests in the bounded suite.
headline: Tests now fail within a bounded time and clean up their fixture processes
blockers: []
proposals: []
learnings:
  - The original watcher cleanup was installed only when waitForExit was reached; a readiness timeout or assertion before that point left a live fixture watcher keeping node:test open.
  - Attaching close listeners when a caller eventually waits can miss an already closed child. Capture the result and output at spawn time instead.
  - Waiting for a receipt pathname to exist does not make a direct write complete. Publish fixture JSON by same-directory rename.
  - Node 20 supports the programmatic test runner timeout, but JavaScript timers cannot interrupt a blocked event loop or spawnSync. Independent process and command bounds are necessary.
  - Native filesystem watcher registration can lag construction under load; a delivery probe must wait for backend readiness. The outer sandbox can reject notifications asynchronously with EMFILE.
artifacts:
  - "Commit: Bound test execution and reap fixture processes on every exit"
  - "Commit: Prove atomic receipt publication and wait for filesystem watch readiness"
  - "Commit: Allow schema review fixtures enough startup time under load"
  - "Branch: lane/test-hangs"
  - test/helpers/bounded-test.mjs
  - test/helpers/child.mjs
  - test/helpers/processes.mjs
  - test/helpers/run.mjs
  - test/test-hangs.test.mjs
  - watch/test/watch.test.mjs
  - discovery/test/lifecycle.test.mjs
  - docs/reports/ENG-88-test-hangs-validation-20261002.json
  - "Three concurrent native npm test runs: each 464 passed, 4 existing skips, no failures; 96.0–97.3 seconds"
  - "Nine watch/lifecycle suites in three concurrent streams: each 25 passed, no failures or skips; 16.1–17.4 seconds"
  - "Native npm run test:acceptance: 29 passed"
  - "npm run test:lanes: 147 passed, no failures or skips; 351.7 seconds within the eight-minute file bound"
  - "Restricted npm test after the final lane fixture change: 463 passed, 5 explicit skips, no failures"
  - "Receipt negative control: restoring direct publication fails the partial-write regression with its name and cleans up its child"
  - "record check docs/reports/ENG-88-test-hangs-20261002.md"
  - "lane check runs last after the report commit; its gate identifies the final clean HEAD"
decisions:
  - text: Keep the guards in dependency-free test helpers and leave production watcher and record behavior unchanged.
    category: prover
    why: The hang originates in fixture lifetime and test synchronization; no model calls, stored status, live schedule, or production lifecycle policy is needed to fix it.
  - text: Capture fixture output and completion at spawn time, enforce a child deadline, and kill explicitly registered process groups on teardown and watchdog exit.
    category: tooling
    why: An assertion before waiting, an already closed child, a stubborn shell descendant, and a blocked test loop all need cleanup paths that do not depend on reaching a later wait.
  - text: Write discovery fixture receipts atomically through rename and retain strict JSON parsing.
    category: prover
    why: The writer owns the race. Atomic visibility fixes it without hiding malformed completed data from the reader.
  - text: Cap tests at 60 seconds and fixture/synchronous commands at 15 seconds, with five-minute files and a six-minute default suite watchdog; use eight-minute files and a nine-minute watchdog for the large lane suite.
    category: prover
    why: The lane file exercises many review/schema variants sequentially and exceeded smaller file bounds while making progress. Both suites remain finite; smaller explicit deadlines still apply.
questions: []
challenges:
  - premise: A timeout added only inside waitForExit prevents a test suite hang.
    verdict: wrong
    evidence: Readiness checks and assertions can fail before that function is called. The named failure-before-wait regression now kills both its fixture shell and grandchild.
  - premise: A receipt that exists can immediately be parsed as complete JSON.
    verdict: wrong
    evidence: The regression deliberately pauses a write halfway through; direct publication exposes the truncated receipt and fails, whereas rename publication stays invisible until the complete write and allows the sweep to finish.
  - premise: The restricted outer sandbox provides the same filesystem and nested-sandbox test coverage as native execution.
    verdict: wrong
    evidence: It rejects filesystem notifications with EMFILE and nested sandbox/socket checks with permission errors. Those cases were exercised in native offline runs; filesystem unavailability now produces an explicit skip instead of a false filesystem-wake pass.
---

The R-19 test previously waited only two seconds for its mocked Herdr wait to
start, then used a fixed 150 ms delay to assume idle grace had started. Under
load, a failed readiness check could leave the watcher alive before its exit
timer or cleanup was installed. Tests now register children immediately, wait
for observed working/idle states, and use bounded readiness waits. The R-8 and
unknown-worker fixtures also wait for actual startup rather than racing a
100 ms startup sleep. The filesystem-wake case observes report checks while the
worker remains working, so the independent Herdr stop signal cannot silently
stand in for filesystem delivery.

The shared test wrapper supplies the per-test deadline and bounds synchronous
subprocess calls, including calls made by imported product modules in the test
process. The outer runner executes four files at a time and reaps its own
process group plus explicitly registered fixture groups. Registration happens
at spawn or detached startup acknowledgement; cleanup does not select processes
by workspace label or command-name pattern. Where available, process start
identity prevents killing a reused PID. Watch, dispatch, housekeeping,
discovery, acceptance signal, record concurrency, lane, and newly merged
promotion fixtures use these cleanup paths.

The seven guard regressions cover a waiter arriving after close, a child leaked
by a completed test, failure before waiting, test cancellation, child deadline,
a blocked event loop caught by the file bound, and the independent suite bound.
Their subprocess tests assert nonzero exit, the culprit name/path, and dead
fixture PIDs; the shell cases also verify that the grandchild is gone.

Discovery's owner, native-session, and ownership-handoff receipts now write a
temporary sibling and rename it. A deterministic regression pauses the owner
receipt write after half its JSON is written, checks that the published path is
still absent, releases the write, parses the completed receipt, kills the owner,
and confirms that the next entry sweeps it. A temporary negative control using
the old direct publication fails with `the reader must not see the truncated
receipt` and terminates normally with cleanup.

The first stress attempt found a race in the new filesystem capability probe;
it was corrected to wait for actual backend event delivery and the entire
parallel run was repeated successfully. The large lane suite also found a
four-second deadline in a positive schema acceptance case. It now allows ten
seconds, within the command and suite bounds, while keeping the schema assertions.

The final before/after process comparison found no surviving fixture processes
owned by this run and no new unattributed fixture processes. Concurrent fixtures
from another lane were identified through their parent process ancestry and
excluded; they were left untouched. The retained JSON includes test totals,
elapsed times, bounds, and the scoped process checks. Raw logs and snapshots stay
under `.lane/test-hangs-validation/`.

All checks use disposable fixtures, remain offline, and call no model or live
operator pane. No release, shared lane configuration, bch-cloak checkout,
installed binary, production housekeeping schedule, push, or publish was changed.
The final lane check is intentionally run after this report is committed so its
gate names the report-inclusive HEAD.
