---
run: R-17
outcome: done
summary: |
  Folded herdr-lanes into lanes/ with its Git history, removed the retired board, release, OpenSpec and historical material, and kept the dependency-free dispatch lifecycle and its surviving tests. The root suite remains separate from the lane suite, both are green, and the in-tree status and config output are byte-identical to the installed lane tool. Documentation now identifies lanes/ as Brain's future dispatch layer; the operator cutover remains intentionally outside this run.
headline: The lane dispatch tool now lives in herdr-brain with its history and both test suites green
blockers: []
proposals: []
learnings:
  - The installed 2026.09.16.1 tool supports always_args even though herdr-lanes main did not contain that release-only change; carrying it forward was required for exact config and dispatch compatibility.
  - The lane suite completed 164 tests with no skips because Herdr was available in this environment.
  - Root node test discovery would have included lanes automatically, so the root test script now names its original test directories explicitly while test:lanes owns lanes/test.
artifacts:
  - "branch: lane/fold-lanes"
  - "subtree commit: 87ee9b8"
  - "integration commit: 30f0676"
  - "lane CLI: lanes/lane.mjs"
  - "commands: npm test; npm run test:lanes"
  - "equivalence: diff of local and installed status/config output"
---

## Result

The subtree merge makes `afb2bc6a90328d64c0a9187baf0bfd1b97128a00` and the preceding herdr-lanes history reachable from this branch. The retained tree contains the lifecycle CLI, session registry and Herdr helpers, surviving tests, templates and reference documentation. The board verb and UI implementation, release and supervisor packs, OpenSpec tree, contrib wrapper, handoff files and historical documents are absent.

The installed executable was not changed. The local CLI reads the same `/Users/rewt/development/rewt/.lane.json` and Git state, and both of these comparisons produced no diff:

- `node lanes/lane.mjs status` versus `lane status`
- `node lanes/lane.mjs config` versus `lane config`

The source repository, installed release, live organization and all operator configuration remained read-only.

## Verification

- Baseline `npm test`: 151 tests, 150 passed, 1 skipped because console dependencies were not installed.
- Final `npm test`: 151 tests, 150 passed, 1 skipped for the same console-dependency reason.
- Final `npm run test:lanes`: 164 tests, 164 passed, 0 skipped. Herdr was present, so the optional Herdr check ran rather than skipping.
- `git diff --check`: passed.
- History check: `git merge-base --is-ancestor afb2bc6 HEAD` passed.
- Retained-doc check: `lanes/docs/` contains only `BRIEF_TEMPLATE.md`, `REFERENCE.md` and `REVIEW_TEMPLATE.md`.

## Commits

- `87ee9b8` Add `lanes/` from herdr-lanes commit `afb2bc6`.
- `30f0676` Fold lane dispatch into herdr-brain.
- This commit adds the completed round-three-a report.

## Cutover

- `~/.local/bin/lane`: old target `/Users/rewt/development/rewt/.lane-releases/herdr-lanes/2026.09.16.1/core/lane.mjs` -> new target `/Users/rewt/development/rewt/herdr-brain/lanes/lane.mjs`.
- Fallback release: old `/Users/rewt/development/rewt/.lane-releases/herdr-lanes/2026.09.16.1` kept -> new same directory kept unchanged as the rollback target.
- GitHub repository: old `rewt/herdr-lanes` active -> new `rewt/herdr-lanes` archived with a pointer to `rewt/herdr-brain/tree/main/lanes`.

These are operator actions after promotion; none was performed in this run.
