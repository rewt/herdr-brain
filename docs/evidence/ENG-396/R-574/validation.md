# R-574 correction evidence

This corrects the three findings in `docs/reviews/green-cohort/e78cdb2-r1.md`.
The tested implementation is `6ea67f261226ef8fd5cce46b72298cb7a6a76f4a`, based on
main `6e77270905ad0a6f3e01a82e317cc3c53d0c3a52`. The later evidence commit changes
only this evidence directory. The previous reports and evidence are preserved.

| Finding | Correction and observed witness |
| --- | --- |
| Stale committed manifest blocks ordinary development | The real-main probe checks for stale boundary inventory, modes, bytes and deployment descriptors. It asserts that green admission refuses, then skips only the committed-pin admission subtest with the explicit stale reason. Refusal controls still run. Four hermetic fixtures cover ordinary changes, deletion, addition and external configuration drift; their parent tests assert refusal, observe the admission-only skip, then assert admission after an ordinary refresh and refusal of a new execution edge. All passed. |
| Activation can spend the interim before native-worker integration works | Step 4 of GREEN-COHORT.md and the README cohort paragraph explicitly block both activation and the first activation note on ENG-445. That follow-up must bind and recheck reviewed green-pass identity, activation, manifest and scope at integration. This correction takes the review's documentation option; the existing clean-pass native-worker guard is preserved. |
| Stray notes can anchor or bind activation | The reviewed manifest now names activation item ENG-396 and actor supervisor-herdr. Both the first anchor and each digest note must be decision notes on that item by that actor; unattributed notes are excluded. The new fixture places non-decision, other-item and other-actor notes before legitimate activation and again before digest evidence. They neither anchor nor bind. The existing refreshed-manifest fixture also passed with its original event id and exact expiry boundary. |

`manifest-generation.json` records 299 boundary inputs, twenty unchanged external
descriptors, the exact activation binding and a successful deployment check against
the lane's working bytes. Only the README boundary pin changed. This is review input;
the canonical deployment check and ENG-445 remain activation prerequisites.

## Required run

One combined run used Node 20.19.4 first in PATH and the requested runner:

```sh
node test/helpers/run.mjs --file-timeout=480000 --suite-timeout=540000 supervisor/test/green-pass.test.mjs supervisor/test/autopilot.test.mjs supervisor/test/supervisor.test.mjs promote/test/evidence.test.mjs supervisor/test/green-main.test.mjs test/fleet.test.mjs test/tier-plan.test.mjs
```

Result: **435 tests, 419 passed, 12 failed, four expected skips, no cancellations**;
exit 1, 300.6 seconds. The combined run remains red. All green-pass and real-main
parent tests, direct train-proof tests, fleet tests and tier-plan tests passed.
The four skips are the deliberately stale committed-pin subtests; their enclosing
fixtures passed refusal and refreshed-manifest admission assertions. The actual
committed-main renderer admission passed without a skip.

`required-tests.json` preserves the exact command, source head/tree/test hashes and
lossless stdout/stderr. `failures.json` preserves every failed TAP block.
`correction-results.json` records the relevant fixture results.
`prior-failure-results.json` compares the 22 failures from R-573: fifteen now passed
and seven failed again. No suite was repeated and no implementation changed after
the run. No baseline, npm test, promotion/lanes suite, release or live acceptance ran.

The supplied R-573 validation log contains only the ordinary deferral notice that
no matching worker gate receipt existed. It is not a failed promotion gate. This
run supplies focused execution evidence and does not fabricate a promotion receipt.

## Native process verification limits, by test

The runner logged native process snapshots refused with status 125 and
`Operation not permitted`. A read-only probe before the run succeeded; these
refusals were intermittent. Nine cases failed at fixture watcher ownership
verification, one at fixture queue-shutdown verification, and two at an explicit
`PROMOTE_NATIVE_PROCESS_SOURCE_REFUSED` during anchor-worker startup. These checks
were retained. No native permissions or ownership controls were changed.

| Failed test | Observed stopping point |
| --- | --- |
| awaited promotion closes before waking with one short plan line and later notices stay silent | Fixture watcher ownership snapshot unavailable |
| legacy uncertain promotion receipts still forbid command replay after the key upgrade | Fixture watcher ownership snapshot unavailable in cleanup |
| automatic PASS reaches the real queue, lands and closes without waking the supervisor with deferred test evidence and ingest proof: - The report says it passed `record check` before being committed; that step leaves no in-repository receipt, so this review could not confirm it. | Fixture queue shutdown snapshot unavailable in cleanup |
| a worker exiting after autopilot precheck leaves a confirmed no-op that bare promotion can recover | Anchor-worker startup explicitly refused by the native process source |
| automatic queue promotes its own non-blocking report proposal | Fixture watcher ownership snapshot unavailable |
| automatic queue rechecks stale-PASS at final integration | Anchor-worker startup explicitly refused by the native process source |
| automatic queue rechecks pause at final integration | Fixture watcher ownership snapshot unavailable in cleanup |
| green-pass promotion replays deferred and component checks and verifies train completion | Fixture watcher ownership snapshot unavailable at the first promote call |
| supervisor binds head and run into the queue and retries confirmed refusals with history | Fixture watcher ownership snapshot unavailable after drain |
| bound promotion rechecks queued runs and record changes during validation before integration | Fixture watcher ownership snapshot unavailable |
| late final reports recover completed promotion after lane closure and retain binding, integration and current-run guards | Fixture watcher ownership snapshot unavailable |
| supervisor entry and final notices carry the unconfigured cycle through actual promotion | Fixture watcher ownership snapshot unavailable in cleanup |

The end-to-end deferred/component train replay is still unconfirmed; its first
promote call did not complete fixture ownership verification. The direct
verifyTrainResult cases, required-component queue forwarding, and all three
not-queued/refused/timeout inheritance fixtures passed. They do not replace that
end-to-end witness or establish green native-worker integration readiness.

## Committed-main evidence and remaining acceptance

`main-controls.json` binds the admitted renderer's exact bytes to the committed
manifest digest `1d2c60f1cbbca75b7875229f44c0f3ba2437a58ff0a93d3487cb031d562843ff`.
It reads 299 actual main boundary inputs; 291 remain inherited unchanged from main.
The one-line default-width change to 121 passed containment and executed its exact
candidate bytes with default width, explicit width 80 and height 1. BCH entry,
promotion authority, both selectors, manifest, boundary edit, expanded execution
edge, missing boundary and foreign project all refused.

This is engineer containment evidence, not independent acceptance or the ruling's
reviewed-candidate demonstration in the actual deployment. ENG-445 still blocks
activation; ENG-422 still owns useful lifecycle eligibility. The lab slot remains
null as previously established. Independent bootstrap/ready review, canonical
deployment acceptance, and release-wide/live/BCH seam checks remain supervisor work.
This lane wrote no activation note, enabled no cohort, changed no native settings,
lifted no HOLD, started no shared housekeeping loop and performed no release/push.
