---
run: R-17
outcome: done
summary: |
  Folded herdr-lanes into lanes/ with its Git history, removed the retired board, release, OpenSpec and historical material, and retained the dependency-free lifecycle CLI with only its session registry and Herdr client helpers. The root suite remains separate from the lane suite, both are green, and the in-tree status and config output are byte-identical to the installed lane tool. Documentation now identifies lanes/ as Brain's future dispatch layer; the operator cutover remains intentionally outside this run.
headline: The lane dispatch tool now lives in herdr-brain with its history and both test suites green
blockers: []
proposals: []
learnings:
  - The installed 2026.09.16.1 tool supports always_args even though herdr-lanes main did not contain that release-only change; carrying it forward was required for configuration and argument compatibility.
  - The in-tree CLI is a dispatch superset of the installed release because it includes post-delivery occupant re-verification from herdr-lanes commit 245bba0; after cutover it can report partial success and omit the session record when the prompted occupant was replaced, where the installed release would record the session.
  - The corrected lane suite completed 135 tests with no skips because Herdr was available in this environment; it includes the 11 Herdr-client tests and excludes the retired 43-test message-preview suite.
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

The subtree merge makes `afb2bc6a90328d64c0a9187baf0bfd1b97128a00` and the preceding herdr-lanes history reachable from this branch. The retained tree contains the lifecycle CLI, `board/registry.mjs`, `board/herdr-client.mjs`, their surviving tests, templates and reference documentation. The board verb, inventory, actions, argument parsing, message previews and UI implementation, along with the release and supervisor packs, OpenSpec tree, contrib wrapper, handoff files and historical documents, are absent.

The installed executable was not changed. The local CLI reads the same `/Users/rewt/development/rewt/.lane.json` and Git state, and both of these comparisons produced no diff:

- `node lanes/lane.mjs status` versus `lane status`
- `node lanes/lane.mjs config` versus `lane config`

The source repository, installed release, live organization and all operator configuration remained read-only.

## Verification

- Baseline `npm test`: 151 tests, 150 passed, 1 skipped because console dependencies were not installed.
- Final `npm test`: 151 tests, 150 passed, 1 skipped for the same console-dependency reason.
- Final `npm run test:lanes`: 135 tests, 135 passed, 0 skipped. Herdr was present, so the optional Herdr check ran rather than skipping.
- `git diff --check`: passed.
- History check: `git merge-base --is-ancestor afb2bc6 HEAD` passed.
- Retained-doc check: `lanes/docs/` contains only `BRIEF_TEMPLATE.md`, `REFERENCE.md` and `REVIEW_TEMPLATE.md`.

## Commits

- `87ee9b8` Add `lanes/` from herdr-lanes commit `afb2bc6`.
- `30f0676` Fold lane dispatch into herdr-brain.
- `ec649f0` Report one-brain round three a.
- `1c3386e` Address fold-lanes review findings.
- The following report commit records the corrected evidence and second-run result.

## Cutover

- `~/.local/bin/lane`: old target `/Users/rewt/development/rewt/.lane-releases/herdr-lanes/2026.09.16.1/core/lane.mjs` -> new target `/Users/rewt/development/rewt/herdr-brain/lanes/lane.mjs`.
- Dispatch behavior: old installed release records a session after a successful prompt without rechecking the occupant -> new in-tree CLI re-verifies the post-delivery occupant and reports partial success without a session record if it changed.
- Fallback release: old `/Users/rewt/development/rewt/.lane-releases/herdr-lanes/2026.09.16.1` kept -> new same directory kept unchanged as the rollback target.
- GitHub repository: old `rewt/herdr-lanes` active -> new `rewt/herdr-lanes` archived with a pointer to `rewt/herdr-brain/tree/main/lanes`.

These are operator actions after promotion; none was performed in this run.
