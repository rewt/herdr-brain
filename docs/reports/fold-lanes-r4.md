---
run: R-24
outcome: done
summary: |
  Made the root test scripts portable across Node 20 and Node 22, guarded automatic promotion against merge-bearing lane histories, and rebuilt the subtree merge on the current main tip without linearizing the imported history. Both test suites pass under both supported Node versions, and the lane merge-base matches current main.
headline: The folded lane is portable across Node versions and safe from merge-history auto-rebases
blockers: []
proposals: []
learnings:
  - Explicit test-file globs must retain the helper and fixture modules that Node 20's directory expansion previously admitted as test-runner inputs if the test count is to remain behaviorally stable.
  - A clean merge-tree result describes compatible final trees, not whether plain rebase can safely replay a branch containing merges.
  - Current main added three console test cases while this lane was in review, so the post-rebase root total is 154 rather than the pre-rebase 151; Node 20 and Node 22 agree on the new total.
artifacts:
  - "correction commit: 719437d Guard lane rebase compatibility"
  - "rebuilt subtree merge: a0911f1 Add lanes from herdr-lanes afb2bc6 on current main"
  - "report: docs/reports/fold-lanes-r4.md"
  - "verification: Node 20 and Node 22 npm test; Node 20 and Node 22 npm run test:lanes; git diff --check main...HEAD"
---

## Result

The root scripts now pass explicit file patterns rather than directory arguments.
`npm test` covers the root test modules and fixtures, the Brain tests, and the
console tests and fixture module; `npm run test:lanes` covers the two top-level
lane test modules. This preserves the inputs that Node 20 previously discovered
recursively while also working under Node 22's glob-based test argument handling.

`rebaseCheck` now runs `git rev-list --merges <against>..<branch>` before its
tree-merge probe. A nonempty result returns `clean: false`, an empty `conflicts`
array, and the exact reason string:

`merge commit present; plain rebase would linearize and may conflict`

`promote` surfaces that reason and exits before invoking `git rebase`. The public
`rebase-check` control prints the same reason. Merge-free branches retain the
existing merge-tree clean/conflict path.

The new promotion test constructs two otherwise equivalent lanes behind a moved
main. The merge-bearing lane is refused with the reason above; its branch, main,
clean worktree and absent rebase state are all checked. The linear lane is the
observed negative control and still rebases and promotes normally.

## Rebase

Main had advanced again during review, to
`080aa33f814b997eefc1d18a22292c44a88da55f`. The subtree merge was rebuilt as
`a0911f1` with that main commit as first parent and the original imported split
`afb2bc6a90328d64c0a9187baf0bfd1b97128a00` as second parent. Its `lanes/` tree
matches the prior subtree merge exactly.

Only the lane's first-parent commits were replayed on the rebuilt merge. The
prior four integration commits, the round-3 report, this correction, and this
report are the only commits reported by
`git rev-list --first-parent --no-merges main..HEAD`; none of the imported
subtree history was linearized. A plain `git rev-list --no-merges main..HEAD`
also traverses the preserved second parent and therefore lists the imported
commits by reachability; that output cannot contain only the lane's integration
commits while the subtree parent is preserved. `git merge-base main HEAD` is
`080aa33f814b997eefc1d18a22292c44a88da55f`, exactly the current main tip.

## Verification

- Node 20.19.4 `npm test`: 154 tests, 153 passed, 1 skipped.
- Node 20.19.4 `npm run test:lanes`: 136 tests, 136 passed, 0 skipped.
- Node 22.22.3 `npm test`: 154 tests, 153 passed, 1 skipped.
- Node 22.22.3 `npm run test:lanes`: 136 tests, 136 passed, 0 skipped.
- The root total is three above the brief's pre-rebase baseline because current
  main added two console project-switch cases and one Claude transcript-shape
  case. Both Node versions produce identical totals.
- `git diff --check main...HEAD` passes.
- The rebuilt subtree's `lanes/` tree equals the prior subtree's `lanes/` tree,
  and the imported split remains the rebuilt merge's second parent.

## Commits

- `a0911f1` Add 'lanes/' from commit 'afb2bc6a90328d64c0a9187baf0bfd1b97128a00'
- `4a12e1b` Fold lane dispatch into herdr-brain
- `6c70b4e` Report one-brain round three a
- `4a41ec1` Address fold-lanes review findings
- `4b864fc` Report fold-lanes review corrections
- `831c297` Report rebased lane fold
- `719437d` Guard lane rebase compatibility

No review sanitizer, release, live symlink, operator configuration, organization
state, supervisor, Brain, console, bin or lib implementation was changed by this
correction.

## Wrap-up correction (operator session, 2026-09-19)

Review round 3 (`docs/reviews/fold-lanes/cbf23c0-r3.md`) found that the
explicit root `test` patterns left out `console/proto/prototype.test.mjs`,
which main gained from the console-design promotion after this lane's earlier
base, so the 154 total above was 13 short of what main's bare `node --test`
ran. `console/proto/*.test.mjs` is now in the root `test` script.

- Node 20.19.4 and Node 22.22.3 `npm test`: 167 tests, 166 passed, 1 skipped
  (the same total as main at 080aa33).
- Node 20.19.4 and Node 22.22.3 `npm run test:lanes`: 136 tests, 136 passed.

The round's three Minor findings (rebase-check refusing an ahead-only lane
that carries a merge, `status` not printing the refusal reason, REFERENCE.md
not describing the refusal) are left for a follow-up item; none affects this
promotion, which fast-forwards.
