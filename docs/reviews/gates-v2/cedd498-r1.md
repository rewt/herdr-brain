**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: cedd498e3e352f33c3142e3416d890c9dfe66db9
Topic: gates-v2
Round: 1
Review ID: lr-a9213fc442b3378cc6b8f829fce3a602
Base branch: main
Base commit: 36783500f842847379654ec02d0bb414e2a94453

## Findings
- [Major] promote/gate-profile.mjs:49 - Host/profile entry points still call audited \`readDeclared\` before \`executionIdentity\`. With an unaudited config-home edit or pending write, a foreign caller can append or recover target record events before refusal. The direct host CLI also writes \`native\_context\` to the train before reaching this fence; Fix: perform side-effect-free mode detection and validate caller/project and captured identity bindings before audited reads or receipt writes in the profile, adapter and direct host entry paths, and add foreign-caller controls that preserve target record and receipt bytes.
- [Major] promote/train.mjs:420 - Integration-time rechecking can execute probes or a previously reused gate after \`canonicalReady\` has checked the canonical checkout. Its execution guard compares canonical HEAD but does not check canonical branch or cleanliness, and the final promotion guards do not restore those checks. A switch to another branch at the same commit can therefore redirect the fast-forward, while unrelated dirty content can remain during integration; Fix: revalidate canonical branch, cleanliness and captured base after the recheck and immediately before fast-forward, with late-recheck branch-switch and dirty-checkout controls.
- [Moderate] promote/evidence.mjs:63 - A validated zero-exit attempt is treated as integrated when deciding whether a final refusal can recover. If the canonical checkout becomes dirty during validation, \`canonicalReady\` records a final refusal but leaves the attempt validated. On restart the refusal path is excluded, containment fails because no fast-forward occurred, and completed batch recovery throws even after the checkout is cleaned; Fix: distinguish a validated attempt from proven integration when recovering final refusals, retain the lost-fast-forward proof path, and add a crash recovery control for a canonical refusal after successful validation.

## Re-executed
```json
[]
```

## Non-claims
- The supplied gate is inherited evidence; this review does not claim tests passed.
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.
- The sandbox-only failure classification is inherited from the operator's rule and is not an independent runtime diagnosis.
- Deferred promotion CI is not an unresolved review requirement; release execution, project adoption and project pilots are not claimed.

## Unverified
- Test evidence not re-executed: lanes/test/declared-validation.test.mjs
- Test evidence not re-executed: promote/test/declared-gates.test.mjs
- Test evidence not re-executed: promote/test/declared-train.test.mjs
- Test evidence not re-executed: promote/test/declared-mixed.test.mjs
- Test evidence not re-executed: settle/test/declared-plan.test.mjs
- Test evidence not re-executed: promote/test/promote.test.mjs
- Test evidence not re-executed: promote/test/train.test.mjs
- Test evidence not re-executed: promote/test/workflow-train.test.mjs
- Test evidence not re-executed: promote/test/affected-tests.test.mjs
- Test evidence not re-executed: promote/test/exact-bridge.test.mjs
- Test evidence not re-executed: promote/test/evidence.test.mjs
- Test evidence not re-executed: promote/test/metrics-profile.test.mjs
- Test evidence not re-executed: promote/test/metrics.test.mjs
- Test evidence not re-executed: promote/test/memory-gate.test.mjs
- Test evidence not re-executed: promote/test/selector-log.test.mjs
- Test evidence not re-executed: promote/test/completion.test.mjs
- Test evidence not re-executed: promote/test/completion-recovery.test.mjs
- Test evidence not re-executed: lanes/test/validation.test.mjs
- Test evidence not re-executed: lanes/test/exact-validation.test.mjs
- Test evidence not re-executed: settle/test/test-plan.test.mjs
- Test evidence not re-executed: settle/test/test-evidence.test.mjs
- Test evidence not re-executed: settle/test/train.test.mjs
- Test evidence not re-executed: supervisor/test/supervisor.test.mjs
- Test evidence not re-executed: test/config-policy.test.mjs
- Test evidence not re-executed: test/config-home.test.mjs
- Test evidence not re-executed: test/formats.test.mjs
- Test evidence not re-executed: test/record-guard.test.mjs
- Test evidence not re-executed: test/release-pin-precheck.test.mjs
- Test evidence not re-executed: test/board-brain.test.mjs
- Test evidence not re-executed: test/main-module.test.mjs
- Refusal before target effects through direct host/profile entry points lacks a supplied witness.
- Canonical branch and cleanliness enforcement after integration-time reuse rechecking lacks a supplied witness.
- Terminal refusal recovery after a dirty canonical checkout stops a validated attempt lacks a supplied witness.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
