---
run: R-208
outcome: done
summary: |
  Rebased lane/fast-ci onto main at d3a636d, retaining ENG-135's helpers and inventory alongside the fast promotion/release split.
  The inventory assigns 69 full files to promotion and 54 to release; the complete release command schedules all 123 bounded files exactly once plus the native slot suite.
  Both mixed-file promotion selectors, including the 32 restored fast logic cases, and review cap 1 are preserved. The six requested tier-plan and suite tests pass.
headline: Fast CI is rebased with complete release coverage preserved
blockers: []
proposals: []
learnings:
  - ENG-135 extracted the deliberate Git and ref-transaction response waits into test/deadline-boundaries.test.mjs and settle/test/ref-wallclock.test.mjs; both stay in release.
  - The full release command must combine the promotion file groups with the release-only inventory; invoking only the release tier helper omits the promotion files.
artifacts:
  - Rebase base d3a636d4c24695bf82b111738ece97bc4f778f8f
  - Reconciliation commit fd7956c
  - docs/reports/ENG-157-fast-ci-rebase-evidence-20261004/tier-suite.log
  - docs/reports/ENG-157-fast-ci-rebase-evidence-20261004/tier-inventory.json
  - test/helpers/tier.mjs
  - docs/reference/test-tiers.md
  - docs/validation-tiers.md
  - docs/reports/ENG-157-fast-ci-rebase-20261004.md
  - Final clean-tree lane check receipt is written to .lane/gate.json after this report is committed
decisions: []
questions: []
challenges: []
---

Replayed all five lane commits onto main. Conflicts in README.md, package.json
and release/test/candidate.test.mjs were resolved by combining both changes.
The explicit full-file promotion list now uses ENG-135's tier helper. Its fast
inventory and fixture helpers remain intact. File-wait, Git-seed and tier-plan
regressions stay in promotion; PTY-cache and extracted wall-clock regressions
stay in release. Mixed-file selectors in package.json match the pre-rebase
lane byte for byte, preserving the R-206 correction and selected lane guards.

The complete offline release command runs the native slot suite, core, cycle,
lanes, acceptance and release-only files. Tier-plan and suite assertions verify
complete coverage, no duplicate full-file scheduling, and fast inclusion in
promotion. Release preparation runs that complete command before writing build
evidence. The older separate gate-time subset was folded into preparation so
those tests are covered once per candidate. Both candidate-test scenarios remain,
with the safety regression following the preparation boundary. The slot retry
regression's expected release steps include the added release-only leaf.

Validation: `ORG_ACTOR=R-208 node test/helpers/run.mjs test/tier-plan.test.mjs
test/suite.test.mjs` passed all six tests in 1.459 seconds. Static inspection
confirmed the original full-file promotion coverage, both selectors and review
cap 1 were retained. Syntax checks and `git diff --check` passed. Only the
requested tier-plan and suite test files were executed; no host test slot, full
suite, live acceptance, model, promotion or push was used.

The under-five-minute promotion evidence remains R-199's historical 179.497
seconds; this narrow rebase round does not claim a new full-tier measurement.
After report validation and its commit, the final operation is
`node lanes/lane.mjs check --cmd 'ORG_ACTOR=R-208 node test/helpers/run.mjs
test/tier-plan.test.mjs test/suite.test.mjs'`. This records clean-tree evidence
for the requested focused files without acquiring the host slot. Its result is
available in the lane receipt and the final run response.
