---
run: R-102
outcome: done
summary: |
  Fixed the review finding in dispatch and housekeeping receipt cleanup. Candidate PIDs must match the exact fixture command and a freshly verified live suite group before adoption; retries retain the first owned birth tuple. Added reuse-before-registration regressions through both receipt readers, including fake and real watcher receipts, and verified them with a negative control. Baseline and post-change full suites and three concurrent watcher/cleanup suites passed. Lane validation also passed, and a read-only audit found no survivors in the captured suite groups. The report-inclusive lane check runs last.
headline: Receipt cleanup now verifies fixture ownership before adopting a process
blockers: []
proposals: []
learnings:
  - A successful process lookup of a receipt PID does not prove fixture ownership when the PID was reused before registration.
  - The bounded runner keeps a live suite group leader; receipt adoption can verify that leader and require both its group and the fixture's exact command.
  - Retrying a start must retain the original owned birth tuple rather than adopt a replacement under the same PID.
artifacts:
  - "Commit: Verify suite ownership before adopting fixture receipt PIDs"
  - "Branch: lane/test-hangs"
  - docs/reports/ENG-88-test-hangs-r5-20261002.md
  - test/helpers/receipts.mjs
  - test/helpers/processes.mjs
  - dispatch/test/dispatch.test.mjs
  - housekeeping/test/housekeeping.test.mjs
  - "Baseline npm test: 550 passed, four existing skips, zero failures; 183.9 seconds"
  - "Focused receipt/process/dispatch/housekeeping validation: 99 passed, zero failures; 31.1 seconds"
  - "Post-change npm test under concurrent lane and watcher load: 559 passed, four existing skips, zero failures; 190.4 seconds"
  - "Three concurrent process/cleanup/watch/discovery lifecycle suites: 64 passed each, zero failures or skips; 25.0–26.1 seconds"
  - "Negative control with only receipt adoption verification removed: all three actual receipt-reader regressions fail on an attempted signal to replacement PID 101"
  - "npm run test:lanes: 148 passed, zero failures or skips; 369.8 seconds within its 540-second suite bound"
  - "Read-only process audit: two captured suite groups absent, no replaced leaders and zero live surviving members"
  - /tmp/eng88-r102-survivors.json
  - /tmp/eng88-r102-focused-2.log
  - /tmp/eng88-r102-full.log
  - /tmp/eng88-r102-lanes.log
  - /tmp/eng88-r102-parallel-1.log
  - /tmp/eng88-r102-parallel-2.log
  - /tmp/eng88-r102-parallel-3.log
  - /tmp/eng88-r102-negative.log
  - /tmp/eng88-r102-negative/reuse.test.mjs
  - "Final action: node lanes/lane.mjs check (report-inclusive clean HEAD; result in .lane/gate.json)"
decisions:
  - text: Require verified suite-group membership and the exact fixture command before adopting receipt PIDs, and retain accepted birth tuples across retries.
    category: design
    why: This closes reuse before registration without adding descendant hunting or a process journal to the live-group design.
  - text: Complete the isolated housekeeping schedule's teardown before the fixture directory hook on failure as well as success.
    category: design
    why: Cleanup must be installed before startup assertions and run while its fixture still exists.
  - text: Exercise both actual receipt readers with injected replacement identities, and temporarily bypass only the adoption guard in disposable negative-control copies.
    category: prover
    why: Deterministic PID reuse verifies both rejection conditions and retained retry ownership without depending on the host PID allocator.
questions: []
challenges: []
---

The independent review's Major is addressed in both helpers. Dispatch reads
its fake watcher PID receipts and real watcher journals through the same
verified adoption path. The fake command carries its unique fixture root;
real watcher and housekeeping commands include the full fixture-specific
argument list. The runner supplies its persistent leader PID to test workers.
A fresh successful leader lookup must match its captured start time, command,
and group leadership; a candidate must belong to that group and match the
expected command. Absent or unrelated candidates are skipped. Lookup failure
refuses adoption. Accepted identities remain cached across retries, and each
signal still requires the existing fresh start-time and command check.

Three receipt-reader regressions cover the fake watcher receipt, real watcher
journal, and housekeeping lock. Each supplies a replacement before the first
registration: the expected command outside the suite and an unrelated command
inside the suite. Neither can be signalled. Each then adopts a legitimate
fixture, replaces it with a new birth tuple under the same command and group,
and retries; cleanup retains the original tuple and refuses the replacement.
A matching owned tuple is the positive control. Six further tests cover absent
or zombie candidates and failed, incomplete, replaced, or nonleader suite
identities. Removing only adoption verification from isolated helper copies
makes all three receipt-reader regressions fail on the first simulated
replacement signal.

The R-94 validation log contains no failed tests or outstanding validation
finding. Its existing containment, deliberate leak, timeout, cancellation, and
child-before-directory regressions remain in the validated suites. The first
focused rerun exposed obsolete third-argument arrays in older process tests;
those unused legacy arguments were removed before the passing runs above.
All execution remained offline and made no model calls. The concurrent suites'
report-only audits found no surviving fixtures. Main remained at the current
lane base during validation. The checked report is committed in the lane before
the final lane check; its gate is kept in the existing untracked gate file.
