**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: 2f6cfd52767b3fb1eaf4c18fa3a3f662b78cd0b6
Topic: supervisor-module
Round: 1
Review ID: lr-b2911c95b6777b43b6081d15ebdfbb1f
Base branch: main
Base commit: 33ab6b2c1f08e8064c52f3f411d75e6cffd8ae84

## Findings
- [Moderate] supervisor/supervisor.mjs:105 - After successful queue promotion removes the lane, a delayed duplicate final report notice still invokes settle, which resolves the deleted workspace before reading its completed receipt and exits with ENOENT. This breaks the documented duplicate-notice recovery and turns completed work into a manual error handoff; Fix: recognize completed promotion from the bound supervisor and queue receipts before invoking settle, preserve current-run and integrated-head checks, and add a duplicate final-report case after lane closure.
- [Moderate] discovery/policy.mjs:30 - Replacing the supervisor entry text removes the watch entrypoint string still required by the release harness's supervisor-entry assertion at line 275. An untouched project's new policy cannot satisfy that assertion, so the existing release gate reports failure despite successful bootstrap; Fix: update the release entry assertion to verify the new cold-start and notice-handler contract, and cover that same assertion in the offline entry tests.

## Re-executed
```json
[]
```

## Non-claims
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.
- Live model behavior, actual operator chat clearing, and release or bch-cloak cutover are not established by the scripted evidence.
- Completion of the optional full lane suite is not established; the worker explicitly reports that it was interrupted.

## Unverified
- Duplicate final-report handling after promotion and lane removal has no inherited regression coverage; the zero-command budget prevents an execution witness for the source-level failure.
- The release harness's existing supervisor-entry case is outside the inherited npm gate and was not executed; the zero-command budget prevents confirming its policy assertion failure by execution.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
