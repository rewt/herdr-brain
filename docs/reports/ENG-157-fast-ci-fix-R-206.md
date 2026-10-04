---
run: R-206
outcome: done
summary: |
  Restored 32 fast logic cases from 12 deferred integration files to promotion CI
  and audited all 43 whole-file deferrals. The expanded logic command passed all
  62 selected tests in 6.011 seconds, with release coverage unchanged. Updated
  the moved inventory and committed the correction; full promotion timing remains
  the historical R-199 evidence pending the next batch's normal validation.
headline: Fast logic stays in CI while expensive coverage remains in release
blockers: []
proposals: []
learnings:
  - "Whole-file tier audits must inspect shared fixture setup and actorTest/caseTest wrappers as well as literal test definitions."
  - "Cheap elapsed durations alone do not imply pure logic: PTY argument and validation profile cases still launch real shell or Git fixture processes."
artifacts:
  - "Implementation commit a73789d"
  - "package.json: test:promotion:logic"
  - "docs/validation-tiers.md"
  - "docs/reports/ENG-157-fast-ci-evidence-20261004/logic-audit-R-206.md"
  - "docs/reports/ENG-157-fast-ci-evidence-20261004/focused-logic-R-206.log.gz"
  - "docs/reports/ENG-157-fast-ci-evidence-20261004/moved-files.json"
  - "docs/reports/ENG-157-fast-ci-evidence-20261004/moved-tests.md"
  - "npm run test:promotion:logic"
  - "ORG_ACTOR=R-206 node lanes/lane.mjs check"
decisions: []
questions: []
challenges: []
---

Resolved the independent review's moderate finding in
`docs/reviews/fast-ci/ec4908b-r1.md`. Read the inherited validation log; it shows
148 passing tests and no additional failing checks to correct.

The existing logic selector now includes both console argument/configuration
cases, both injected-load cutover aggregation cases, six cleanup ownership and
journal cases, seven rollback/retirement cases, the focus refusal case, two
lost-reply/foreign-path recovery cases, three bundled owner/lifetime composition
cases, one retained discovery evidence case, both seccomp ABI evaluations and
the redirected lifetime-marker case, both injected watcher PID reuse cases,
two tidy topology/review freshness cases, and the compact watcher notice case.
These 32 cases launch no real subprocess and wait for no elapsed deadline.

The source audit covered all 43 previously wholly deferred files, including
shared setup and matrix tests. Thirty-one remain wholly release-only; twelve
now retain their fast cases in promotion. Static checks confirmed that every
one of the 43 files remains covered by the unchanged complete release globs.
Release preparation still executes `npm run test:release` before acceptance.
No test assertion, core module, runner, framework or lifecycle guard changed.
The corrected moved inventory excludes restored cases and adds the previously
missing actorTest/caseTest definitions for discovery owner and review files.

Focused validation: `npm run test:promotion:logic` exited 0 with 62 passes,
304 intentional name-filter skips, no failures/cancellations, and TAP duration
6011.237084 ms. The log and complete restored runtime titles are committed.
`git diff --check` passed. An initial host-slot attempt exited 75 because an
existing promotion held the slot; the focused check then ran directly under
the lane development policy. No lock was changed or removed.

The historical R-199 full-promotion measurements remain 991.282 seconds before
and 179.497 seconds after. This correction round ran no baseline, complete
promotion chain, full release suite or live acceptance harness. Its focused
logic duration is not a new full CI timing claim. The next promotion batch
validates the corrected complete command before main advances. The historical
ENG-135 report named in the original ask is still absent from main; the recorded
R-199 supervisor correction explicitly authorized proceeding without that lane.

After checking and committing this report, the final operation is
`ORG_ACTOR=R-206 node lanes/lane.mjs check`; its result is recorded in the lane's
validation receipt. The previous R-199 report and measurement logs are intact.
