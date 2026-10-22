**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: 2e9d8be5d82ef2d423a933e1c036e1535323797d
Topic: dispatch-test-split
Round: 1
Review ID: lr-bb8617fcb5aeda7a084f0ebd2d427742
Base branch: main
Base commit: 876f08b45a07ebfd01c4d9a8ab96203f0f45d674

## Findings
- [Moderate] dispatch/test/dispatch-recovery.test.mjs:55 - All four killed-coordinator cases call \`admissionHook\` and \`admissionAttempts\`, but neither helper is defined or imported here; both remain local to the admission test module. Each case will throw \`ReferenceError: admissionHook is not defined\` before exercising coordinator recovery, breaking the no-behavior-change requirement and the whole-file promotion gate; Fix: Move both unchanged helpers into \`dispatch-fixture.mjs\`, export them, and import them in both admission and recovery test modules without changing the test callbacks.

## Re-executed
```json
[]
```

## Non-claims
- The supplied gate is inherited evidence; this review does not claim tests passed.
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.
- Full post-split TAP listings and per-file elapsed times for the three native-source files are deferred to the promotion batch under L-43. Archived case-duration sums establish only the historical distribution of work.

## Unverified
- Test evidence not re-executed: dispatch/test/dispatch-admission.test.mjs.
- Test evidence not re-executed: dispatch/test/dispatch-recovery.test.mjs.
- Test evidence not re-executed: dispatch/test/dispatch-session.test.mjs.
- Test evidence not re-executed: promote/test/affected-tests.test.mjs.
- Test evidence not re-executed: settle/test/test-plan.test.mjs.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
