# ENG-122: process checks without setuid ps

Read ENG-122 and ARCH-18 finding 2 (docs/design/ARCH-18-sandbox-20261003.md). /bin/ps is setuid root and cannot run
inside any seatbelt sandbox, so test/helpers/processes.mjs refusing to start without ps means npm test cannot run in
an OS sandbox. Replace it with a non-setuid source (pgrep plus sysctl on macOS, /proc on Linux, or the native owner
from ENG-105) with the same pid plus start-time identity guarantees. Keep the host test slot (test-slot/) and every
caller working.

Failure-path acceptance: npm test runs under a seatbelt profile that forbids setuid exec; a reused pid with a
different start time is never treated as the same process; when no source is available the runner refuses clearly.

How to work (operator, 2026-10-03: right the first time, then verify; minimal and native): write the acceptance tests first, including the failure paths named below, watch them fail, then implement. Ship the change with the tests that prove it; run the tests you write while developing as you see fit. The process requires no other test runs in the lane: do not run a baseline, npm test, test:promotion or test:lanes. Testing before merge happens once, at promotion, like CI on a pull request. Never the live harness. Before reporting, review your own diff against this brief. Commit, write the report, record check it, commit it, run lane check last. Then stop. Keep evidence in the repository (docs/reports/...), not only in /private/tmp.
