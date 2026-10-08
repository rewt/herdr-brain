---
run: R-310
outcome: done
summary: |
  The affected-test planner now emits selected, deferred and budget only when the caller supplies the fourth required-files argument. Legacy three-argument calls emit only covered, bounded files and graph, so the validator already on main accepts the candidate planner without changing the reviewed selection behavior.
  Added the legacy field-set regression, observed it fail before the fix and pass afterward, and verified the corrected planner through main's actual validator. All 42 tests in the three requested offline suites passed against implementation commit 2f7df37, with the runner's cleanup audit completing successfully on the rerun.
headline: The bounded planner now works with the existing merge queue
blockers: []
proposals: []
learnings:
  - A candidate planner must keep its legacy output compatible with the canonical main validator because the merge queue uses that validator before candidate code lands.
artifacts:
  - 'Implementation commit: 2f7df37'
  - 'Branch: lane/bounded-gate'
  - test/helpers/affected-tests.mjs
  - promote/test/affected-tests.test.mjs
  - docs/evidence/ENG-267/fix1-compatibility.log
  - docs/evidence/ENG-267/fix1-focused.log
  - docs/evidence/ENG-267/fix1-sandbox-audit.log
  - docs/reports/ENG-267-planner-compatibility-R-310.md
  - /Users/rewt/development/rewt/.org/runs/R-310/report.md
  - '.lane/gate.json (final lane fast-check receipt)'
decisions:
  - text: Use the presence of the fourth required-files argument to opt into the detailed planner receipt.
    category: tooling
    why: The existing main validator accepts only files, covered and graph, while this lane's promotion planner always supplies the new argument; both callers retain the same bounded selection.
questions: []
challenges: []
---

The correction changes only the planner's output shape and adds one regression.
The same key-set assertion passed against main's unmodified three-argument CLI.
In this lane it failed with the unexpected budget, deferred and selected fields
before the fix and passed afterward.

Planning through main's actual `promote/test-plan.mjs` validator also passed.
For `lib/deadline.mjs`, both call formats produced identical files, coverage and
graph: one hop, ten selected files, 21 deferred files, and 26210 estimated
milliseconds. The four-argument format retained its detailed receipt.

Focused validation after the implementation commit:

```sh
node test/helpers/run.mjs promote/test/affected-tests.test.mjs promote/test/train.test.mjs settle/test/test-plan.test.mjs
```

The audited run passed 42/42 with no failures, cancellations or skips in
114.7 seconds. This includes canonical planner snapshots loaded from the
committed implementation. The first sandboxed run also passed all 42 tests,
but the runner exited with an error because the sandbox denied the final
process-inventory cleanup audit. The same command was rerun with process
inspection available and exited zero; both logs are retained.

No baseline, full promotion or release tier ran. The report is checked and
committed with its evidence before the final `node lanes/lane.mjs check`
(default fast tier), whose receipt is `.lane/gate.json`.
