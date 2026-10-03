**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: e0da4e378088036d4629c8e6e9322a037ee97da1
Topic: train-recovery
Round: 1
Review ID: lr-f205f4b8be324017ee00b401aa369c7d
Base branch: main
Base commit: eb710c0782e2d86e47d6bdc6977387888528d259

## Findings
- [Moderate] settle/settle.mjs:529 - ENG-139's added scope requires settlement to resume after a transient record precondition clears, but an \`Another run is open\` escalation is still saved as \`complete\`. This retry condition excludes it, and the completed-stage branch returns the saved refusal without rechecking readiness, so clearing the blocking run cannot recover settlement; Fix: distinguish transient record refusals from terminal escalations, retain or restore their originating stage under the normal identity, report, supersession and readiness checks, support existing completed refusal receipts, and add a regression that clears an older overlapping run and proves exactly one review on retry.

## Re-executed
```json
[]
```

## Non-claims
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.
- The inherited gate and committed worker TAP artifacts were inspected as historical evidence only. Promotion-tier CI remains deferred to the promotion batch.

## Unverified
- ENG-139's added requirement to resume settlement after a transient record precondition clears has no implementation or regression evidence in this delta; the concrete terminal-receipt defect is identified in Findings.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
