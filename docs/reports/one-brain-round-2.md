---
run: R-16
outcome: done
summary: |
  Corrected all six independent-review findings. Unmatched Brain results remain reachable on every project tab, a console launched with a custom config passes that exact config to Brain, Codex typed composer text is classified as stranded while faint placeholder text is ignored, and tidy-tabs accepts PASS, NEEDS-WORK, or FAIL on the first nonempty review-record line. The project behavior is documented, and both displaced earlier reports now have collision-safe names.
headline: Project-filtered waiting work remains reachable and finished sessions are classified correctly
blockers: []
proposals: []
learnings:
  - Results attributed to other need to appear on every configured project tab because the project switch has no other tab.
  - A console-specific config path must be propagated to the Brain queue child or the two processes can derive different project names.
  - Codex uses a single prompt-glyph composer line; normal-intensity text is operator input while faint text is placeholder chrome.
  - Lane review completion recognizes PASS, NEEDS-WORK, and FAIL only when the verdict is on the first nonempty line.
artifacts:
  - "27a14ba: fixes all six round-one review findings and records the review"
  - "docs/reports/one-brain-round-1b-r2.md: restored R-12 report"
  - "docs/reports/one-brain-round-2-r1.md: retained R-13 report with the restoration note"
  - "npm test: 149 passed, 0 failed"
  - "npm --prefix console test: 94 passed, 0 failed"
  - "node console/app.mjs --print 140x45 --project herdr-org: rendered successfully"
  - "git diff --check: passed"
---

# One Brain round 2 correction

## Review findings corrected

- `other` results are included on every configured project tab, so their actions remain reachable;
  the elsewhere summary now counts only results hidden in other configured projects. The board
  regression verifies both active tabs and renders an unmatched row.
- `console/app.mjs` resolves the config it actually loaded and gives it to the session. The Brain
  queue child receives that path as `HERDR_ORG_CONSOLE_CONFIG`; a child-process regression proves
  the exact custom path arrives.
- The Codex screen parser now recognizes a trailing `›` composer independently of the assistant's
  final message. A fixture proves normal text becomes `unsent`, and an ANSI regression proves faint
  placeholder text does not.
- `tidy-tabs` now accepts all lane-review verdicts (`PASS`, `NEEDS-WORK`, and `FAIL`) on the first
  nonempty line. Its regression feeds a FAIL record through `reviewedAgentsFromRecords` and rejects
  a verdict below nonempty prose.
- The public READMEs now describe project derivation, the `other` behavior, project filtering and
  switching, the elsewhere count, and the project shown by `brain queue` and `brain show`.
- The displaced R-12 report is restored byte-for-byte as `one-brain-round-1b-r2.md`. The R-13
  report is retained as `one-brain-round-2-r1.md` and records that restoration.

## Verification

The required pre-change root suite passed 145 tests. After the correction, `npm test` passed all
149 tests and `npm --prefix console test` passed all 94 console tests. The 140×45 console print
rendered successfully against the live configuration and visibly included an unmatched waiting
result while on the `herdr-org` project. `git diff --check` passed. The restored R-12 file's Git
object hash exactly matches the version formerly tracked on `main`.

A live `tidy-tabs --dry-run` could not inspect tabs because Herdr was unavailable at verification
time; it exited safely without closing anything. The pure planner and review-record regressions in
the passing root suite cover review-tab retirement, including the newly accepted FAIL verdict.

## Cutover

None. No external configuration, Brain state, organization state, service, or Herdr tab was
changed. The tidy-tabs check was dry-run only and Herdr was unavailable.
