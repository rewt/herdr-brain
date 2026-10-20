**PASS**
Schema: lane-review/v1
Reviewed commit: d8fedc5c82ce0d4337625b761be11e7d7ec6e141
Topic: receipt-bridge
Round: 1
Review ID: lr-af57c3153bbd3673051ad669598b59b0
Base branch: main
Base commit: 468c824d9dbfd52a35b0211cda6b856362f36e64

## Findings
None

## Re-executed
```json
[]
```

## Non-claims
- The supplied gate is inherited evidence; this review does not claim tests passed.
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.

## Unverified
- Report record-check validation not independently executed.
- Test evidence not re-executed: lanes/test/lane.test.mjs.
- The worker's only whole-file pass of lanes/test/lane.test.mjs ran before the final help-layout correction and recorded one failure in the usage case; after the correction only that usage case was re-run by name, so no whole-file result exists at the reviewed head for the other 71 cases.
- The settle gate is missing at the captured head (no worker validation receipt); the promotion tier on the batch is the first merge check for this change.
- Earlier-round items not touched by this fix round remain open as recorded in the 539aa06-r1 review: unexplained existing train case failures in worker passes, integration cases refused by the process-inventory guard or EMFILE, the supervised required-tests workflow gap, and the pending T2 ruling on allowlisted-environment execution.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
