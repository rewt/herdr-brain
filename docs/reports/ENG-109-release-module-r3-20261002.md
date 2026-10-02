---
run: R-136
outcome: done
summary: |
  Corrected the independent-review finding by requiring a normalized yes or no inside the answer transaction for operator-reserved release questions, including overruling. Other text is rejected without writing events or hiding the pending question. Two bounded scratch regressions cover both decisions, preserve explanations, and carry a subsequent real lane promotion through its own candidate, gate and operator question. The baseline npm suite, 34 focused release/approval tests and two full lane checks passed. Rebased onto main's validation-tier and supervisor-notice updates, retaining its named test commands plus complete candidate coverage and copied-entry isolation. All 160 lane tests passed on the validation-tier rebase; all 81 offline acceptance tests passed on both updated trees. Final lane validation explicitly runs npm test after this report is checked and committed.
headline: Release questions now stay open until the operator gives a yes or no answer
blockers: []
proposals: []
learnings:
  - "record answer normalizes an initial yes/no word, case and punctuation, retaining following text as the note; reserved release questions must reject any other normalized answer before producing events."
  - "The same reply validation applies to --overrule, so rejected text cannot reopen an answered release question or erase its derived candidate decision."
  - "The updated lane check defaults to the fast tier. Use --cmd 'npm test' for the required full worker npm validation; upstream test:core and test:cycle retain their bounds, with copied-entry isolation inside core and candidate tests in cycle."
artifacts:
  - "Commit: Require yes or no for operator release replies"
  - "Commit: Report validated release reply correction for run R-136"
  - "Commit: Preserve accurate test evidence after validation-tier rebase"
  - "Commit: Record final rebase onto supervisor notice delivery"
  - "docs/reports/ENG-109-release-module-r3-20261002.md: committed copy of this report"
  - "npm test baseline: 76 files in three bounded phases; 765 passed, 11 skipped, 0 failed; /private/tmp/R-136-baseline-test.log"
  - "ORG_ACTOR=R-136 node test/helpers/run.mjs release/test/release.test.mjs before the fix: both new regressions failed because ship it exited zero; 16 passed, 2 failed; /private/tmp/R-136-regression-before.log"
  - "ORG_ACTOR=R-136 node test/helpers/run.mjs release/test/*.test.mjs test/approvals.test.mjs after the fix: 34 passed, 0 failed; /private/tmp/R-136-focused-test.log"
  - "Pre-rebase ORG_ACTOR=R-136 node lanes/lane.mjs check: 767 passed, 11 skipped, 0 failed; /private/tmp/R-136-pre-rebase-lane-check.log"
  - "Validation-tier rebase ORG_ACTOR=R-136 npm run test:lanes: 160 passed, 0 failed; /private/tmp/R-136-rebased-lanes-test.log"
  - "Validation-tier rebase ORG_ACTOR=R-136 npm run test:acceptance: 81 passed, 0 failed; /private/tmp/R-136-rebased-acceptance-test.log; offline tests only"
  - "Validation-tier rebase ORG_ACTOR=R-136 node lanes/lane.mjs check --cmd 'npm test': 775 passed, 11 skipped, 0 failed; /private/tmp/R-136-validation-tiers-lane-check.log"
  - "Final supervisor-notice rebase ORG_ACTOR=R-136 npm run test:acceptance: 81 passed, 0 failed; /private/tmp/R-136-final-acceptance-test.log; offline tests only"
  - "Final validation: ORG_ACTOR=R-136 node lanes/lane.mjs check --cmd 'npm test' runs the full npm suite on the committed report head; /private/tmp/R-136-lane-check.log and .lane/gate.json retain its result"
  - "docs/reports/ENG-109-release-preview-r2-20261002.json: inherited built-candidate and --skip-live gate wiring evidence from the preceding run"
decisions:
  - text: "Validate operator-reserved question replies inside the existing record answer transaction using its normalized reply."
    category: design
    why: "Keep the closed question and derived candidate decision consistent, including overruling, while retaining the existing yes/no explanation parsing and ordinary question text answers."
  - text: "Retain upstream validation-tier commands and bounded test batches while preserving copied-entry isolation and all candidate tests."
    category: prover
    why: "Preserve upstream checks together with candidate gate coverage during package and discovery conflict resolution, and explicitly select the full npm command for the final worker check."
questions: []
challenges:
  - "The preceding validation log is green and adds no findings. The two new regressions independently reproduced the review's accepted ship it reply before the guard was added."
  - "The inherited repository preview remains wiring evidence from its recorded source commit: 9 PASS, 0 FAIL, 18 PENDING and acceptance exit 1. It does not establish live release readiness or execution of this final tree. No additional acceptance harness pass was needed or run for this answer-validation correction."
  - "The first sandboxed baseline attempt could not inspect its owned process (ps EPERM); the complete rerun with process-inspection access passed."
  - "Main advanced during the first final lane check to Report validation tier corrections for run R-133. That check passed before rebase. The subsequent rebase resolved package and discovery conflicts, retains both discovery declarations, and is followed by offline lane tests and a new full npm lane check."
  - "Main advanced again during validation to Report capped long-running notice fix for run R-135. The validation-tier tree passed its full check before a second, conflict-free rebase. The operator-reply fix, candidate tests, declarations and npm wiring are unchanged by this update; final full npm validation follows the report commit on the resulting tree."
---

The answer transaction rejects free-text release replies before any answer note,
metadata update, closure or reopening event is created. The existing normalization
accepts replies such as `YeS: ship it` and `NO, not yet`, recording yes/no and
retaining the explanation. The release guide documents the requirement.

Each regression creates a disposable project with a declared trivial gate,
rejects five text replies byte-for-byte without changing the event log, and
confirms the question remains in Waiting on you. It then performs a real local
lane promotion while the first candidate awaits its decision. Release correctly
defers until a normalized operator reply arrives. Rejected text overruling
preserves that decision; the next invocation tags and gates the promoted commit
once and creates its own visible operator question. Both approval and decline
paths pass. Existing approval tests preserve ordinary text-question behavior.

The final lane check follows the checked report commit so its gate receipt names
the exact resulting head. No live harness, model, ship, activation, push, shared
configuration edit or live pane operation was performed. Previous reports remain
unchanged.

The rebased npm command preserves main's `test:fast`, `test:promotion`,
`test:core` and `test:cycle`. Core uses the phased runner to isolate copied-entry
probes, and cycle includes the candidate tests. The runner's completion text now
describes the supplied file list, since `test:core` invokes it for one batch.
