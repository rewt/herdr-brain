# ENG-134: release gate deadlines scale with load

Read ENG-134 (record show), the RC-3 gate evidence (.git/release/RC-3.log in the canonical checkout; cases 19 and 20 failed
with spawnSync('/usr/bin/sandbox-exec') ETIMEDOUT) and lib/deadline.mjs (ENG-113's load-aware allowances). Inventory
every fixed timeout in acceptance/ and the helpers it uses, convert each to a load-aware allowance or justify keeping
it, and prove cases 19 and 20 pass under simulated load in offline tests. At most one acceptance --skip-live pass.

Failure-path acceptance: a genuinely hung sandbox-exec still fails within a bounded, load-scaled deadline; a
deliberate watchdog test keeps its fixed timer.

How to work (operator, 2026-10-03): right the first time, then verify; minimal and native; worktree = branch, promotion = pull request. Write the acceptance tests first and ship the change with them; run them while developing as you see fit. No baseline, npm test, test:promotion or test:lanes runs in the lane except where this brief says to measure. Never the live harness. Review your own diff before reporting. Commit, write the report, record check it, commit it, run lane check last. Then stop. Keep evidence in the repository.
