**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: be4f5da8333a0ae85abc6ebf7ff32155fbe56177
Topic: memory-before-locks
Round: 1
Review ID: lr-b0440e1ffafae84e234f75f16ab52e4d
Base branch: main
Base commit: ef21d58ed7441cf6c7a0c90f66cd2abb5e08ddca

## Findings
- [Moderate] promote/host-gate.mjs:49 - The new STOP check in the host adapter's initial memory wait (and the held re-checks at lines 76 and 93) refuses a declared-profile batch whose train receipt already has attempts before lane promote-batch can run, so performBatch falls through to \`batch interrupted or refused\` and the batch stays interrupted for as long as STOP exists; on main the profiled path reached runTrain, whose guards refuse unintegrated members and reconcile integrated ones, which is exactly the resumed-STOP behaviour commit e21e2b16 restored only for unprofiled batches in lanes/lane.mjs, and no gate-profile test covers a resumed profiled batch under STOP; Fix: give profiled batches the same rule as lanes/lane.mjs, for example by having host-gate treat PROMOTION\_STOPPED as non-refusing when the receipt has attempts so the train's guarded reconciliation runs (or by having performBatch complete STOP refusals and reconcile integrated attempts when host.code is PROMOTION\_STOPPED), and add a test-slot/test/gate-profile.test.mjs case mirroring \`resuming prepared capture refuses stop input and drains the remaining lanes\` for a declared profile.

## Re-executed
```json
[]
```

## Non-claims
- The supplied gate is inherited evidence; this review does not claim tests passed.
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.

## Unverified
- Test evidence not re-executed: test-slot/test/gate-profile.test.mjs.
- Test evidence not re-executed: promote/test/train.test.mjs.
- Test evidence not re-executed: promote/test/memory-gate.test.mjs.
- Test evidence not re-executed: promote/test/promote.test.mjs.
- Test evidence not re-executed: test/memory.test.mjs.
- Report record-check validation not independently executed.
- The full promote run at e21e2b16 exited 1 on the stale worker lock fixture teardown; the report attributes it to an inherited ORG\_DIR and supplies a sanitized 24 of 24 rerun of that file, but that environmental attribution was not independently reproduced under the zero-command budget.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
