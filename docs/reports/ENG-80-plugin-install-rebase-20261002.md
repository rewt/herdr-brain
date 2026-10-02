---
run: R-105
outcome: done
summary: |
  Rebased the reviewed lane onto main and resolved the sole conflict in discovery/install.mjs, preserving reversible install and receipt checks alongside explicit validator selection and experimental bubblewrap gating.
  npm test passed with 590 passes and 11 optional skips; npm run test:lanes passed all 148 tests. All 15 other replayed commits retain identical patches. The report commit and final lane gate complete the handoff.
headline: The plugin installation lane is rebased with both installer behaviors preserved
blockers: []
proposals: []
learnings:
  - The macOS validation tests added on main need host execution because the managed sandbox refuses nested sandbox-exec startup.
artifacts:
  - Commit subject Install reversible project entry with Monitor releases, replayed onto main
  - Main commit subject Report experimental bubblewrap gating and pending Claude proof
  - Commit subject Report plugin installer rebase onto main
  - discovery/install.mjs
  - /private/tmp/eng80-r105-range-diff.log
  - /private/tmp/eng80-r105-before.log; /private/tmp/eng80-r105-core.log; /private/tmp/eng80-r105-core-host.log
  - /private/tmp/eng80-r105-lanes.log
  - docs/reports/ENG-80-plugin-install-rebase-20261002.md
  - /private/tmp/eng80-r105-final-gate.log; .lane/gate.json
decisions:
  - text: Combine both installer option sets and apply Codex receipt checks when Codex is selected.
    category: design
    why: Preserve installation ownership and preflight checks while retaining Claude-only installation and explicit validator selection.
questions: []
challenges:
  - The first post-rebase npm test had 17 failures because the managed sandbox rejected nested sandbox-exec startup. The identical suite passed with approved host execution; no source changes were made for that restriction.
---

The conflict covered option parsing, Codex receipt validation and the Claude
launcher. The resolution retains `--check`, plain-file and mode checks, receipt
name validation and native executable checks. It also retains main's optional
Codex handling, `--validator`, the validator receipt field and launcher selector.
`selectSandbox` still permits bubblewrap only through an explicit
`experimental-bubblewrap:/abs/path` selector. No other manual source changes were
made; range-diff confirms the other 15 commits have identical patches.

Before rebase, npm test passed 547 tests with five skips. After rebase, approved
host execution passed 590 tests with 11 skips and zero failures, including the
existing validator-selection and installation regressions. npm run test:lanes
passed all 148 tests with no skips. Both suites used explicit actors and
ten-minute process-group bounds; lane test concurrency was limited to four.

Main is an ancestor of the rebased lane. After record check and this report's
commit, lane check with npm test runs last using the same host execution. Its
log and .lane/gate.json record the final committed gate. Then this run stops.
