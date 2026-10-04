**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: ec200cde2eed9828616ee970ff85e93cdd4377a2
Topic: rollback-canary
Round: 1
Review ID: lr-1e4a54cfc9ba24e728f525066c80f5d9
Base branch: main
Base commit: 416612cacadd8bcec6db0f04b062adfc6c5087fa

## Findings
- [Major] acceptance/run.mjs:893 - The restored consumer targets the existing scratch supervisor, whose shaded Codex composer has no horizontal footer rules. The snapshot consumer's boxEmpty requires two such rules, so it always defers this report as input box busy: case 19 still times out and case 20 remains blocked. The new regression supplies a different, compatible footer and misses this mismatch; Fix: Render a legacy-compatible composer in the real scratch supervisor for the rollback canary, preserve the unchanged consumer and real PTY receipt checks, and add an offline regression using that same supervisor rendering for both empty and busy input.

## Re-executed
```json
[]
```

## Non-claims
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.
- Promotion CI and live release cases 19 and 20 remain deferred validation; no green result for those cases is claimed.

## Unverified
None

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
