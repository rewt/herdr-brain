---
run: R-188
outcome: done
summary: |
  Rebased the accepted gate-timeouts lane onto main at eb710c0. Resolved acceptance/run.mjs and acceptance/test/recovery.test.mjs by retaining both the load-aware deadline module and main's private environment module in the scratch copies, with main's scratch TMPDIR assertion intact. No new implementation work was added.
  The two conflict-covering offline test files passed all 21 tests. Their evidence is committed, and the rebased patch series was reviewed with git range-diff. This report is checked and committed before the final lane check; the lane remains unpromoted for the coordinated batch.
headline: The accepted gate deadline lane is rebased with both behaviors preserved
blockers: []
proposals: []
learnings:
  - Scratch acceptance workers require both deadline.mjs and environment.mjs after integrating the private lane environment handoff with load-aware deadlines.
artifacts:
  - "branch: lane/gate-timeouts"
  - "rebase base: eb710c0782e2d86e47d6bdc6977387888528d259"
  - "rebased implementation: b9f8093"
  - "rebased original report: 6730087"
  - "rebased existing review record: 5ca8b90"
  - "focused test evidence commit: 238e2f043227742d71be27110a1da61bd9accb63"
  - "docs/evidence/ENG-134/rebase-conflicts-20261003.log"
  - "node test/helpers/run.mjs acceptance/test/recovery.test.mjs acceptance/test/deadlines.test.mjs"
  - "git range-diff 61be51b..8d7f410 main..5ca8b90"
  - "Final command after report commit: node lanes/lane.mjs check; receipt at .lane/gate.json"
decisions: []
questions: []
challenges: []
---

This run followed the operator's rebase-only instruction. The original ask and
R-188 record brief were read; the accepted lane's implementation and independent
review were retained without addressing new work or repeating the release gate.

Both conflicts were adjacent additions to scratch module copying. The runner and
supervisor recovery fixture now copy the shared deadline module alongside the
existing worker modules, including main's environment module. The recovery test
still checks that supervisor dispatch keeps TMPDIR inside scratch; its command
timeout remains load-aware. The remaining commits replayed without conflicts.

The focused test run exited zero: 21 passed, zero failed, cancelled or skipped.
It covers lost-reply recovery and producer drain ordering, supervisor dispatch
cleanup and scratch TMPDIR, cases 19 and 20 at simulated load 24, and genuine
sandbox-exec hangs bounded at both normal and simulated load. The passing TAP log
is retained in the repository. git diff --check passed, and git range-diff showed
only the expected conflict context changes; the original report and review
patches replayed unchanged. The existing review is historical evidence, not a
fresh review of the rebased commit.

No live harness, skip-live pass, promotion, push, baseline or full suite was run.
The final lane check uses the configured fast tier after this report is checked
and committed, so its receipt binds to the final committed tree.
