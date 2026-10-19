# R-570 review corrections and validation

The correction implements all eight findings in `docs/reviews/green-cohort/7ece822-r1.md`.
The cohort stays disabled: canonical configuration still selects `clean-pass`.
No native settings, release selection, BCH source or deployment settings changed.

- The real-main probe reads pins and trusted bytes from the same complete HEAD
  tree. It no longer mixes an explicit file overlay with unrelated on-disk bytes.
  Committed unrelated-file changes and deletions both pass. Fixtures also tolerate
  a previously admitted renderer width, including the upper bound of 240.
- Missing Git work trees and missing `main` refs return the established
  `no Git work tree (release snapshot)` skip. No live record is discovered.
- Session environment hashes were replaced by a readable policy: absent Node and
  native loader injection; explicit HOME/XDG/fleet selection; stripped GIT_, NODE_,
  DYLD_, LD_ and ORG_ child selectors; reviewed Node/Git launchers. Two discovery
  functions now honor their explicit environment in internal Git lookups.
  Inherited Git repository/config selectors and Node REPL keys no longer reject
  the same safe candidate; active loader injection still refuses.
- `.lane.validation.json`, `.promotion-selector.json` and `package.json` are
  promotion authority in both the manifest and the self-authority exclusions.
- BCH owner bastian confirmed five command entries and five imported APIs.
  The installed release is its current configured reconcile root. Manual
  HERDR_BRAIN_ROOT and explicit reuse request.brain remain alternate selectors.
  The manifest and contract bind the owner evidence, event 21749 on G-24, source
  revision, hashes and limits. All 82 packet checksums verified; local copies match.
- Component validation returns as requiredTests, through real autopilot scope,
  supervisor promotion and the real queue. The train's existing required-test
  planner cannot defer it by file/time budget. Existing settlement test evidence
  is unioned with component requirements; acknowledged receipts cannot silently
  satisfy newly supplied requirements.
- Real createGreenCohort fixtures exercise autopilot admission, GREEN_ refusal,
  report/run/reportRoot/binding forwarding, configuration changes before promote,
  and rejection of green settings under clean-pass. Review and queue executors are
  offline stand-ins; identity and scope are real. A separate actual supervisor CLI
  check exercises required-test forwarding into a real fixture queue through the
  existing settle-cli readiness seam, without requiring review transport.
- Activation requires the first append-only note whose exact text is
  `green-activation/v1 MANIFEST_SHA256`, in the trusted Brain record. The first
  note's event time must equal configuration activatedAt. Later notes/config resets
  cannot extend the ten days. Admission never writes the event log.

## Executed evidence

All test commands used Node v20.19.4 first in PATH and the requested bounded
runner with --file-timeout=480000 --suite-timeout=540000. No baseline, npm test,
promotion suite, lanes suite, release, acceptance run or load generator ran.

1. `required-tests.json`: the single combined cohort/autopilot run plus relevant
   supervisor, renderer and tier checks: 393 tests, 372 passed, 21 failed,
   zero cancellations/skips. Two new green failures were corrected: internal
   discovery ignored sanitized Git environment, and a new test expected BCH
   classification where the established shared-runtime exclusion takes precedence.
2. `final-focused.json`: 51 passed, 1 failed, 230 intentionally unselected.
   Every selected green, main, identity, activation and fleet-discovery case
   passed. The sole failure was the new forwarding fixture's unrelated native
   review transport not completing. The fixture now uses the existing settle-cli
   readiness seam, while retaining the actual supervisor CLI and real queue.
3. `queue-forwarding-first.json` records a missing import in that revised fixture;
   it was corrected. `queue-forwarding.json`: 1 passed, 22 intentionally unselected,
   no failures. This covers the final supervisor forwarding test bytes.
4. `release-snapshots.json`: an archive of the captured head plus the complete final
   working overlay. With no Git work tree the probe skipped and the runner exited
   zero. With Git initialized and no main ref the probe also skipped with zero
   test failures; the runner exited one during native process-source cleanup with
   Operation not permitted. This second result proves guard behavior, not a green
   process exit. No permission workaround or retry of that native refusal ran.
5. `main-controls.json`: lossless extracted real Git main/HEAD containment evidence,
   exact candidate/module hashes, validation and admission/refusal outcomes. The
   same probe passes for unrelated pinned-file changes/deletions and widths
   121/240 in scratch committed checkouts.

## Validation limits

The initial combined run's other 19 failures remain visible in
`initial-failures.json`: ten watcher-ownership failures, four cases whose captured
output contains explicit native process-source EPERM, four incomplete independent
fixture reviews, and one delivery/integration result without a conclusive cause.
Some classifications overlap (for example cleanup can fail after another primary
assertion). No claim is made that all 19 have a single cause or that the full
combined run passed. Failed review scratch logs were already removed where fixture
cleanup completed. Tests that passed were not replayed to manufacture a green run.
The shell's own optional ps diagnostic was also natively refused. No process was
signalled or cleaned up without verified ownership, and no native permissions were
changed. The supervisor's ordinary promotion/release checks remain required.

`R-566.validation.log` is informational inherited evidence: no worker gate receipt
was present at its captured tree; the promotion queue runs the integration tier.
The direct focused commands here have durable lossless output and source hashes;
this report does not invent a lane-validation receipt or claim the promotion gate
ran in this lane.

Ordinary independent implementation/security review, an exact independently
reviewed candidate in the actual deployment context before enablement, release
suites/live acceptance/BCH seam checks at a switch, and genuine lifecycle evidence
remain supervisor-owned. No lab exists in the supplied deployment context; the
manifest keeps lab null. No lifecycle component is admitted (ENG-422 remains).
