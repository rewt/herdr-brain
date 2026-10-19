**PASS**
Schema: lane-review/v1
Reviewed commit: 0dcd2bdd10c2aa3d34b0c243ce71da62c94f87eb
Topic: archival-retirement
Round: 1
Review ID: lr-e5d8561fbcd6c7cb0a3f1c8ddb35ea32
Base branch: main
Base commit: 264dc43c88bfefd5d5becd775ec242198ba2e6fd

## Findings
- [Minor] lib/retire-runtime.mjs:802 - sweepIntegratedLanes enables archival inventory probes from the policy alone, so while the canonical retirement HOLD is present every clean unmerged lane still runs rev-parse, shallow, replace and graft probes, rev-list and git cherry before integratedLaneDecision keeps it for the hold, which falls short of the ask that probes run only when there is no other keep reason; Fix: pass archivalRetirement as policy enabled and hold() returning no reason, and extend the recorded-command test to cover a present hold
- [Minor] lib/retire.mjs:697 - archivalHistorySummary drops observation.error, so after this commit a keep row for an incomplete observation (shallow or rewritten history, git failure, malformed cherry output) logs only that the observation is incomplete and no longer records why, whereas the previous full observation carried the cause; Fix: include a bounded error field in the summary, for example the first 200 characters of observation.error when it is a string, and assert it in the bounded-summary test

## Re-executed
```json
[]
```

## Non-claims
- The supplied gate is inherited evidence; this review does not claim tests passed.
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.

## Unverified
- Test evidence not re-executed: test/retire-archive.test.mjs
- Test evidence not re-executed: test/retire-status.test.mjs
- Test evidence not re-executed: test/retire-followups.test.mjs
- Report record-check validation not independently executed.
- The worker report cites seven focused files and evidence files (validation.json and two TAP logs) outside the lane; the inherited settle log states there is no worker validation receipt at the captured tree, and those evidence files were not inspected.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
