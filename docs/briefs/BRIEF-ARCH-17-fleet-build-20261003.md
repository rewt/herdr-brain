# ARCH-17: build the fleet (minimal)

Read ARCH-17 (title and notes), the operator's answers HUM-24..HUM-27, and docs/design/ARCH-17-workspace-20261003.md.
Names: the machine-level boundary is the fleet; "workspace" stays Herdr's word. Build only: ~/.herdr-monitor/fleet.json
(HERDR_MONITOR_FLEET overrides the home for tests) listing joined projects and where each one's record, worktrees and
temp live; created by the first entry if missing and written only by entry/join (agents run an idempotent
"monitor fleet join" when they bypass entry; no human edits); a project joins when an agent first enters it, mapping an
existing record in place (herdr-brain: rewt/.org; bch-cloak: bastian/.org); with a fleet file present, record and
parent-settings discovery stop at the project's edge (no ancestor .org or parent .lane.json belonging to another
project); one adjustable session limit in the fleet file, default 6, surfaced as advisory like other budgets. Do not
build leases, a fleet record, a fleet supervisor or sandbox grants. Without a fleet file, behaviour is unchanged
(bch-cloak and older installs unaffected). Never write bch-cloak's checkout or record.

Failure-path acceptance: a repository with no record next to herdr-brain gets its own record, not herdr-brain's;
two concurrent first entries produce one consistent fleet file; join run twice is a no-op; a moved checkout is shown
stale, not guessed; a malformed fleet file fails clearly without touching records.

How to work (operator, 2026-10-03: right the first time, then verify; minimal and native): write the acceptance tests first, including the failure paths named below, watch them fail, then implement. Ship the change with the tests that prove it; run the tests you write while developing as you see fit. The process requires no other test runs in the lane: do not run a baseline, npm test, test:promotion or test:lanes. Testing before merge happens once, at promotion, like CI on a pull request. Never the live harness. Before reporting, review your own diff against this brief. Commit, write the report, record check it, commit it, run lane check last. Then stop. Keep evidence in the repository (docs/reports/...), not only in /private/tmp.
