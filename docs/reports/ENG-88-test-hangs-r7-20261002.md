---
run: R-106
outcome: done
summary: |
  Restored real detachment in the three discovery native-owner regressions through a separately bounded fixture. Every detached Node process receives a six-second native alarm before exec, and each regression asserts actual process groups as well as cleanup and late writes. Added assertion-failure, blocked-event-loop, suite cancellation, and pre-receipt cancellation coverage. Both negative controls failed exactly the affected three regressions. Rebased onto current main and bounded its new plugin installation tests. Full, lane, acceptance, and three concurrent watcher suites passed with no surviving fixtures; the report-inclusive lane check runs last.
headline: Detached cleanup tests now exercise real process groups and remain bounded
blockers: []
proposals: []
learnings:
  - The test containment preload propagates through a native owner into its Node descendants; requesting detached processes does not prove the test exercised detachment.
  - A native alarm survives exec into Node and terminates even a blocked event loop after the suite is killed; cleanup does not need to adopt or signal receipt PIDs.
  - macOS prevents applying the nested sandbox used by an outer native lifetime and executing ps inside the product sandbox. Capture getpgrp in the native exec launcher instead.
  - Cleanup must observe live producers as well as descendants; reading receipts once misses cancellation before publication and descendants launched by an exiting middle process.
artifacts:
  - "Commit: Preserve detached regression coverage with native fixture deadlines"
  - "Commit: Bound plugin installation tests merged from main"
  - "Commit: Document the bounded real-detachment fixture exception"
  - "Commit: Report restored detachment and bounded cleanup evidence"
  - "Branch: lane/test-hangs"
  - docs/reports/ENG-88-test-hangs-r7-20261002.md
  - docs/reports/evidence/ENG-88-test-hangs-r7-validation-20261002.json
  - discovery/test/review-r3.test.mjs
  - discovery/test/helpers/detached-descendants.mjs
  - test/helpers/detached-fixture.mjs
  - test/helpers/detached.mjs
  - test/helpers/fixture-deadline.c
  - test/helpers/fixture-policy.mjs
  - test/test-hangs.test.mjs
  - test/plugin-install.test.mjs
  - "Baseline npm test: 604 passed, ten skips, zero failures; 173.9 seconds"
  - "Final focused regressions: 33 passed, one Linux-only skip, zero failures; 42.4 seconds"
  - "Preload negative control: exactly the three native-owner regressions fail on actual group-leader assertions; ten other passes, one skip; 14.2 seconds"
  - "Cleanup negative control: exactly the three native-owner regressions fail on late-write assertions when cleanup overlooks other groups; ten other passes, one skip; 14.3 seconds"
  - "Post-rebase npm test under concurrent load: 648 passed, ten skips, zero failures; 236.4 seconds"
  - "Three concurrent watcher, housekeeping, lifecycle, native-owner and hang-guard suites: 118 passed and one Linux-only skip each, zero failures; 58.2, 61.4 and 60.8 seconds"
  - "npm run test:acceptance: 59 passed, zero failures or skips; 38.2 seconds"
  - "npm run test:lanes: 148 passed, zero failures or skips; 383.3 seconds within its 540-second suite bound"
  - "Read-only process audit: seven captured suite groups have zero live members; zero lane test workers or detached fixtures remain"
  - /tmp/R-106-baseline.log
  - /tmp/R-106-targeted-final.log
  - /tmp/R-106-negative.log
  - /tmp/R-106-cleanup-negative.log
  - /tmp/R-106-full.log
  - /tmp/R-106-lanes.log
  - /tmp/R-106-acceptance.log
  - /tmp/R-106-parallel-1.log
  - /tmp/R-106-parallel-2.log
  - /tmp/R-106-parallel-3.log
  - /tmp/R-106-suite-groups.json
  - /tmp/R-106-survivors.json
  - "Final action: node lanes/lane.mjs check on the report-inclusive clean commit; gate in .lane/gate.json and output in /tmp/R-106-gate.log"
decisions:
  - text: Exempt only the fixed detached fixture entrypoint from the test preload and keep its launcher in the suite group.
    category: design
    why: The discovery cleanup regressions need actual new process groups, while ordinary fixtures retain the existing suite containment.
  - text: Exec every detached fixture process through a native six-second alarm and wait for its bounded lifetime before directory removal.
    category: design
    why: The deadline survives blocked JavaScript and suite cancellation without descendant signalling, ownership adoption or a nested macOS sandbox.
  - text: Assert native group identities and run two temporary negative controls, restoring the sources before validation and commits.
    category: prover
    why: The regressions must detect both lost detachment and cleanup that misses descendants outside the original group; the fallback deadline must not mask either defect.
  - text: Rebase onto current local main and apply the established test and synchronous-command bounds to its new plugin installation tests.
    category: tooling
    why: The lane must remain promotable and include newly merged tests in its execution bounds.
questions: []
challenges: []
---

The reviewed Moderate is addressed. Both generations of each double fork
record the native process group captured immediately before exec into Node.
Their groups equal their own PIDs and differ from their parents' groups. The
wrapper-death regression makes the same assertions for its detached leaf.
Completion, deadline, wrapper-death, late-write and unrelated-process survival
assertions remain in place. Restoring the containment preload breaks all three
group assertions. Restricting native cleanup to its original process group
breaks all three late-write assertions. These mutations were removed before the
passing validation runs, and the product native owner is unchanged.

The isolated fixture launcher uses the normal child timeout and cleanup helper.
Each detached descendant also has a kernel alarm, independent of the test
runner, and directory teardown waits for live producers and descendants to
disappear. This observation is report-only and does not adopt or signal any
receipt PID. Cancellation tests include SIGTERM, SIGKILL with a blocked detached
Node leaf, and SIGKILL before any leaf receipt is published. An injected assertion
failure and a blocked fixture fail with their names and leave no survivors.
After cancellation, detached processes may remain until their six-second alarm;
the regression and fixture cleanup wait for their exit before completing.

The inherited validation log had no failures. The initial restricted baseline
invocation could not inspect processes with ps; approved offline execution
supplied the actual baseline and validations above. All checks used temporary
fixture projects on macOS and made no model calls. Linux-only io_uring execution
was skipped; this report does not claim an independent Linux run. Main remained
unchanged after the clean rebase. Previous reports were not modified. The new
report is checked and committed before the final lane check.
