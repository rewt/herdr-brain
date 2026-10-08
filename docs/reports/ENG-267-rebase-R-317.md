---
run: R-317
outcome: done
summary: |
  Rebased lane/bounded-gate onto local main and resolved the sole conflict in promote/train.mjs. Main's canonicalTestPlan call retains its captured-base trust boundary and receives the lane's sorted union of required test evidence; the existing settle wrapper already forwards that evidence.
  The reviewed bounded selection and R-310 three-argument compatibility remain unchanged. All 44 tests in the three requested offline suites passed against the committed rebased tree, including the cleanup audit, and rebase evidence is committed in 2605be1. The checked report is committed before the final default fast lane check.
headline: The bounded merge gate is rebased and its focused checks pass
blockers: []
proposals: []
learnings: []
artifacts:
  - 'Branch: lane/bounded-gate'
  - 'Main base: 071070fb1aaf8b0a4d5dd15cea8d89428b9d180c'
  - 'Rebased implementation: c8032fde'
  - 'Rebased compatibility fix: dabb681d'
  - 'Rebased reviewed tip: 41f70f818e952b8c66f25ae657bf7b581d360178'
  - 'Rebase evidence commit: 2605be1'
  - docs/evidence/ENG-267/rebase-R-317.md
  - docs/evidence/ENG-267/rebase-R-317-audit.log
  - docs/evidence/ENG-267/rebase-R-317-focused.log
  - docs/reports/ENG-267-rebase-R-317.md
  - /Users/rewt/development/rewt/.org/runs/R-317/report.md
  - '.lane/gate.json (final default fast-check receipt)'
decisions: []
questions: []
challenges: []
---

The six lane commits were replayed onto main. The resolution keeps main's
canonical planner import, captured base, candidate-tree inspection and comment,
and adds the sorted, deduplicated `requiredTests` union to the planner options.
`settle/test-plan.mjs` already passes those options into `promotionTestPlan`;
no additional wrapper change was needed.

The audit confirms the bounded planner, duration inventory, promotion validator,
settle evidence forwarding and affected/canonical planner tests are byte-for-byte
unchanged from the previously reviewed lane. The compatibility commit's patch
is unchanged in the range comparison. Main's two train regressions against
candidate-forged canonical coverage are also preserved.

Validation against the committed rebased implementation:

```sh
node test/helpers/run.mjs promote/test/train.test.mjs promote/test/affected-tests.test.mjs settle/test/test-plan.test.mjs
```

44 tests passed in 150.4 seconds with zero failures, cancellations or skips;
the runner exited zero after its owned process-group cleanup audit. Coverage
includes canonical planner trust, required-test union and cap exceptions,
bounded core-module selection, exact leaf selection and legacy output fields.
No tests were edited for the rebase round. No baseline, full promotion/release
tier, lane suite or acceptance harness ran. No promotion or push was attempted.

The external report is checked with `record check`, and this identical tracked
copy is committed before `node lanes/lane.mjs check` runs last. The final gate
receipt records the report commit's exact HEAD and tree in `.lane/gate.json`.
