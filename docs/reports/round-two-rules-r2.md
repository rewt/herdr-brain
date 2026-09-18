---
run: R-15
outcome: done
summary: |
  Corrected all four round-one review findings. The settle protocol now commits the public review record before evaluating promotion, treats that record-only commit as a failed exact-head condition unless a later goal decision explicitly permits it, files structured operator questions with actionable yes/no notes, and restores the standing lane-concurrency rules. The README now matches the abandoned-report behavior. Both test suites pass.
headline: The settle checklist now preserves its safety limits and files actionable operator questions
blockers: []
proposals: []
learnings:
  - The current promotion policy requires a PASS for the exact lane head with no later commit, while the public review record must itself be committed; without a later goal decision allowing that record-only commit, condition 1 necessarily fails and the settle session must ask the operator.
  - Human questions need category, recommendation, and memo metadata plus explicit Recommend, Why, On yes, and On no text so the console and a later continue session can act on them.
  - The goal decision notes do not replace the standing limit of two engineering lanes or the rule to serialize lanes whose file sets may overlap.
artifacts:
  - 0454af8 Add round-one review record
  - 35eb7ae Clarify settle review and question gates
  - docs/reviews/round-two-rules/0ad5908-r1.md
  - npm test — 141 passed
  - npm --prefix console test — 92 passed
---

## Corrections

1. `supervisor/SETTLE.md` now tells the settle session to commit only the public review record before checking the goal's promotion conditions. It does not silently reinterpret the operator's exact-head rule: a record-only commit still fails condition 1 unless a later goal decision explicitly allows it.
2. The promotion ask branch now gives a complete `org add` and `org note` template. It parents the question to the goal, supplies category, recommendation, and review-record memo metadata, and records what yes and no each do. Continue mode points back to the same template.
3. Continue mode again permits at most two engineering lanes, serializes overlapping work, and requires a new lane and one-sentence brief for each item.
4. `README.md` now says both sync and explicit ingest skip reports that arrive after abandonment, matching the code and CLI message.

The exact-head wording conflict is now visible and safe: it causes an operator question instead of an unauthorized promotion. The operator can later change the goal note if record-only commits should be exempt.

## Verification

- `npm test`: 141 passed, 0 failed.
- `npm --prefix console test`: 92 passed, 0 failed.
- `git diff --check`: passed.
- `git rebase main`: branch reported up to date; `main` remains an ancestor of the lane head.
- Only the round-one review record, `supervisor/SETTLE.md`, `README.md`, and this report changed in the correction round.

## Cutover

None. These corrections change tracked documentation and the supervisor checklist only; no external configuration or service restart is required.
