**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: 0fb4dfc243336166cc54ce17541876144aa795c7
Topic: test-hangs
Round: 1
Review ID: lr-b634851db550856bea4d59a2b729c31c
Base branch: main
Base commit: 33ab6b2c1f08e8064c52f3f411d75e6cffd8ae84

## Findings
- [Major] dispatch/test/dispatch.test.mjs:75 - Receipt cleanup can adopt and kill an unrelated replacement process. If a watcher exits and its PID is reused before rememberProcesses first reads its receipt, registerProcess captures the replacement's identity; the later fresh comparison then authorizes SIGKILL against that replacement. The housekeeping start helper likewise registers lock-file PIDs without proving fixture ownership; Fix: capture each child's birth tuple while its launcher still owns it, or require a verified suite-group and fixture-command match before adopting a receipt PID; preserve the original identity across retries and add reuse-before-registration coverage for both helpers.

## Re-executed
```json
[]
```

## Non-claims
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.
- The finding follows from source inspection. Historical validation logs and negative-control artifacts were read, not executed by this reviewer.

## Unverified
- Safe cleanup when a watcher PID is reused before its receipt is first registered lacks a covering regression in the inspected tests; the zero-command budget prohibited executing that scenario or a mutation witness.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
