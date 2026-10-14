**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: 8dbcf3c8c5358c768205af4e2acac96bd3fc2754
Topic: verify-queue
Round: 1
Review ID: lr-04142a630a969fc7b9386d4d0a0034b4
Base branch: main
Base commit: fa25bbaa244f38b0ca723c39bdc0021b3c2cf751

## Findings
- [Major] verify/verify.mjs:279 - Receipts that the runner never wrote are accepted and delivered as execution evidence: drain treats any receipt.json already present for an admitted job as published, and recover (line 314) delivers a receipt for every job row including never-admitted, never-started pending jobs; published only checks schema, job ID and admitted\_spec\_sha256 against jobDigest of the queue row, all of which a submitter can read or compute from the same writable state directory that motivated the round-1 Major, so a lane can plant a pass receipt under jobs/ID/ while its admitted job waits behind earlier jobs (or for a pending job before any recover, or during execution so the runner's exclusive create fails with EEXIST and recovery then delivers the planted bytes) and the item receives a plain note and the supervisor a notice reporting outcome=pass for a command that never ran, bypassing admission and the one-runner-written-receipt rule; Fix: in drain refuse with runner.error any receipt that exists before this worker performed the job (admit already refuses jobs with receipts, so no legitimate path reaches that branch), in perform record the receipt sha256 on the job row immediately after the exclusive write, have recover deliver only receipts for jobs with started\_at, a matching admission and a matching recorded receipt sha256 while reporting any other receipt as unverified without a note or notice, and add fixtures planting a forged pass receipt for a pending job, for an admitted queued job and during execution that prove no note or notice is delivered and the job is not marked completed.

## Re-executed
```json
[]
```

## Non-claims
- The supplied gate is inherited evidence; this review does not claim tests passed.
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.

## Unverified
- Test evidence not re-executed: verify/test/verify.test.mjs
- Test evidence not re-executed: test/tier-plan.test.mjs
- Test evidence not re-executed: test/suite.test.mjs
- Report record-check validation not independently executed.
- Runtime behaviour of the argv-carried admission snapshot, worker exception handling and recover command was reviewed from code and fixtures only; no fixture was executed under the zero-command budget.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
