**PASS**
Schema: lane-review/v1
Reviewed commit: 2f4ef2b2f494cdb49616326deb280de272e1d464
Topic: lane-token
Round: 1
Review ID: lr-3f4e27a478229f31682eff38f26e7745
Base branch: main
Base commit: 2a040174254cba42dc15356258192370d0fc17a5

## Findings
None

## Re-executed
```json
[]
```

## Non-claims
- The supplied gate is inherited evidence; this review does not claim tests passed.
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.

## Unverified
- Report record-check validation not independently executed.
- Test evidence not re-executed: test/retire-initial-shell.test.mjs.
- Test evidence not re-executed: test/retire.test.mjs.
- Test evidence not re-executed: test/lane-removal.test.mjs.
- Test evidence not re-executed: test/retire-paths.test.mjs.
- Settle records no worker validation receipt bound to the captured tree; the worker-supplied run log shows 511 entries with zero failures, cancellations or skips and lists every new claimed-receipt case, but its binding to commit 2f4ef2b was not independently established.
- Live release of the two claimed-receipt target lanes (session-release w3GM:t1 and setup-cli w3GP:t1) and the receipt-less contracts-registry lane depends on live Herdr panes, the canonical record and Git state that this review did not observe; in particular it requires each worker run to carry a stored identity matching both the creation pane and terminal.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
