# Lane check implementation report

Date: 2026-09-08

## Result

Implemented `lane check [--cmd <validate command>]` and the board `GATE` column.
Checks now bind a validation exit to the full pre-validation HEAD in
`.lane/gate.json`; the board independently compares that record with the registered
lane worktree's current HEAD.

## Behavior delivered

- `lane check` accepts the configured validator, the existing `LANE_VALIDATE`
  override, or a per-run `--cmd` override without introducing another default.
- Configured `prepare` steps run before validation, matching promotion behavior in
  fresh worktrees.
- A dirty current worktree is rejected before validation or gate replacement.
- Green and failed validations both produce an atomic JSON record and a single
  `GATE <full-head> exit=<n> (<duration>)` line; the process returns `<n>`.
- Signal termination records the signal name and uses the shell-compatible
  `128 + signal number` exit code; ordinary exits record `signal: null`.
- Board snapshots render `exit=0 @<head7>`, a matching non-zero exit, `STALE`, or
  `-`. Only the interactive Ink view colors matching results green or red.

## Test-first controls

The focused pre-implementation CLI run failed 3/3 new `check` tests because the
command was unknown. The focused board run failed 4/4 changed expectations because
gate collection, rendering, and freshness comparison were absent. Every affected
test includes the suite's `negativeControl` call.

## Verification

- Baseline: `npm test` passed 41/41 before changes.
- Final `npm test` passed 44/44; `LANE_TEST_NEGATIVE_CONTROL=1 npm test`
  deliberately failed all 44 controls (0 passed).
- `git diff --check` passed.
- Verified with Node.js 20.19.4, npm 10.8.2, and git 2.54.0.
- Clean-tree implementation gate:
  `GATE ec88e4b42d49dd413aa29fb06fbdf56bebf96be5 exit=0 (4.941s)`

That line measured the implementation commit, then became stale when this report was
committed. The corrected workflow is to commit the complete handoff first and run
`lane check` again afterward. The final post-commit gate is intentionally reported
outside this tracked file so recording it cannot create another commit and stale it.

## Round-two review

The follow-up adds prepare parity, signal-preserving gate records, complete refusal
and absent-state coverage, a derived wide-table breakpoint, an exact gate-cell color
offset, and aligned usage text. README and REFERENCE now make `.lane/` gitignore and
post-final-commit validation explicit handoff requirements.

Round-two verification: `npm test` passed 49/49 and
`LANE_TEST_NEGATIVE_CONTROL=1 npm test` deliberately failed all 49 controls (0
passed). The baseline before this round passed 44/44. Verification used Node.js
20.19.4, npm 10.8.2, and git 2.54.0; `git diff --check` passed.

## Unverified

No live Herdr event or interactive terminal color sequence was exercised. Board gate
collection and plain rendering are covered offline in temporary repositories; Ink
color selection is covered through the row presentation state.
