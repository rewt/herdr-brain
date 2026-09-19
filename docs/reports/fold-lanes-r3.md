---
run: R-21
outcome: done
summary: |
  Rebased the lane fold onto current main while preserving the imported herdr-lanes commit graph and the subtree merge. The rebased tree differs from the prior corrected head only by main's console-design brief. Both test suites pass, the local lane status and config views remain byte-identical to the installed fallback tool, and the branch is ready to fast-forward after review.
headline: The lane fold is rebased cleanly and ready for final review
blockers: []
proposals: []
learnings:
  - A plain rebase tries to replay the imported subtree's unrelated history; rebuilding the subtree merge on current main and rebasing only its four first-parent integration commits preserves the source history and the intended tree.
  - The rebased corrected tree is identical to the pre-rebase corrected tree except for the console-design brief added on main.
  - The retained lane README is the operator-facing cut of the surviving technical reference: it covers configuration, lifecycle and every surviving command while linking to the full retained REFERENCE.md.
artifacts:
  - "rebased subtree commit: 54999ec Add lanes from herdr-lanes afb2bc6 on current main"
  - "rebased integration commits: 07339a7, b353b67, 5919e26, f6fbb5d"
  - "report: docs/reports/fold-lanes-r3.md"
  - "verification: npm test; npm run test:lanes; git diff --check main...HEAD"
  - "equivalence: local and installed status/config output compared byte for byte"
---

## Result

The missed rebase from the correction brief is complete. `main` at `e141e9d` is now
an ancestor of the lane branch, and the reconstructed subtree commit keeps
`afb2bc6` as its second parent. The imported herdr-lanes history therefore remains
reachable without replaying or flattening its unrelated commit graph.

The four integration commits were rebased on that reconstructed subtree commit.
Comparing the resulting corrected head with the pre-rebase corrected head shows one
change only: `docs/briefs/BRIEF-console-design-20260918.md`, the file added on main.
There are no content changes to the folded lane implementation from the rebase.

The documentation acceptance was checked directly. Root `README.md` names `lanes/`
as the future Brain dispatch layer; `lanes/README.md` is the concise operator-facing
cut of the surviving reference and covers configuration, lifecycle and every
surviving command; `lanes/docs/REFERENCE.md` remains the complete technical
reference. The north-star line and the `AGENTS.md` lane rules remain present.

No live symlink, fallback release, standalone repository, organization state or
operator configuration was changed.

## Verification

- `npm test`: 151 tests, 150 passed, 1 skipped because console dependencies are not installed.
- `npm run test:lanes`: 135 tests, 135 passed, 0 skipped; Herdr was present, so its optional check ran.
- `node lanes/lane.mjs status` matches the installed `lane status` byte for byte.
- `node lanes/lane.mjs config` matches the installed `lane config` byte for byte.
- `git merge-base main HEAD` is `e141e9d`; both `main` and imported source commit `afb2bc6` are ancestors of the branch.
- The subtree at `54999ec:lanes` matches the imported `afb2bc6` tree before the integration commits are applied.
- `git diff --check main...HEAD` passes, and the protected paths from the original brief are absent from the branch diff.

## Commits

- `54999ec` Add 'lanes/' from commit 'afb2bc6a90328d64c0a9187baf0bfd1b97128a00'
- `07339a7` Fold lane dispatch into herdr-brain
- `b353b67` Report one-brain round three a
- `5919e26` Address fold-lanes review findings
- `f6fbb5d` Report fold-lanes review corrections

## Cutover

After promotion, the operator repoints `~/.local/bin/lane` from
`.lane-releases/herdr-lanes/2026.09.16.1/core/lane.mjs` to
`herdr-brain/lanes/lane.mjs`, retains the 2026.09.16.1 directory as rollback, and
archives `rewt/herdr-lanes` with a pointer to `rewt/herdr-brain/tree/main/lanes`.
The in-tree CLI is a dispatch superset of that fallback: after delivering a prompt,
it re-verifies the pane occupant and reports partial success without recording a
session if the occupant was replaced.
