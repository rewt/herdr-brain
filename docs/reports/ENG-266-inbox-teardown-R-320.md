---
run: R-320
outcome: done
summary: |
  Corrected the review Minor in the persistent missing and partial receipt regressions by mocking os.loadavg and os.availableParallelism before both deadline samples. Their mocked clock now reaches the helper deadline independently of host load changes. The two-line test-only fix is committed as 4ae9efe on lane/inbox-teardown. All 23 inbox tests passed offline, and git diff --check passed. This report precedes its record check, separate report commit and final focused lane check.
headline: Persistent inbox handoff regressions now complete independently of host load.
blockers: []
proposals: []
learnings: []
artifacts:
  - "Implementation commit: 4ae9efe"
  - "Branch: lane/inbox-teardown"
  - test/inbox.test.mjs
  - /private/tmp/R-320-inbox.tap
  - docs/reports/ENG-266-inbox-teardown-R-320.md
  - /Users/rewt/development/rewt/.org/runs/R-320/report.md
  - "Final committed-head evidence: .lane/gate.json and its referenced validation log"
decisions: []
questions: []
challenges: []
---

Both persistent-receipt cases now mock the one-minute load average to 24 and
available parallelism to 4, using the same fixed values as the existing
load-scaling regression. The test and helper each obtain a deterministic
6000-millisecond handoff allowance, so the mocked clock reaches the deadline
on the first metadata read. Existing assertions still prove failure without
process lookup or signalling and preservation of the unidentified lock.

Validation:

- `node test/helpers/run.mjs test/inbox.test.mjs`: 23 passed, zero failed,
  cancelled or skipped, exit 0. Evidence: `/private/tmp/R-320-inbox.tap`.
- `git diff --check`: passed.

Only the requested test correction was made. No baseline, full suite,
promotion tier, release tier or live acceptance harness ran.

After checking this report and committing its repository copy, the final
action is:

```sh
node lanes/lane.mjs check --cmd 'node test/helpers/run.mjs test/inbox.test.mjs'
```

The resulting `.lane/gate.json` receipt names the final report-inclusive
commit and validation log. This report does not predeclare its result.
