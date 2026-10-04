# ENG-126: review escalation ladder by default

Read ENG-126 (record show) and bch-cloak's routes for the pattern (/Users/rewt/development/bastian/.lane.json and
kit/bch-cloak-20261001/lane/routing.json in this repo; read only). Reviews 1 and 2 use the project's review route;
if a finding is still open after two rounds, the next review uses an escalation route on a frontier model and its
fix uses engineer-max; never escalate a first review; after the escalated round, remaining Moderate/Minor findings
go to supervisor judgment (the settle review round cap, default 2 in this project). The portable route preset gains
review-escalate and engineer-max entries so every project has the ladder without configuration. Build on the train
lane's settle changes (ENG-124/125) if they have landed; rebase onto main first.

Failure-path acceptance: a first or second review never uses the escalation route; a project without an escalation
route falls back to its review route with a visible note; Major findings and red validation still always get a fix.

How to work (operator, 2026-10-03): right the first time, then verify; minimal and native; worktree = branch, promotion = pull request. Write the acceptance tests first, including the failure paths named below, and ship the change with them; run them while developing as you see fit. The process requires no other test runs in the lane: no baseline, no npm test, test:promotion or test:lanes; the promotion batch runs the full suites once. Never the live harness. Review your own diff against this brief before reporting. Commit, write the report, record check it, commit it, run lane check last. Then stop. Keep evidence in the repository, not only in /private/tmp.
