---
run: R-156
outcome: done
summary: |
  Moved release preflight before recording a candidate or creating its tag, resolving both review findings.
  Missing setup now leaves no pending candidate that can block a later promoted commit; retries cut and gate the current release base.
  Added regression coverage for unchanged and advanced main, interrupted checks, launch errors, and the real project input wrapper.
  The final full suite and the release, fast, acceptance offline, and lane suites all passed.
headline: Release setup failures remain retryable after promotions advance the release base.
blockers: []
proposals: []
learnings:
  - "Preflight now precedes release.cut and tag creation. New setup failures return candidate: null plus the commit, proposed tag, command, setup message and log path; they leave no pending-gate candidate."
  - "Setup diagnostics are retained in GIT_COMMON_DIR/release/{tag}.setup.log because no candidate ID exists yet. After setup is corrected, either the same commit or a later promoted commit can be cut normally."
  - "An intentionally empty event log is valid before candidate creation; fixture readers must filter empty lines before JSON parsing."
artifacts:
  - "Implementation commit: 7566335f3fec354d5ca4f1823a6b2e6c3eae010e"
  - "release/release.mjs; release/README.md; release/test/release.test.mjs; release/test/candidate.test.mjs"
  - "Final npm test: /private/tmp/R-156-final-test.log"
  - "Release offline tests: /private/tmp/R-156-release-offline.log"
  - "Fast validation: /private/tmp/R-156-fast.log"
  - "Acceptance offline tests: /private/tmp/R-156-acceptance-offline.log"
  - "Lane suite: /private/tmp/R-156-lanes.log"
  - "Isolated promotion rerun: /private/tmp/R-156-promote-isolated.log"
  - "Earlier validation failures: /private/tmp/R-156-baseline.log; /private/tmp/R-156-post-test.log; /private/tmp/R-156-post-test-rerun.log"
decisions:
  - text: "Move preflight ahead of candidate intent persistence in the implementation, preserving the project lock and read-only check."
    category: design
    why: "A setup omission must not create a pending candidate that blocks a later integration commit. After setup passes, candidate intent retains its crash-recovery ordering and the gate is still claimed once."
questions: []
challenges:
  - "Full live READY evidence without bch-cloak remains a supervisor release-candidate responsibility: this lane was explicitly forbidden to run the live harness or project release cycle. Offline tests verify five visible compatibility skips, readiness when the other cases pass, strict configured compatibility, and preservation of unrelated failures and pending results."
---

The major finding is resolved by moving preflight ahead of both `record release
cut` and `git tag`. A failed check retains its setup message and log without a new
candidate, tag, snapshot, gate claim/result, or shipping question. The regression
fails setup twice, advances main with a new commit, corrects setup, and verifies
that the later commit becomes a passing candidate rather than returning deferred.
A companion test verifies retry on the unchanged commit. Signal and launch-error
cases also create no candidate and remain retryable. Existing once-only gate,
interruption, tag integrity and operator-decision protections remain in place.

The minor finding is resolved by documenting that correcting setup cuts and gates
the current release base, including any intervening promotions. The guidance now
names setup logs by the proposed tag rather than a nonexistent candidate ID.
The earlier report is unchanged.

Validation logs were inspected for results and failures:

| Check | Result |
| --- | --- |
| Final `npm test` | 856 passed, 11 skipped, no failures or cancellations: copied entry 2; core 698 plus 11 skips; cycle 156 |
| `node test/helpers/run.mjs release/test/*.test.mjs` | 27 passed |
| `npm run test:fast` | 140 passed |
| `npm run test:acceptance` | 135 passed |
| `npm run test:lanes` | 160 passed |
| Isolated `promote/test/*.test.mjs` | 22 passed |
| `git diff --check` | Passed |

The baseline was invoked before edits; a diagnostic retry exposed sandbox
`ps EPERM` in fixture ownership checks. Host process inspection was approved for
the offline validations. The first host suite hit an unchanged promotion fixture
cleanup `ENOTEMPTY`; that file passed in isolation and both later full core runs.
The next full run caught a test helper parsing an empty event log as JSON. Filtering
empty lines fixed the helper; the release suite and final full suite then passed.
The previously timed-out discovery acceptance file passed in the final full run.
No cause is asserted for the inherited timeout.

No live harness, project release cycle, model call, or bch-cloak checkout mutation
was performed. No additional acceptance `--skip-live` pass was run. Release-cycle
calls in offline tests operate only on disposable fixture projects.

After checking and committing this report, the final operation is
`ORG_ACTOR=R-156 node lanes/lane.mjs check`. Its output is retained in
`/private/tmp/R-156-final-lane-check.log`; the lane evidence refers to the final
report commit. No tracked edits follow that check.
