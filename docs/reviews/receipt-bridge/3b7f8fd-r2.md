**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: 3b7f8fd9b631c92a00a671968b8b8ccb6e8998cd
Topic: receipt-bridge
Round: 2
Review ID: lr-d55494a7267ae22c41683110132f1020
Base branch: main
Base commit: 468c824d9dbfd52a35b0211cda6b856362f36e64

## Findings
- [Moderate] lanes/lane.mjs:217 - \`lane check --gate\` calls canonicalTestPlan without any bound required tests, while the train passes the union of each job's \`requiredTests\` to the same planner (promote/train.mjs:242 and :400); supervised promotions carry non-empty required tests from settle deferred evidence (supervisor/supervisor.mjs:222, supervisor/autopilot.mjs:312) and from green-pass manifests (supervisor/green-manifest.mjs:232), and the herdr-brain planner places required files first in \`files\`, so the planned command string differs and those promotions always miss on \`commands\`; the contract states that lane check builds the train's exact command and does not disclose this case; Fix: let \`lane check --gate\` accept the same validated \`--required-tests\` JSON list that promote accepts and pass it as \`required\` to canonicalTestPlan (or record it in the gate for the train to compare), document in docs/contracts/exact-validation.md that bound required tests are part of the command input, and add a fixture where a job with required tests reuses when the lane check was given the same list and misses with \`commands\` when it was not
- [Minor] promote/train.mjs:416 - for a single-lane miss the diagnostic compares against the raw \`.lane/gate.json\` object, so a missing pointer or a legacy gate written by plain \`lane check\` (no \`exact.identity\`) makes explainMiss return \`repo\`, which misreports an unchanged repository as the differing field and contradicts the documented fixed-order diagnosis; Fix: when the pointer is absent or has no \`exact.identity\`, record \`field: candidate\` (the documented fallback) or an explicit pointer-unavailable marker instead of calling explainMiss, document that case in the contract, and add a fixture for the missing and legacy pointer cases

## Re-executed
```json
[]
```

## Non-claims
- The supplied gate is inherited evidence; this review does not claim tests passed.
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.

## Unverified
- Report record-check validation not independently executed.
- Test evidence not re-executed: lanes/test/exact-validation.test.mjs.
- Test evidence not re-executed: promote/test/exact-bridge.test.mjs.
- Test evidence not re-executed: test/contracts-conformance.test.mjs.
- Test evidence not re-executed: lanes/test/validation.test.mjs.
- Test evidence not re-executed: promote/test/train.test.mjs.
- Acceptance that existing lanes/test/validation.test.mjs and promote/test/train.test.mjs remain green with no declaration is not evidenced: the worker's own focused pass recorded 20 failures, 17 of them existing train cases, and only some carry an explicit native process-inventory or EMFILE cause, so a regression cannot be excluded from the retained artifacts; code reading found the undeclared path changes only an extra git cat-file lookup.
- The changed-candidate integration fixture (content change misses with field candidate and runs once through a drain) was refused by the native process-inventory guard before execution and has no observed end-to-end result; only the validateTree-level unit case covers it.
- The settle gate is missing at the captured head (no worker validation receipt); the promotion tier on the batch is the first merge check for this change.
- Allowlisted-environment execution as a behaviour change is stated in the contract but awaits the planned T2 ruling; this review does not settle that policy question.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
