**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: d70ddf7210ac4146fb083dd83537b6558c0e83cf
Topic: harness
Round: 1
Review ID: lr-bc936e4d03e869655046f08d1c01f1e5
Base branch: main
Base commit: ef661cfe8ea8d2e26ae48d15e53c20f1d75a7d8d

## Findings
- [Major] acceptance/test/validation.test.mjs:112 - The short temp correction exists only in this test's fleet registration. Live discovery retains its longer session HOME and default fleet temp, yielding a 76-byte per-run directory that exceeds the product's 60-byte limit. Cases 21 and 22 therefore retain a deterministic harness failure when native entry reaches temp creation; Fix: share confined short-temp initialization between the live harness and this regression, and cover the actual live session setup offline.
- [Major] acceptance/live-worker.mjs:16 - The installed entry is still launched with --add-dir for the session temp, but fresh discovery projects configure no extra roots. nativeSandboxLaunch rejects that argument before starting the native transport. The corrected validation regression calls createEntry directly and misses this startup failure; Fix: remove the unsupported extra-root argument from installed-entry launches, retain confinement through the supported temp grant, and add an offline regression using the real launch arguments and installed adapter.
- [Moderate] docs/reports/ENG-137-harness-20261003.md:38 - The report explicitly leaves the original case 27 focus change unattributed while declaring done with no blockers. The focused-tab guard addresses a possible cause without evidence connecting it to the required historical transition, so the cause-finding requirement remains incomplete; Fix: provide evidence-backed attribution and a regression for the actual cause, or mark this requirement as blocked and revise the completion claim accordingly.

## Re-executed
```json
[]
```

## Non-claims
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.
- The promotion tier remains deferred to the promotion batch; no independent CI execution is required by this review.

## Unverified
- Quiet-machine release acceptance is not established at the reviewed commit: the retained scratch pass has two failures before the final teardown revision, two excluded discovery cases, and five skipped compatibility cases. The zero-command review budget permits no new execution.
- The historical cause required for case 27 remains unverified; neither the report nor the retained focus trace connects it to the focused-tab change.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
