---
run: R-315
outcome: done
summary: |
  Rebased lane/main-check onto current local main, including the train planner and keep-reason changes, without conflicts. All five prior patches compare equal after rebase, preserving the reviewed entry-point correction.
  The requested main-module and release-candidate tests pass: 42 tests, zero failures or skips. The supervisor's ENG-260 decision resolves R-305's deferred-host-check blocker by existing evidence; no host comparisons were run.
  Rebased head is 0fd4762f7994b2747dc564f29a9ab47f2af77d40; validation evidence is committed as 43d0fc7c579f9908899a6849e57195d62c0d9d3b. This report is checked and committed next, followed by the final focused lane check.
headline: The reviewed entry-point correction is rebased and ready to land
blockers: []
proposals: []
learnings: []
artifacts:
  - "Branch: lane/main-check"
  - "Main rebase base: 071070fb1aaf8b0a4d5dd15cea8d89428b9d180c"
  - "R-305 correction commit before rebase: 97383682f86e0bb43af6f9d4dd70662dde1d9795"
  - "R-305 report commit before rebase: 44c7505b"
  - "R-305 correction commit after rebase: 9e79ebdcc54ccf0edc25dcebe0078181839c1e72"
  - "Rebased head: 0fd4762f7994b2747dc564f29a9ab47f2af77d40"
  - "Focused validation evidence commit: 43d0fc7c579f9908899a6849e57195d62c0d9d3b"
  - "docs/evidence/ENG-260/R-315/commands.txt"
  - "docs/evidence/ENG-260/R-315/focused.tap"
  - "docs/evidence/ENG-260/R-305/script-outcomes.json"
  - "docs/evidence/ENG-260/R-305/native-env.json"
  - "docs/reports/ENG-260-main-module-R-305.md"
  - "docs/reports/ENG-260-main-module-R-315.md"
  - "/Users/rewt/development/rewt/.org/runs/R-315/report.md"
decisions: []
questions: []
challenges: []
---

The supervisor's decision on ENG-260, dated 2026-10-07 20:14, settled the
R-305 correction by direct review and resolved its blocker without the deferred
main/head comparisons. Native validation at R-305's head passes with the native
Codex executable on PATH, making ENG-264 environmental. The one offline
acceptance failure is installed discovery encountering the real promotion
batch's held slot, the fixture-isolation issue tracked by ENG-265. The handoff
explicitly directs this run to report done based on that decision and only
repeat focused tests after rebase.

R-305's correction at 97383682f86e0bb43af6f9d4dd70662dde1d9795 preserves the
self-contained realpath check in the candidate driver and strengthens the
source guard for both operand orders, inequality early returns, module-path
aliases and duplicate checks. Its completed evidence records 992 passes,
one installed-discovery slot failure and seven skips across 1000 tests, plus
the successful native-validation case. Those are prior-run results, not new
tests from this run. Its report was committed at 44c7505b.

`git rebase main` replayed all five commits onto
071070fb1aaf8b0a4d5dd15cea8d89428b9d180c without conflicts. `git range-diff`
marks all five patches equal. No product or test file changed during this
round. The correction is now 9e79ebdcc54ccf0edc25dcebe0078181839c1e72 and
the rebased R-305 report/head is 0fd4762f7994b2747dc564f29a9ab47f2af77d40.

Focused validation:

```sh
env -u ORG_DIR -u HERDR_AGENT_NAME \
  TMPDIR=/private/tmp/eng260-r315 TMP=/private/tmp/eng260-r315 TEMP=/private/tmp/eng260-r315 \
  node test/helpers/run.mjs test/main-module.test.mjs release/test/candidate.test.mjs
```

Exit 0: 42 tests passed, zero failures, zero skips. No conflict-resolution
files required additional tests. Exact commands and TAP are committed in
`docs/evidence/ENG-260/R-315/`.

After committing this checked report, the last command is the same focused
validation through `node lanes/lane.mjs check --cmd 'node test/helpers/run.mjs
test/main-module.test.mjs release/test/candidate.test.mjs'`. Its GATE receipt
records the final report commit and result; no final-gate pass is claimed in
advance. No host slot, deferred comparison, aggregate tier, live acceptance,
promotion or push is part of this round.
