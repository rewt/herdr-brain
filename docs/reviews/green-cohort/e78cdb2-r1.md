**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: e78cdb21898d8a64c3fec7eb4c4acde66c6629ca
Topic: green-cohort
Round: 1
Review ID: lr-14f21580e81b426fbc691272d0807d6c
Base branch: main
Base commit: 6e77270905ad0a6f3e01a82e317cc3c53d0c3a52

## Findings
- [Major] supervisor/test/green-main.test.mjs:99 - Round nine turned the real-main probe into a hard merge gate: the renderer case asserts admission by manifestScope with the committed manifest, which also runs checkDeployment against the live Node and Git executables and twenty live operator configuration files, and test/helpers/tier.mjs places this file in the promotion tier while the cycle suite also runs it, so after this lane lands any ordinary lane that edits, adds or deletes one of the 299 pinned runtime or configuration files without regenerating supervisor/green-contracts.json, any batch rebased onto such a change, and any host change such as a release switch that moves the installed current alias realpath, a fleet join or a record config edit makes the renderer case return GREEN\_REACH\_UNKNOWN and turns every promotion batch and release candidate red until a reviewed manifest refresh lands, converting boundary drift from lost green eligibility into stopped ordinary development, contrary to the ruling that drift and expiry return work to ordinary handling; Fix: keep the refusal controls and the hermetic regenerated-manifest admission asserted, but when the committed manifest no longer matches the tree under test or the deployment and external descriptors, skip the committed-pin admission with an explicit stale-manifest reason, or move that committed-pin probe out of the promotion tier and cycle suite into the supervisor pre-activation check, and add a case showing that an unrelated boundary edit leaves the suite green while green admission refuses.
- [Moderate] supervisor/GREEN-COHORT.md:57 - The activation procedure lets the supervisor enable green-pass after bootstrap PASS and a deployment check, but promote/guard.mjs:62 still refuses every existing-worker job unless the configured cohort is clean-pass and line 72 rechecks only cleanPassScope, while supervisor/autopilot.mjs:312 always enqueues green promotions with --existing-worker, so every admitted green candidate is refused at integration with a misleading AUTOPILOT\_DISABLED code; because the first green-activation note permanently fixes the only ten-day interim, activating before that guard is fixed irrecoverably spends the interim on a cohort that cannot land anything, and the README cohort paragraph describes green-pass as a pilot cohort without this limit; Fix: state in GREEN-COHORT.md step 4 and the README cohort paragraph that activation is blocked until the native-worker guard binds and rechecks reviewed green-pass identity, activation, manifest and scope at integration as filed in the ENG-445 follow-up, or land that guard change in this bootstrap lane with an offline native-worker integration witness.
- [Minor] supervisor/green-manifest.mjs:18 - recordedActivation accepts any note.added event whose text matches the activation pattern, on any item, without a decision flag or author check, as the cohort anchor, so a quoted or stray note written by any worker before the supervisor activation permanently becomes the first cohort activation, fixing the interim start or forcing all later digest notes onto that item, and after activation any actor can bind a refreshed digest on the anchor item without the documented supervisor re-review and canonical deployment check; Fix: count only decision notes on the item named by the reviewed manifest or bindings, and by the supervisor actor if the record exposes it reliably, for both the anchor and the digest evidence, and add a fixture in which an earlier non-decision or other-item note neither anchors nor binds.

## Re-executed
```json
[]
```

## Non-claims
- The supplied gate is inherited evidence; this review does not claim tests passed.
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.
- This review ran no build, test, prepare, install or check command; it used read-only Git inspection, including a whitespace diff check, and SHA-256 hashing of committed blobs and of the manifest-declared external inputs without importing product code.
- No claim is made about live autopilot, promotion, landing or release behaviour; the failure modes above are derived from reading the code.

## Unverified
- Test evidence not re-executed: supervisor/test/green-pass.test.mjs
- Test evidence not re-executed: supervisor/test/green-main.test.mjs
- Test evidence not re-executed: supervisor/test/autopilot.test.mjs
- Test evidence not re-executed: supervisor/test/supervisor.test.mjs
- Test evidence not re-executed: promote/test/evidence.test.mjs
- Test evidence not re-executed: test/fleet.test.mjs
- Test evidence not re-executed: test/tier-plan.test.mjs
- Report record-check validation not independently executed.
- Finding one end-to-end fixture: the supervisor fixture that queues deferred plus component checks, forces a train replay and handles completion through verifyTrainResult failed in the worker run at its first promote call with a fixture watcher ownership error, so none of its assertions were observed; only the direct verifyTrainResult cases and code reading support the train-proof change, and the fixture exercises the ordinary supervisor promote seam rather than the green-pass autopilot or native-worker guard path; supervisor judgment is needed.
- Retry inheritance fixtures: the not-queued fixture failed at its first promote call and the timeout fixture failed in its cleanup hook on the same watcher ownership check, so inheritance after not-queued and timeout rests on the refused-retry case and code reading.
- Worker combined run: 22 of 391 cases failed, the three new fixtures plus 19 existing autopilot and supervisor integration cases; attribution to process-ownership, native process-source and offline review-transport limits, and the unclassified assertion in the promoted queue notice case, was not independently confirmed; supervisor judgment is needed.
- Promotion gate environment: whether the gate Node executable, Git executable, PATH and environment selection match the committed manifest pins, which green-main now requires even for this lane's own batch, was not determined.
- Deployment context: whether production autopilot runs from the canonical checkout so that the green source-identity check and checkDeployment can admit anything was not exercised; the ruling item five demonstration with an independently reviewed candidate in the actual deployment remains outstanding.
- Lab binding: acceptance names the declared lab's canonical identities and records; the manifest leaves lab null because no lab is declared; supervisor confirmation is needed.
- Lifecycle acceptance: no lifecycle component is admitted; identity, HOLD, live-reference and recoverability controls are validated only against synthetic artifacts, and lifecycle eligibility is deferred to ENG-422.
- Release-wide suites, live acceptance and BCH seam checks per switch candidate were not exercised and remain supervisor-owned.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
