# ENG-127: durable notes in the archive, scratch swept at lane close

Read ENG-127 (record show) and bch-cloak's rule (AGENTS.md near 'Session scratch belongs under', read only). Each
project has an archive directory for durable notes, measurements and evidence (default archive/, overridable in
project config; herdr-brain maps docs/reports and docs/archive). A run's scratch is its per-run temp (ARCH-18); lane
close sweeps it and records a manifest of what it removed. Before promotion, flag a report whose artifacts cite
evidence that lives only in scratch or /private/tmp. Keep lane lifecycle safety intact.

Failure-path acceptance: lane close never sweeps a directory another live process holds open; an unmerged lane's
scratch is kept with its archive tag; a flagged report names the paths.

How to work (operator, 2026-10-03): right the first time, then verify; minimal and native; worktree = branch, promotion = pull request. Write the acceptance tests first, including the failure paths named below, and ship the change with them; run them while developing as you see fit. The process requires no other test runs in the lane: no baseline, no npm test, test:promotion or test:lanes; the promotion batch runs the full suites once. Never the live harness. Review your own diff against this brief before reporting. Commit, write the report, record check it, commit it, run lane check last. Then stop. Keep evidence in the repository, not only in /private/tmp.
