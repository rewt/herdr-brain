# R-575 correction evidence

Tested implementation: `5c039cff24afc161913c9f2f5e847b846441a3ba`, based on
main `6e77270905ad0a6f3e01a82e317cc3c53d0c3a52`. This addresses the round-11
ask and the supervisor's round-10 scope. The later evidence commit changes only
this evidence directory. Earlier reports and verdicts remain unchanged.

## Train fixture diagnosis and repair

The promotion assertion now includes the queue result's refusal reason and any
gate log. The first focused diagnosis observed `worktree is not clean` for the
canonical fixture checkout. A pre-drain clean-tree assertion then identified
`?? .org/`. The readiness stand-in bypassed real settlement's `ignoreRuntime`
preparation. It now calls that same helper on its private fixture project;
the strict clean-tree and promoted-result assertions remain intact.

The corrected focused test completed every assertion, including the forced
replay, required-check union, both checks executing, verifyTrainResult completion
and item closure: one selected test passed, zero failed, 26 unmatched tests skipped.
The command still exited 1 because the runner's final process-group audit refused
a native process snapshot with status 125 and `Operation not permitted`.
`train-diagnosis.json` preserves all three development stages without claiming
uncaptured source hashes for those uncommitted iterations.

This fixture exercises ordinary authorized supervisor enqueue and train completion.
It does not pass --existing-worker and does not establish green native-worker
integration. The refusal was caused by the fixture's missing runtime preparation,
not the clean-pass-only native-worker guard. `promote/guard.mjs` is unchanged.

## Merge-path and stale-input corrections

The real-main/deployment probe now requires HERDR_GREEN_ENABLE_PROBE=1 and is
absent from both promotion and cycle tier selection. GREEN-COHORT.md documents
the canonical enable-time command, the separate canonical deployment check, and
the requirement for actual admission without a stale/snapshot skip before enabling.
Ordinary release discovery can load the probe file but its default is an explicit
enable-time-only skip. The cohort stays disabled.

Pure offline controls moved to supervisor/test/green-manifest.test.mjs, which is
selected at promotion. Both that file and green-pass.test.mjs use fixed reviewed
renderer data rather than the live board implementation. Their manifests bind
the current test launchers and private fixture inputs, not the committed operator
deployment descriptors.

Shared stale detection now checks component shape and regular mode, every declared
validation file's presence and regular mode, and both consumer-evidence hashes
and modes before parsing the live renderer signature. New offline cases cover
renderer signature/range/deletion/mode drift, validation deletion/rename/mode drift,
confirmation changes/deletion and inventory changes. Each asserts refusal outside
the deliberately skipped admission-only subtest, then restores the reviewed inputs
and asserts admission. The product manifest checker also verifies the declared
consumer-evidence files in both committed trees, so an unchanged width candidate
cannot rely on drifted evidence.

The existing supervisor decision-note/stray-note activation fixture is preserved.
The actual manifest still binds item ENG-396 and actor supervisor-herdr.

## Enablement prerequisites and pins

The record's event 8823 dropped ENG-446 as a duplicate of ENG-445, explicitly naming
ENG-445 as the enablement precondition. GREEN-COHORT.md and the README explain that
consolidation and require both the guard work and the enable-time probes. No guard
implementation or activation is included here.

Only the README and tier selector's existing boundary hashes changed. The reviewed
launcher/environment/external descriptors were preserved. The separate read-only
deployment check refused the installed-current contrib/settle-watch.mjs descriptor
after the release alias moved; manifest-update.json records the refusal. Updating
those deployment pins needs ordinary review before enablement. It does not block
ordinary merge checks.

Independent review of this correction, native supervisor revalidation, the actual
reviewed-candidate deployment demonstration, ENG-445, lifecycle eligibility under
ENG-422 and release/live/BCH seam acceptance remain outside this lane's completion
claim. No native permissions, activation notes, release state, HOLD or shared
housekeeping schedule were changed.

## Combined validation

One combined run used Node 20.19.4 first in PATH, with HERDR_GREEN_ENABLE_PROBE
unset, at the committed implementation above:

```sh
node test/helpers/run.mjs --file-timeout=480000 --suite-timeout=540000 supervisor/test/green-pass.test.mjs supervisor/test/green-manifest.test.mjs supervisor/test/green-main.test.mjs supervisor/test/autopilot.test.mjs supervisor/test/supervisor.test.mjs promote/test/evidence.test.mjs test/tier-plan.test.mjs
```

Result: **421 tests, 399 passed, seven failed, fifteen intentional skips, zero
cancellations**, exit 1, 451.2 seconds. The combined run remains red. Fourteen skips
are deliberately stale committed-admission subtests whose enclosing offline tests
passed refusal and repaired-input admission assertions. One skip is the default
enable-time-only real-main probe. No live deployment probe was selected by the tier.

The repaired deferred/component train fixture passed in this committed combined
run as well as the focused development check. The required-component forwarding,
all three retry inheritance cases, activation and stray-note cases, every offline
manifest parent, direct train-proof cases and tier-plan cases passed.
No implementation changed after the combined run and it was not repeated.
No baseline, npm test, promotion/lanes suite, release or live acceptance ran.

required-tests.json preserves the exact command, head/tree/test hashes and lossless
stdout/stderr. correction-results.json records the relevant passes and all skip
reasons. failures.json preserves each failed TAP block. The failed cases are:

| Failed test | Observed stopping point |
| --- | --- |
| automatic PASS reaches the real queue, lands and closes without waking the supervisor | Explicit PROMOTE_NATIVE_PROCESS_SOURCE_REFUSED at anchor-worker startup |
| automatic PASS reaches the real queue, lands and closes without waking the supervisor with a non-blocking engineer proposal | Its bound promotion was explicitly refused by the native process source |
| real CLIs retry an exit-one base-moved refusal with the saved request and land once | Offline independent review transport did not complete; further attribution is unconfirmed |
| handle explicitly sends capped findings back once and adopts its saved correction | Fixture watcher shutdown snapshot unavailable |
| bound promotion rechecks queued runs and record changes during validation before integration | Fixture watcher ownership snapshot unavailable |
| late final reports recover completed promotion after lane closure and retain binding, integration and current-run guards | Fixture watcher ownership snapshot unavailable |
| late original and correction notices after lane removal preserve promotion guards and never replay settlement | Fixture watcher ownership snapshot unavailable |

The native process diagnostics report status 125 and Operation not permitted.
The other review-transport failure is retained separately and is not attributed
conclusively to the sandbox. No refused native operation was retried with changed
permissions or a different executor. The supervisor's outside-sandbox full-file
revalidation remains necessary; this engineer run does not claim it succeeded.
