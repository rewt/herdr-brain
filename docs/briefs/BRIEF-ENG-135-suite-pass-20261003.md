# ENG-135: test suite second pass

Read ENG-135 (record show). The operator's bar: the suite proves the product works without creating work or load of its
own. Today most fix rounds were about the test machinery (ENG-103, ENG-112, ENG-113, ENG-117, ENG-118, ENG-120: teardown
flakes, PTY leaks, fixed timeouts, an orphaned fixture spinning a core for an hour). Measure first: run each tier once on
this machine holding the host test slot (test-slot/), with per-file wall time, processes spawned and real
Herdr/PTY/Git fixtures; collect flaky tests from today's records and logs. For every test file, name the behaviour it
protects. Then make only justified changes: remove duplicates and tests protecting nothing current; replace sleeps and
polling with event waits; share expensive fixtures; keep real-process fixtures only where crossing a real boundary is
the point; place each file in its tier (fast: seconds; promotion: the batch; release: the gate); make remaining
deadlines load-aware. Do not weaken a safety check to make a test pass. ENG-134 fixes the acceptance gate's timeouts in
parallel; leave acceptance/ to it.

Report before and after in docs/reports: wall time per tier, processes spawned, every removed or re-tiered test with its
reason, flakes found and fixed. You may run the full tiers to measure (that is this item's point), holding the test
slot so nothing else is disturbed.

How to work (operator, 2026-10-03): right the first time, then verify; minimal and native; worktree = branch, promotion = pull request. Write the acceptance tests first and ship the change with them; run them while developing as you see fit. No baseline, npm test, test:promotion or test:lanes runs in the lane except where this brief says to measure. Never the live harness. Review your own diff before reporting. Commit, write the report, record check it, commit it, run lane check last. Then stop. Keep evidence in the repository.
