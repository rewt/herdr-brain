**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: 01ceac085c559212d6846476c1b6a777438f0268
Topic: rev465
Round: 1
Review ID: lr-77dccdf98ef62d3822c66382d9081d39
Base branch: main
Base commit: 27e63f3bae961a00c9373a9a0f777f3f37bb0a3e

## Findings
- [Moderate] test-slot/test-slot.mjs:405 - the new caller watch calls processState every 100 ms for the whole gate, and while the caller lives that runs processStartRecord, which on darwin re-hashes the bundled helper and spawnSyncs it (on linux it spawns getconf), so every slot run (train gate, host-gate wrapper, direct promote, release) adds roughly ten blocking process spawns per second per wrapper during the heaviest host load, and each blocking lookup also delays the wrapper's signal forwarding; Fix: make the per-tick check cheap (kill-zero probe plus comparing the live parent pid against caller.pid, since the wrapper is the caller's direct spawnSync child) and run the identity lookup only when that cheap check indicates the caller may be gone, or poll identity at a much lower rate.
- [Minor] test-slot/run.mjs:16 - runTestSlotSync now calls processStartRecord in the caller and lets its exception escape, so a transient process-source failure that the wrapper previously reported as the coded REFUSED\_EXIT refusal now surfaces from validateTree as an uncoded error, and direct promote fails with exit 1 instead of the retryable exit 75; Fix: catch the caller-identity failure in runTestSlotSync and either omit the caller option or return the same REFUSED\_EXIT-shaped result the wrapper gives for unknown identity, with a test for that path.
- [Minor] test-slot/test/conformance.test.mjs:11 - the timeout variants only send the same SIGTERM 100 ms later than the cancel variants, so no timeout mechanism (for example a spawnSync timeout killing the wrapper) is exercised and the report's timeout evidence is a renamed cancel test; Fix: drive the timeout cases through runTestSlotSync with a short timeout option and assert the compound descendant receives the signal, or rename them and state in the report that the train gate has no timeout of its own.
- [Minor] promote/metrics.mjs:197 - gate\_profiles time\_s silently changed from completed-gate durations to all executed durations including interruptions and dirty executions, which contradicts the summary gate\_time\_s semantics and the README statement that completed gate time is retained; Fix: keep profile time\_s on completed gates and add a separate executed\_time\_s per profile, or document the changed meaning in promote/README.md.
- [Minor] promote/test/conformance.test.mjs:91 - the concurrent-log test uses two different trees, which already had distinct keys and logs on base, so it cannot fail first, and its mutual-overlap timestamp assertions depend on both 200 ms gates starting before the other finishes, which is load-sensitive; Fix: drop or relax the overlap assertions (assert distinct logs and intact contents only) and label the test as a boundary probe rather than collision evidence.

## Re-executed
```json
[]
```

## Non-claims
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.
- The inherited gate at captured HEAD is the fast tier (15 files, 178 of 178 passing); it contains none of the new or changed promote, test-slot or validation tests, so it is not evidence for the five checks.

## Unverified
- The report says the user approved changing lanes/validation.mjs although the ask limited files to promote/ and test-slot/; the repository holds no evidence of that approval.
- The report's focused results (105, 74 and 7 passing cases) and the red-first witnesses were not re-executed under the zero-command budget; only the committed TAP files were read.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
