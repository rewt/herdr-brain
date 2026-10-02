---
run: R-94
outcome: done
summary: |
  Replaced guardian/reaper cleanup with one live process group per suite. Fixtures inherit that group, the suite leader remains alive until teardown, and a report-only audit names surviving members and fails the suite. Removed suspension, descendant discovery, registration journals, ancestor chains, generation caches, and replacement reapers. Both round-three Majors are addressed by removing their failure conditions, with real subprocess regressions. Rebased onto main, bounded its new settlement fixtures, ordered child completion before fixture directory removal, and preserved the atomic discovery receipt writer. Repeated full and focused parallel runs, lanes, acceptance, and console validation passed; a read-only audit found zero attributable survivors and excluded one recycled historical leader. The report-inclusive lane check runs last.
headline: Tests now use simple group cleanup and fail with a named report of surviving fixtures
blockers: []
proposals: []
learnings:
  - A fixture parent can exit before its background child. Retaining the suite group leader avoids depending on that departed parent or reconstructing its ancestry.
  - Group inheritance accounts for a child even before its ownership lookup finishes; cancellation does not need a registration journal or a stopped producer.
  - A report-only audit can fail independently of teardown. Failed batch enumeration must still allow a fresh individual check of the known suite leader before ordinary group cleanup.
  - Completed ChildProcess instances must not look up or signal their historical PIDs; the OS may already have recycled those numbers.
  - Fixture cleanup hooks run in registration order; a fixture hook installed before a concurrent child hook must await bounded child completion before stopping watchers and removing directories.
  - Kernel-confined acceptance fixtures cannot import host test preloads. Keep their existing isolation intact and their synchronous commands bounded.
artifacts:
  - "Commit: Contain test fixtures in one live suite group and report survivors"
  - "Commit: Bound settlement fixtures and wait for asynchronous process reaping"
  - "Commit: Wait for settlement fixture children before removing directories"
  - "Branch: lane/test-hangs, rebased onto main"
  - test/helpers/run.mjs
  - test/helpers/fixture-policy.mjs
  - test/helpers/child.mjs
  - test/helpers/processes.mjs
  - test/test-hangs.test.mjs
  - test/processes.test.mjs
  - settle/test/fixture.mjs
  - settle/test/settle.test.mjs
  - "Baseline npm test: 519 passed, 4 existing skips, no failures; 87.1 seconds"
  - "Cleanup regressions: 33 passed, no failures or skips"
  - "Focused long-lived-fixture integration: 149 passed, no failures or skips"
  - "First three concurrent full suites: each 513 passed, 4 existing skips, no failures; 93.9–94.0 seconds"
  - "Next three concurrent full suites: each 515 passed, 4 existing skips, no failures; 89.0–90.7 seconds"
  - "After-rebase npm test: 549 passed, 4 existing skips, no failures; 162.3 seconds"
  - "Three concurrent full suites after rebase: each 549 passed, 4 existing skips, no failures; 272.8–274.6 seconds"
  - "Final three concurrent cleanup/watch/lifecycle repetitions: each 58 passed, no failures or skips; 37.8–51.1 seconds"
  - "After-rebase npm run test:lanes: 148 passed, no failures or skips; 439.0 seconds within the existing bounds"
  - "After-rebase npm run test:acceptance: 59 passed, no failures or skips; 49.9 seconds"
  - "npm --prefix console test: 197 passed, no failures or skips"
  - "Settlement suite with teardown ordering: 35 passed, no failures or skips; 123.6 seconds"
  - "Final concurrent cleanup/watch/lifecycle/settlement repetition: 74 passed, no failures or skips; 166.6 seconds"
  - "Deterministic settlement scenarios: 16 passed, no failures or skips; 139.4 seconds while parallel suites started"
  - "Final three concurrent full suites after settlement teardown fix: each 550 passed, 4 existing skips, no failures; 270.8–272.9 seconds"
  - "Read-only process audit: 346 captured suite-group identities, one recycled leader excluded, zero attributable live surviving members"
  - "Negative control: disabling only the audit in disposable helper copies makes the leader-first-exit regression detect an erroneous zero exit"
  - /tmp/eng88-r94-rebased-full-parallel-1.log
  - /tmp/eng88-r94-rebased-full-parallel-2.log
  - /tmp/eng88-r94-rebased-full-parallel-3.log
  - /tmp/eng88-r94-rebased-lanes.log
  - /tmp/eng88-r94-rebased-acceptance.log
  - /tmp/eng88-r94-load-group-audit-final.json
  - /tmp/eng88-r94-negative.log
  - /tmp/eng88-r94-directory-negative.log
  - /tmp/eng88-r94-settle-handshake.log
  - /tmp/eng88-r94-directory-focused.log
  - /tmp/eng88-r94-directory-full-parallel-1.log
  - /tmp/eng88-r94-directory-full-parallel-2.log
  - /tmp/eng88-r94-directory-full-parallel-3.log
  - "record check docs/reports/ENG-88-test-hangs-r4-20261002.md"
  - "Final action: node lanes/lane.mjs check after the report commit; .lane/gate.json records the report-inclusive HEAD and result"
