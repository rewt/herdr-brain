**PASS**
Schema: lane-review/v1
Reviewed commit: ca7de453713794972244882c33dbcaeeb8d35580
Topic: main-check
Round: 1
Review ID: lr-1af757c62e412116be25cdd30aabc955
Base branch: main
Base commit: 071070fb1aaf8b0a4d5dd15cea8d89428b9d180c

## Findings
None

## Re-executed
```json
[]
```

## Non-claims
- The supplied gate is inherited evidence; this review does not claim tests passed.
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.
- Deferred CI: the promotion tier runs on the merge batch before main moves; this review makes no claim about it.
- The deferred R-305 main and head host comparisons were not run by the lane or this review; their resolution rests on the recorded supervisor decision on ENG-260.

## Unverified
- Test evidence not re-executed: test/main-module.test.mjs
- Test evidence not re-executed: release/test/candidate.test.mjs
- Report record-check validation not independently executed.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
