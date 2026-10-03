---
run: R-149
outcome: done
summary: |
  Added a tracked read-only release preflight that checks machine inputs before the once-only gate claim.
  Missing inputs return setup instructions and retain an ungated candidate that can be retried on the same tag and commit.
  An omitted bch-cloak checkout now produces five visible compatibility skips; configured compatibility checks retain their requirements.
  Required offline validation passed. One mechanics pass confirmed the skips, with only the expected live cases pending.
headline: Release setup errors no longer consume a gate attempt and existing-project checks are optional.
blockers: []
proposals: []
learnings:
  - "Preflight failure leaves the record at pending-gate without gate-start or gate-result events; diagnostics are retained in GIT_COMMON_DIR/release/RC-n.setup.log."
  - "RELEASE_BCH_CLOAK is optional when unset or empty; an explicitly configured missing directory still fails preflight."
  - "The acceptance --skip-live option skips discovery but does not disable the real Herdr fixture; this lane explicitly cleared HERDR_ENV to avoid live pane operations."
artifacts:
  - "Implementation commit: 929ef43"
  - ".release.json; release/config.mjs; release/release.mjs; herdr/release-candidate.mjs"
  - "acceptance/cases.mjs; acceptance/results.mjs; acceptance/run.mjs"
  - "release/test/candidate.test.mjs; release/test/release.test.mjs; acceptance/test/cases.test.mjs"
  - "release/README.md; acceptance/README.md"
  - "Post-change npm test: /private/tmp/R-149-post-test.log"
  - "Release and focused acceptance regressions: /private/tmp/R-149-targeted.log"
  - "Fast validation: /private/tmp/R-149-fast.log"
  - "Acceptance offline validation: /private/tmp/R-149-acceptance-offline.log"
  - "Single skip-live mechanics pass: /private/tmp/R-149-skip-live.log"
  - "Mechanics summary and screen: /private/tmp/herdr-acceptance-sURWki/evidence/summary.json; /private/tmp/herdr-acceptance-sURWki/evidence/screen.txt"
decisions:
  - text: "Added an optional preflight argument array to the tracked project declaration, executed under the project lock before claiming the gate."
    category: design
    why: "Machine setup must be correctable without burning the candidate or weakening once-only execution after a claim."
  - text: "Skip only the five existing-project compatibility cases when no checkout is configured."
    category: design
    why: "A fresh machine can gate without a bch-cloak checkout, while configured compatibility checks and every other gate requirement remain strict."
questions: []
challenges: []
---

The project wrapper now has a `preflight` stage. It checks the npm cache index,
readable pinned console/MCP tarballs, and the configured compatibility directory
without staging dependencies or building anything. Cache discovery retains the
existing defaults: `RELEASE_NPM_CACHE`, then `npm_config_cache`, then `~/.npm`.
Preparation still installs from a private offline cache and retains build evidence.

The release module resolves the preflight declaration from the exact clean commit.
It cuts the candidate/tag, runs the read-only preflight from the canonical checkout
under the existing project lock, and only then claims the gate. A nonzero exit,
launch error or signal returns `setup-required` with the setup message, command and
log. No snapshot, build, gate result or shipping question is created. Correcting
setup reuses the candidate ID, tag and commit. Already claimed or completed gates
retain their interruption and immutable-result semantics; this does not rewrite
previous failed candidates.

Without `--bch-cloak`, acceptance reports SKIP for the existing copy/inventory,
wrappers/routing, org PATH consumers, switches/rollback, and contrib retirement.
Each screen line and JSON result names the omission and the option for enabling
the checks. The summary counts skips separately. Skips permit READY when all other
cases pass; product failures and pending live cases still prevent READY. Supplying
a checkout preserves all five bodies and their existing prerequisites.

Validation evidence:

- Baseline `npm test`: 850 passed, 11 explicitly skipped, zero failures
  (copied entry 2; core/modules 698 passed and 11 skipped; cycle 150).
- Post-change `npm test`: 854 passed, 11 explicitly skipped, zero failures
  (copied entry 2; core/modules 698 passed and 11 skipped; cycle 154).
- `npm run test:fast`: 140 passed, zero failures.
- Release offline tests plus focused acceptance case/result tests: 38 passed,
  zero failures. These exercise the tracked commands, actual offline fixture
  installs, unset/missing inputs, signaled preflight, one candidate across retries,
  exactly one eventual gate start/result, missing pinned tarballs, and configured
  versus omitted compatibility requirements.
- `npm run test:acceptance`: 135 passed, zero failures.
- Exactly one `HERDR_ENV='' node acceptance/run.mjs --candidate "$PWD"
  --npm-cache /Users/rewt/.npm --skip-live` pass: 9 PASS, 0 FAIL, 13 PENDING,
  5 SKIP. Exit 1 / NOT READY is expected for the deliberately disabled live
  cases. The screen and JSON summary show all five skip reasons. Cleanup reports
  no credential residue or retained discovery roots.

No live harness, project release cycle, model call, or bch-cloak checkout mutation
was performed. Release-cycle calls in the offline tests use disposable fixtures.

After checking and committing this report, the final operation is
`ORG_ACTOR=R-149 node lanes/lane.mjs check`. Its output is retained at
`/private/tmp/R-149-final-lane-check.log`; ignored `.lane/gate.json` records evidence
for the final report commit. No tracked edits follow that check.
