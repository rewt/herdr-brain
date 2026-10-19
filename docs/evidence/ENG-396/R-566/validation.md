# Containment manifest validation

R-566 implementation: `0251dc51ea9b486c628081350822742a51718ec3` on
`lane/green-cohort`, rebased first onto real main
`264dc43c88bfefd5d5becd775ec242198ba2e6fd`.

The governing ask was Astra's amended option 3, dated 2026-10-18. The user
clarified during this run that no lab exists: bind the canonical Brain checkout
`/Users/rewt/development/rewt/herdr-brain`, Git identity ending in
`herdr-brain/.git`, record `/Users/rewt/development/rewt/.org`, and leave lab null.
Adding a lab later requires an ordinary reviewed manifest change.

The initial component profile allows only render()'s numeric default width
(80..240) in `board/render.mjs`; all other module bytes are bound. The manifest
freezes 298 runtime/configuration files, bootstrap authority, actual mutable BCH
entry, promotion authority, external configuration and launchers. No lifecycle
component qualifies; ENG-422 remains the existing extraction follow-up. The
cohort is disabled and this evidence grants no independent bootstrap PASS.

## Required single combined run

`required-tests.json` preserves the exact command, source hashes and lossless
runner output. Node 20.19.4, through the requested bounded runner and timeout
flags: cohort, real-main, unchanged autopilot, board view and tier-plan checks.
357 passed; zero failures, cancellations or skips; 340282.58525 ms. No baseline,
full npm suite, promotion/release suite, live acceptance or load generator ran.

After that run, the environment fingerprint was widened to all Git/Node/loader
selectors and Git system/global/identity configuration pins were added. A full
Git-object proof then exposed a binary-pinning bug: native launchers had been
hashed after UTF-8 decoding. `first-real-candidate.json` preserves the refusal.
The correction hashes raw Git and filesystem bytes for frozen inputs; executable
candidate edits are still excluded. Text decoding remains strict for source,
policy and evidence. `0251dc51` contains the correction and its focused regression.

## Focused validation of final code

`final-focused.json` records only the new raw-binary/Git-selector case and the
real-main probe: 2 passed, 0 failed/cancelled, 212 intentionally unselected cases;
4683.982542 ms. The combined suites were not repeated. This verifies the final
checker after the post-suite changes rather than treating the earlier run as
validation of untested edits. `final-main-probe.json` supersedes the earlier
in-memory probe (retained as `main-probe.json`).

`real-candidates.json` goes further: actual committed worktrees sharing Brain's
canonical Git identity and discovered record, based on main plus the ordinary
bootstrap implementation above. The renderer bytes are exactly main's renderer
with one line changing width 120 to 121. Full `greenPassScope`, including identity,
policy bytes, clean Git state, raw boundary versions, environment and external
configuration, admits it. The exact committed renderer also executes successfully
with default width 121 and explicit width 80. The validation script and command
are losslessly saved in `real-candidate-command.json`.

| Actual committed/control operation | Result |
| --- | --- |
| Renderer default width 120 to 121 | eligible |
| Changed GIT_CONFIG_SYSTEM | GREEN_REACH_UNKNOWN |
| Added Git environment selector | GREEN_REACH_UNKNOWN |
| Restored environment, same renderer | eligible |
| BCH reconcile entry edit | GREEN_BCH_CONSUMED |
| Promotion runner edit | GREEN_SELF_AUTHORITY |
| Manifest edit | GREEN_SELF_AUTHORITY |
| Bound rows dependency edit | GREEN_BOUNDARY_CHANGED |
| Target actual BCH canonical project/record | GREEN_IDENTITY_MISMATCH |
| Expired activation binding | GREEN_EXPIRED |

No actual deployment config or record was written by those checks. The hypothetical
activation timestamp is only an argument to read-only eligibility. No independent
ready review or promotion is asserted. The temporary worktrees were removed only
when clean, with all committed proof branches retained. `proof/R-566-renderer`
preserves the initial refused attempt; the five `proof/R-566-final-*` branches
preserve the successful renderer and refusal-control commits. Exact heads appear
in the receipts. Main itself was unchanged by this work.

## Deployment and review limits

Supervisor-herdr owns ordinary bootstrap, independent implementation/security
review, deployment acceptance, and later activation. Reconfirm BCH's actual
consumers and external configuration versions; ordinary changes to these inputs
invalidate admission immediately and need a reviewed manifest refresh. The
interim expires ten days from activation, or on replacement by the reviewed
successor, whichever happens first. Release suites, acceptance and BCH seam
checks remain once per switch candidate under the supervisor's existing route.
The renderer demonstration makes no claim of lifecycle eligibility.
