**PASS**
Schema: lane-review/v1
Reviewed commit: a3d6fcb128613c055590b980ad244acbb7e8b127
Topic: receipt-bridge
Round: 1
Review ID: lr-6e6162ce421a11d4937d56c7244391bd
Base branch: main
Base commit: 034461b2bded68c79c33299e6fc65be6c0dc0e3e

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
- No native run exists at the rebased head: the supervisor native log named in the ask, eng419-rebased.tap, was still absent at review time; the only native result for this lane is the pre-rebase run at edb66faf, which this review does not substitute for the rebased head.
- The worker's local focused run at the rebased head exited 1 with 33 failed cases in promote/test/exact-bridge.test.mjs and promote/test/train.test.mjs; 16 carry the explicit native process-source refusal, while the other 17 show the train refusing or stopping before a gate or test plan exists without naming a cause in their TAP excerpts, so they are not proven to be sandbox-only and need the promotion-tier batch run or a native rerun to settle.
- Test evidence not re-executed: promote/test/exact-bridge.test.mjs
- Test evidence not re-executed: promote/test/train.test.mjs
- Test evidence not re-executed: lanes/test/exact-validation.test.mjs
- Test evidence not re-executed: lanes/test/lane.test.mjs
- Test evidence not re-executed: test/contracts-conformance.test.mjs

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
