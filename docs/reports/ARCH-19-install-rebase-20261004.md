---
run: R-210
outcome: done
summary: |
  Rebased lane/install onto main cea5391, preserving the native sandbox and fast CI tier split alongside the installer, dependency reuse, canonical entry opt-out and standalone release preparation fixes. Resolved the discovery/runtime.mjs import conflict by retaining readFleet and openProjectControls. Updated zero-setup fixtures to use the existing short fleet-temp helper after the sandbox's socket-path limit exposed an incompatible fixture path. All 110 requested cases pass across the unchanged-file results and final zero-setup rerun; no full suite or host test slot was used.
headline: The installer lane is rebased and its focused checks pass.
blockers: []
proposals: []
learnings:
  - Native sandbox startup enforces a 60-byte fleet run-temp path budget; zero-setup fixtures must use the existing fixtureFleet helper on macOS.
  - fixtureFleet may precreate an empty short root, so opt-out checks must verify that the root stays empty rather than requiring its absence.
artifacts:
  - "Commit e365c0e: Align zero-setup fixtures with native sandbox temp limits"
  - "Rebased installer commit d57d83d; review corrections 053e3f0; release preparation fix 774d4d0"
  - discovery/runtime.mjs
  - test/zero-setup-install.test.mjs
  - docs/reports/evidence/ARCH-19-R210/focused.tap
  - docs/reports/evidence/ARCH-19-R210/zero-setup-fixture-adjustment.tap
  - docs/reports/evidence/ARCH-19-R210/zero-setup-final.tap
decisions: []
questions: []
challenges: []
---

The rebase replay conflicted only in discovery/runtime.mjs imports. Its final diff against main is two additions: importing openProjectControls and opening project controls after a worker joins the fleet. Main's sandbox launch settings, project temp context and readFleet-based foreign-project context remain intact. The fleet and plugin-install tests auto-merged; native entry still checks canonical project opt-out before joining or opening controls.

package.json and test/helpers/tier.mjs match main exactly. A direct inventory assertion verified 69 promotion files plus 56 release files cover all 125 current test files exactly once, and the core/cycle/lanes/acceptance subdivisions cover the promotion list exactly once. The newly added zero-setup file defaults to release.

Validation used only the requested offline files:

```sh
node test/helpers/run.mjs release/test/*.test.mjs test/zero-setup-install.test.mjs test/fleet.test.mjs test/plugin-install.test.mjs
node test/helpers/run.mjs test/zero-setup-install.test.mjs
```

The first run completed 110 cases: 109 passed and the Claude-only supervisor case failed because the old fixture fleet path exceeded the new native run-temp budget. The short-path helper fixed that failure. An intermediate rerun exposed four opt-out assertions expecting the helper's empty root to be absent; those now require the root to remain empty. The final zero-setup rerun passed all 18 cases. The other requested files passed all 92 cases in the initial run. No runtime security boundary was relaxed.

Every invocation set both MONITOR_TEST_SLOT_PATH and MONITOR_TEST_SLOT_COMPAT_PATH to this lane's .lane/install-rebase-validation/test-slot.lock and cleared inherited slot tokens. Tests ran outside the outer workspace sandbox to allow their own nested native sandbox and scratch socket fixtures. No model, live acceptance harness or host test slot was used. JavaScript and installer shell syntax checks passed.

After this report is record-checked and committed, the last operation is:

```sh
node lanes/lane.mjs check --cmd "git merge-base --is-ancestor main HEAD && git diff --check main -- . ':!docs/reports/evidence'"
```

This final fast-tier gate checks the committed rebase ancestry and whitespace without running additional tests. Existing historical TAP evidence has trailing whitespace, so evidence logs are excluded from that whitespace check. Promotion validation remains with the train.
