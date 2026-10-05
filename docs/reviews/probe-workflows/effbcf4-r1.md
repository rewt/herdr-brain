**PASS**
Schema: lane-review/v1
Reviewed commit: effbcf486310d226d39909184295c5c7e1d54779
Topic: probe-workflows
Round: 1
Review ID: lr-49c427bb28d32868040febe95964045b
Base branch: main
Base commit: 32e2d78a7436fa6d8811ed403243fd2796ea9b6d

## Findings
None

## Re-executed
```json
[]
```

## Non-claims
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.
- The promotion tier, which now selects the three new copied-train regressions in promote/test/workflow-train.test.mjs, is deferred to the promotion queue batch and is not claimed here.
- The worker's org check of the report and the final lane check were not re-run; the only gate evidence is the inherited test:fast gate at the captured HEAD with exit 0 and 178 of 178 passing.
- The committed TAP evidence for both copied probes, the 95 promote tests and the 53 opt-in tests was read as worker evidence, not re-executed.

## Unverified
None

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
