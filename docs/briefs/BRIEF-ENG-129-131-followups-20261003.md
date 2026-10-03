# ENG-129 + ENG-131: test slot and one-tab review follow-ups

Read ENG-129 and ENG-131 (record show) and the reviews they cite. ENG-129: promotion validation must not let the outer
test-slot wrapper replay the whole promotion chain after a leaf timeout; an exit 75 from a command that actually ran
must be distinguishable from a slot refusal (lane check, lane promote, README). ENG-131: rename the initial tab to
agent:TOPIC only after the environment is verified; replace the fixed 5 s environment allowance with a readiness
check; a non-POSIX default shell (nushell, fish) falls back to a separate agent tab instead of stopping. Keep
dispatch from ever moving operator focus.

Failure-path acceptance: a leaf timeout retries that leaf at most once and never the chain; a command exiting 75 is
reported as that command's failure; a failed fresh dispatch leaves no tab named agent:TOPIC; a fish default shell
dispatches successfully with two tabs.

How to work (operator, 2026-10-03: right the first time, then verify; minimal and native): write the acceptance tests first, including the failure paths named below, watch them fail, then implement. Ship the change with the tests that prove it; run the tests you write while developing as you see fit. The process requires no other test runs in the lane: do not run a baseline, npm test, test:promotion or test:lanes. Testing before merge happens once, at promotion, like CI on a pull request. Never the live harness. Before reporting, review your own diff against this brief. Commit, write the report, record check it, commit it, run lane check last. Then stop. Keep evidence in the repository (docs/reports/...), not only in /private/tmp.
