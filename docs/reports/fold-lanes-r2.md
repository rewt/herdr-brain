---
run: R-20
outcome: done
summary: |
  Addressed all seven findings from the first independent review. The folded tree now retains only the lane CLI, session registry and Herdr client helpers; every retained test is reached by the root lane-test script, stale non-Git board branches are gone, the nested manifest points at herdr-brain, and always_args validation and configuration reporting have direct tests with observed negative controls. Both suites are green, status and config remain byte-identical to the installed tool, and the earlier report now states the dispatch behavior change at cutover.
headline: The lane fold now contains only dispatch code and every retained test runs
blockers: []
proposals: []
learnings:
  - The old lane total combined 121 lifecycle tests with 43 retired message-preview tests while omitting 11 Herdr-client tests under the sibling board/test directory; the corrected 135-test suite is 124 lifecycle tests plus those 11 retained client tests.
  - The in-tree CLI is a dispatch superset of the installed release because post-delivery occupant re-verification can report partial success without recording a replaced session.
  - The lane CLI exits during its initial repository probe outside Git, so all later undefined-repository configuration and --repo branches were unreachable board-era code.
artifacts:
  - "fix commit: 1c3386e Address fold-lanes review findings"
  - "review record: docs/reviews/fold-lanes/ec649f0-r1.md"
  - "corrected report: docs/reports/one-brain-round-3a.md"
  - "verification: npm test; npm run test:lanes; git diff --check"
  - "equivalence: local and installed status/config output compared byte for byte"
---

## Result

The review findings are resolved as follows:

- Removed the unused and unloadable `board/inventory.mjs`, `board/actions.mjs` and `board/args.mjs` modules.
- Removed the board-only message-preview module and its 43 tests.
- Moved the 11 Herdr-client tests into `lanes/test/` and corrected their import, so `npm run test:lanes` executes them.
- Removed unreachable undefined-repository and machine-board configuration branches from `lane.mjs`.
- Added direct tests for a non-object `always_args`, a first token that is not an option, and the value and source shown by `lane config`; all three negative controls were executed and failed deliberately at their named assertion.
- Renamed the nested package, pointed its description and repository at herdr-brain, and removed its broad test script so the root `test:lanes` command is the sole lane-suite entry point.
- Corrected the earlier report to name the exact retained helpers and to disclose that cutover gains post-delivery occupant re-verification.

The first-round review record is now tracked beside the fix. No live symlink, fallback release, standalone repository, organization state or operator configuration was changed.

## Verification

- Baseline `npm test`: 151 tests, 150 passed, 1 skipped because console dependencies are not installed.
- Baseline `npm run test:lanes`: 164 tests, 164 passed, 0 skipped.
- Final `npm test`: 151 tests, 150 passed, 1 skipped for the same console-dependency reason.
- Final `npm run test:lanes`: 135 tests, 135 passed, 0 skipped; Herdr was present, so its optional check ran.
- Focused Herdr-client suite: 11 tests, 11 passed.
- Focused always_args suite: 3 tests, 3 passed; the negative-control run produced the expected 3 deliberate failures.
- Local `status` and `config` output matched the installed `lane` executable byte for byte.
- `git diff --check`, manifest parsing, retained-document checks and the imported-history ancestry check passed.

## Cutover

The operator actions remain unchanged: repoint `~/.local/bin/lane` from the 2026.09.16.1 fallback release to `herdr-brain/lanes/lane.mjs`, retain that release directory as rollback, and archive `rewt/herdr-lanes` with a pointer to `rewt/herdr-brain/tree/main/lanes`. The new target additionally re-verifies the prompted occupant after delivery and does not record a session if that occupant was replaced.