decisions:
  - text: Use one persistent suite group leader, keep fixtures in that group, and perform ordinary group teardown on every result.
    category: design
    why: One known live anchor covers fixture descendants after their parents exit, including children spawned before any helper can record their identities.
  - text: Remove guardian/reaper roles, SIGSTOP, ancestry discovery, registration journals and ancestor forwarding; make the final audit report surviving group members without signalling them individually.
    category: design
    why: Those mechanisms created ordering and recovery failures while trying to maintain a changing process tree. Inherited group membership supplies the required containment without that state.
  - text: Keep fresh start-time and full-command checks immediately before every helper PID or group signal, and report refused or unconfirmed cleanup.
    category: security
    why: The operator's earlier hard rule remains in force; other agents and operator sessions must not be exposed to historical PID or group signals.
  - text: Contain Node daemon launchers through a test-only preload and leave native kernel-sandboxed fixtures inside their existing boundary without that preload.
    category: prover
    why: Product launchers need their IPC and lifecycle behavior tested without detached descendants escaping the suite; kernel attack fixtures remain synchronous, bounded, and do not launch detached children.
  - text: Await bounded concurrent fixture completion, then confirm watcher shutdown, before removing settlement fixture directories.
    category: design
    why: Cleanup was registered before the concurrent child hooks. Directory removal could run while a child was still writing; an unconfirmed child completion must leave the directory intact.
questions: []
challenges:
  - premise: Descendant cleanup requires suspending producers and reconstructing their ownership tree.
    verdict: wrong
    evidence: File and suite deadlines, outer SIGTERM and SIGKILL, and a spawn frozen before its ownership lookup all leave no captured survivor using inherited group membership and a live suite leader.
  - premise: Successful fixture-parent exit proves its redirected background child was cleaned up.
    verdict: wrong
    evidence: The leader-first-exit regression requires a nonzero suite result, the named test and surviving command in output, and no surviving child. Disabling the audit produces the expected erroneous zero exit and fails that regression.
---

The new runner has two processes: a coordinator and a suite leader. The leader
runs Node's programmatic test runner, keeps IPC referenced after the tests end,
and stays outside test-file event loops that may block. Every ordinary fixture
inherits its suite group. A test-only preload prevents Node daemon launchers
from detaching, including through fixture environment overrides. The two fixture
scripts that explicitly detached background children now use ordinary inherited
groups; the fake dispatch watcher also has a finite lifetime.

When tests complete, the coordinator audits members of that one group. An
unexpected live member prints its PID, command and selected files and makes the
suite fail. The audit never adopts or signals descendants. Ordinary teardown
then kills the same known suite group on both success and failure, after a fresh
successful identity check of its still-live leader. A failed batch audit changes
the result but does not skip this independent check. Coordinator cancellation
uses the same teardown; coordinator SIGKILL closes IPC, and the responsive
leader tears down its own group. IPC sends handle a disappearing peer without
an unhandled send error terminating the leader before cleanup.

This retains the original finite bounds: tests have 60 seconds, synchronous
commands and fixture children 15 seconds, files five minutes, and suites six
minutes. Lanes retain eight-minute file and nine-minute suite bounds. Smaller
explicit limits remain. File deadlines end the suite group and name the file;
the independent suite timer handles a blocked file. Spawn-time result capture
and teardown remain. A parent that exits while a grandchild holds its output
pipes gets a bounded drain, allowing the suite audit to run.

