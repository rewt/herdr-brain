---
run: R-332
outcome: done
summary: |
  The shared release fixture now builds its child environment from testSlotEnvironment() and sets both slot paths to a disposable lock under each fixture root. This isolates both release watchdog tests, and the other release tests, from inherited current and legacy slot variables. Auditing the lane's promotion test changes found no remaining unsanitized child environment added by this lane.
  All 27 release tests passed plainly and inside an outer scratch slot carrying the batch's wait, retry and token environment. Implementation and evidence are committed in 0cb6e27. This report is checked and committed before the required final lane check, which reruns the release file inside the scratch outer slot and writes the final gate receipt.
headline: Release watchdog tests now use isolated scratch slots and pass inside an enclosing gate
blockers: []
proposals: []
learnings: []
artifacts:
  - 'Implementation commit: 0cb6e27'
  - 'Branch: lane/gate-watchdog'
  - release/test/release.test.mjs
  - test/helpers/test-slot-env.mjs
  - docs/reports/evidence/ENG-274-R332/plain.log.gz
  - docs/reports/evidence/ENG-274-R332/outer.log.gz
  - docs/reports/evidence/ENG-274-R332/sandbox.log.gz
  - docs/reports/evidence/ENG-274-R327/reproduce.mjs
  - docs/reports/ENG-274-gate-watchdog-R-332.md
  - /Users/rewt/development/rewt/.org/runs/R-332/report.md
  - '.lane/gate.json: receipt written by the final lane check after the report commit'
decisions:
  - text: Apply the shared slot-environment scrubber and per-fixture scratch slot paths in the test fixture.
    category: tooling
    why: Every test using the fixture needs its own slot context, including both lane-added watchdog tests.
questions: []
challenges: []
---

The correction addresses the Minor finding in
`docs/reviews/gate-watchdog/37a75cc-r1.md`. The fixture removes all
`MONITOR_TEST_SLOT_*` and `BCH_CLOAK_TEST_SLOT_*` variables through the existing
helper before supplying its own two scratch paths. Test assertions and production
code are unchanged.

The audit compared `release/test/release.test.mjs`, `promote/test/*.test.mjs`
and the shared promotion fixture against main `da07cc67`. No promotion test
file was changed by this lane; its shared conformance fixture already uses
`testSlotEnvironment()` and scratch slot paths. All release child environments
are derived from the corrected fixture.

Focused verification:

- `node --test release/test/release.test.mjs`: 27 passed, no skips,
  47.127 seconds.
- `node docs/reports/evidence/ENG-274-R327/reproduce.mjs
  release/test/release.test.mjs`: 27 passed, no skips, 51.274 seconds.
  The outer scratch gate exited zero after one attempt and released its slot.
  The replay supplies both 7200-second wait variables and the retry marker;
  the wrapper supplies both slot tokens.
- `git diff --check` passed.

Both successful runs used approved host execution. An initial sandbox run
passed 26 tests but failed the existing held-slot CLI assertion because the
denied native memory probe prepended a `sysctl` warning to its expected
`TEST_SLOT_HELD:` output. The host run passed that assertion unchanged.
The sandbox log is retained alongside the successful runs.

The required last command, after checking and committing this report, is
`node lanes/lane.mjs check --cmd 'node docs/reports/evidence/ENG-274-R327/reproduce.mjs release/test/release.test.mjs'`.
This report does not claim that final receipt already exists.
