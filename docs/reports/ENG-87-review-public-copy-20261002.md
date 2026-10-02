---
run: R-69
outcome: done
summary: |
  The shared reviewer prompt now requires the exact finding format for every route
  and verdict, including the literal semicolon before Fix. Public projection keeps
  malformed finding lines as sanitized, escaped prose marked Unparsed finding,
  instead of refusing the review for their shape or blank-line spacing. Private
  section boundaries and all existing privacy, evidence, and lifecycle checks remain
  enforced. Offline lane and core suites passed; the implementation is committed
  on lane/review-copy and the final lane check follows the report commit.
headline: Malformed review findings now remain readable in the public review copy
blockers: []
proposals: []
learnings:
  - "All three supplied private reviews used description. Fix: change instead of the required description; Fix: change, causing the finding-shape refusal."
  - "Every review route already uses lanes/docs/REVIEW_TEMPLATE.md; the fix needs no harness-specific prompt branch."
  - "Unparsed finding text must pass the public prose sanitizer, literal renderer, and second-pass verification; only Findings is used for this fallback."
artifacts:
  - "Commit subject: Preserve malformed lane findings in public reviews"
  - "Report commit subject: Report public review copy fix and validation"
  - "Branch: lane/review-copy"
  - "lanes/lane.mjs; lanes/test/lane.test.mjs; lanes/docs/REVIEW_TEMPLATE.md; lanes/docs/REFERENCE.md; lanes/README.md"
  - "npm run test:lanes: 147 passed, 0 failed"
  - "npm test (final rerun): 410 passed, 0 failed, 2 skipped"
  - "Focused malformed-finding and spacing regressions: 2 passed, 0 failed"
  - "Original-CLI regression control: the new malformed-finding test failed with the original each-finding diagnostic and exit 2 instead of the expected verdict exit 1"
  - "Final command after report commit: node lanes/lane.mjs check; result is recorded in .lane/gate.json"
decisions:
  - text: "Treat malformed finding lines as marked public prose while preserving valid finding structure."
    category: design
    why: "Workers need the requested revisions even when a reviewer misses the formatting contract; using the existing sanitizer keeps the fallback within the public payload rules."
  - text: "Keep the strict private section schema, evidence validation, protected locations, and target-integrity checks."
    category: design
    why: "A finding-format defect must not cause private Analysis or Private identifiers sections to enter the public copy or broaden lifecycle authority."
questions: []
challenges:
  - "The initial npm test attempt hung in the unrelated watcher idle-grace fixture. A serial core-suite attempt encountered five watcher timing failures and a file timeout; the isolated watcher suite passed all 17 tests, and the final ordinary npm test rerun passed after the lane suite finished. No watcher code was changed."
---

The projection no longer rejects unknown severity tags, missing locations or fixes,
the observed missing-semicolon format, multiline finding prose, or blank lines in
Findings solely for their shape. Each nonempty unparsed source line remains visible
with an explicit marker, while valid findings retain their severity and file:line.
An empty Findings section gets a marked notice that no finding text was supplied.

The offline regression exercises NEEDS-WORK, FAIL, and PASS on both review-codex
and an alternate Claude route. It includes representative findings from promote,
console-control, and acceptance-completion, mixes canonical and malformed entries,
and verifies literal Markdown rendering, private alias and absolute-path redaction,
and exclusion of the private Analysis sentinel and private-only section headings.
The original CLI fails this regression with the reported production diagnostic.

Privacy-related publication refusals, invalid private metadata or evidence, output
size limits, unsafe structural locations, and lane mutation refusals remain in place.
This change makes finding shape recoverable; it does not claim that unsafe or
incomplete private records are publishable. No live model review, pane mutation,
promotion, push, or release was performed.
