---
run: R-104
outcome: done
summary: |
  Fixed the reviewed housekeeping fixture path mismatch by using the same canonical fake executable in the launch arguments and receipt ownership command. Shared test startup helpers now request graceful schedule shutdown and wait for exit before fixture directory removal, with a bounded hard-stop fallback. Added two real-start assertion-failure regressions through an explicit symlinked temporary root, and proved they detect the old mismatch with a disposable negative control. Rebased onto updated main and applied the existing test bounds to its new discovery regressions. Full, focused, concurrent watcher and lane validation passed; the report-inclusive lane check runs last.
headline: Housekeeping fixtures now stop before symlinked temporary directories are removed
blockers: []
proposals: []
learnings:
  - Exact receipt ownership checks must use the path spelling actually passed to the launched process; a canonical expected path cannot match a symlinked launch argument.
  - Killing a housekeeping schedule during a synchronous tick can leave its short-lived fake Herdr command active; graceful shutdown lets the tick finish and removes the lock before directory teardown.
  - A cleanup hook must await process exit before the fixture removal hook, rather than only send a signal.
  - The merged macOS missing-provider-boundary fixture needs a five-second startup deadline under parallel load to observe rejection rather than expire after one second.
artifacts:
  - "Commit: Stop symlinked housekeeping fixtures before directory removal"
  - "Commit: Bound newly merged discovery regressions under parallel load"
  - "Branch: lane/test-hangs"
  - docs/reports/ENG-88-test-hangs-r6-20261002.md
  - housekeeping/test/helpers/cli-fixture.mjs
  - housekeeping/test/housekeeping.test.mjs
  - test/helpers/receipts.mjs
  - discovery/test/alternatives.test.mjs
  - discovery/test/review-r2.test.mjs
  - discovery/test/review-r3.test.mjs
  - discovery/test/review-r4.test.mjs
  - "Baseline npm test: 559 passed, four skips, zero failures; 204.5 seconds"
  - "Focused process, hang-guard, dispatch, housekeeping and alternative-provider tests: 127 passed, three optional skips, zero failures; 52.0 seconds"
  - "Post-change npm test under concurrent lane and watcher load: 604 passed, ten skips, zero failures; 221.0 seconds"
  - "Three concurrent watcher, housekeeping, hang-guard and lifecycle suites: 100 passed each, zero failures or skips; 29.2–29.4 seconds"
  - "Merged discovery regression bounds: 38 passed, three optional skips, zero failures; 37.7 seconds"
  - "Negative control restoring only the reviewed --herdr path mismatch: exactly both real-start assertion-failure regressions fail, 58 other tests pass; 20.3 seconds"
  - "npm run test:lanes: 148 passed, zero failures or skips; 384.1 seconds within its 540-second suite bound"
  - "Read-only audit: four captured suite groups have zero live leaders or surviving members; zero remaining test workers for this lane"
  - /tmp/eng88-r104-baseline.log
  - /tmp/eng88-r104-focused-2.log
  - /tmp/eng88-r104-full.log
  - /tmp/eng88-r104-lanes.log
  - /tmp/eng88-r104-parallel-1.log
  - /tmp/eng88-r104-parallel-2.log
  - /tmp/eng88-r104-parallel-3.log
  - /tmp/eng88-r104-main-bounds-2.log
  - /tmp/eng88-r104-negative-2.log
  - /tmp/eng88-r104-negative/housekeeping/test/helpers/cli-fixture.mjs
  - /tmp/eng88-r104-groups.json
  - /tmp/eng88-r104-survivors.json
  - "Final action: node lanes/lane.mjs check (report-inclusive clean HEAD; gate in .lane/gate.json, output in /tmp/eng88-r104-gate.log)"
decisions:
  - text: Use the canonical fake executable in both housekeeping launch arguments and receipt ownership expectations.
    category: design
    why: Exact command identity is necessary for safe receipt adoption and must remain consistent across symlinked temporary roots.
  - text: Share the actual fixture startup and cleanup helpers with real subprocess failure regressions; request graceful shutdown and await bounded process exit before directory removal.
    category: design
    why: The regression must exercise the production test helper and verify teardown order while its fixture still exists, including outstanding fake Herdr commands.
  - text: Restore only the reviewed path mismatch in a disposable checkout for a negative control.
    category: prover
    why: Both new regressions must fail against the original defect without mutating the working lane or weakening receipt ownership checks.
  - text: Rebase onto updated local main and apply the established test and command bounds to its new discovery tests.
    category: tooling
    why: The lane must remain promotable and its guarantee must include tests introduced by the current base.
questions: []
challenges: []
---

The round-one Moderate in the review of the prior report is addressed. Both
canonical and installed housekeeping runtimes now launch the exact executable
spelling that their receipt ownership check expects. Each regression creates a
real symlink alias, starts a real isolated schedule using fake Herdr and record
commands, then deliberately fails immediately after startup. The cleanup hook
runs before the directory hook. The latter records that the schedule is absent
while the directory still exists; the parent verifies that evidence and that the
directory was subsequently removed. Nested suite audits also require no live
fixture descendants after the injected failure.

The inherited validation log reported no failing tests, but contained repeated
legitimate housekeeping receipt rejections, confirming the reviewed mismatch.
Those rejections are absent from the passing post-change full and focused runs.
The original immediate-kill cleanup exposed an active fake Herdr subprocess in
the first new regression run; graceful shutdown and bounded waiting resolved it.
A focused validation of newly merged discovery tests then exposed a one-second
fixture startup deadline returning timeout instead of its expected boundary
rejection under load; the five-second deadline preserves the rejection assertion
and passes. The suite, file, test and command bounds remain in place.

All checks were offline and used fixture projects only. The initial sandboxed
baseline refused ps with EPERM; approved execution with process inspection
allowed the actual baseline and subsequent validations. Main stayed at the
rebased base during validation. The checked report is copied into this lane and
committed before the final lane check; previous reports are unchanged.