Removed: the guardian and replacement-reaper roles, producer suspension and
resume concerns, ancestry and group-member adoption, final-ledger ordering,
registration append acknowledgments, registry deletion, ancestor registry
chains, and PID-generation caches. Registrations now only capture a birth tuple
for a direct helper signal. There is no cleanup journal. Keeping one suite
leader alive makes fixture-parent lifetime irrelevant to group teardown.
Nested bounded suites use the same two-process contract and their own IPC death
handler; no registration forwarding is needed.

Neither round-three Major still applies to this design. The first depended on
SIGSTOP abandoning an unresponsive worker after a failed lookup. Nothing is
suspended now. Four injected batch-failure tests prove audits send no signals
and a separate fresh group check still permits teardown. A real subprocess test
injects an audit timeout after a fixture parent exits and leaves a redirected
background child; it requires a failed suite and both the child and suite leader
gone. The second depended on the departed fixture leader losing its descendants.
Those children now retain the live suite leader's group. The leader-first-exit
test requires a named failure and no survivor. A further regression overrides
NODE_OPTIONS at two nested launches that request detachment; the leaf remains
contained, is reported, and disappears during ordinary teardown.

The other cancellation tests retain the previous proof: SIGTERM and SIGKILL of
an outer runner remove all eight known enclosing and nested processes while an
unrelated sentinel stays alive. A frozen-spawn regression blocks before the
child's ownership query and verifies the suite deadline clears that child,
its test file, and the suite leader without registration. Read-only survivor
assertions allow up to two seconds for asynchronous OS reaping. No historical
PID is signalled during those observations.

All nine full-suite runs across the first three concurrent campaigns passed. Early focused
campaigns each had one failure: teardown queried an already completed child's
PID, and an immediate PID probe raced asynchronous reaping after group kill.
Completed children now skip lookup and signalling, with a regression proving
zero late queries; reaping checks now wait within a fixed bound. The final three
focused repetitions all passed. Acceptance initially rejected the host preload
inside its kernel sandboxes; both native sandbox frontends now exclude the test
preload without widening permissions. All 59 acceptance tests subsequently
passed, including the 11 security and verification regressions.

Main advanced with settlement while validation ran. The second rebase retains
that module and its new root test glob. Its fixtures now capture acknowledged
watcher identities before assertions, use guarded shutdown rather than raw
historical PID kills, and use spawn-time completion and cleanup for concurrent
commands. Already departed or changed watcher PIDs are reported and never
signalled. The final load campaign ran alongside lane and acceptance checks;
all completed within unchanged bounds. The subsequent settlement cleanup
campaign added three more full-suite passes and one 74-test focused pass. Across
all twelve parallel full-suite runs, a scoped read-only audit captured 346 suite
group identities and found zero attributable live survivors. It excluded one
historical group whose leader PID now belonged to a different start-time and
command identity; it sent no signals. All tests were offline and made no model
calls.

The supervisor's additional settlement ENOTEMPTY report exposed a concrete
hook-order problem: the fixture's removal hook was registered before the hooks
for concurrent children. It now awaits every concurrent command's bounded
completion, then signals acknowledged watchers with fresh identity checks and
confirms their shutdown, and only then removes the fixture directory. A failed
or unconfirmed child completion leaves the directory intact. The change follows the supervisor's explicit direction to stop fixture children before directory removal; it
only removes disposable fixture directories created by the test. No removal
retry or descendant-hunting mechanism was added.

The regression deliberately returns its test body with a live writer. An earlier
teardown hook releases that writer; it creates a directory and writes its output
before the fixture removal hook may finish. The final hook requires the writer's
completion proof outside the fixture and the fixture directory gone. A disposable
negative control removes only the completion wait: it fails with the named live
child. The recorded-correction recovery scenario is included in the final
concurrent full and focused runs alongside this regression.

The proof relies on fixtures inheriting their suite group. The kernel-confined
fixture commands are explicitly synchronous and do not detach; product daemon
tests exercise their launch and lifecycle logic under test containment. The
operator's identity rule also remains a limit: if fresh leader identification
persistently fails, cleanup reports refusal and fails rather than signalling an
unconfirmed process. The injected batch-failure cases prove recovery when the
independent fresh leader check succeeds.

The pre-existing untracked review is preserved at
`.lane/review-preserved/b4ffdfd-r3.md`. The supervisor's scratch findings were read
in place and were not copied into the repository. The report is checked and
committed before the final lane check, which records the clean report-inclusive
HEAD and validation result in `.lane/gate.json`.
