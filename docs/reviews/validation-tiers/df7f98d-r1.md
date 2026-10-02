**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: df7f98da3054f0dcf8d4c899d425f8055ae92084
Topic: validation-tiers
Round: 1
Review ID: lr-bf4d8598ab2aef4d9021bb6cde0fd638
Base branch: main
Base commit: ec20c67dcc4e1bb203a0e1cc133933454116d8eb

## Findings
- [Major] lanes/validation.mjs:51 - The fingerprint includes HERDR\_PANE\_ID, HERDR\_TAB\_ID and HERDR\_WORKSPACE\_ID, but the promotion queue explicitly removes these variables. Validation inherited from a supervisor pane therefore misses the cache again at queued promotion for the same tree and command, and separate worker and supervisor panes also get different keys solely from session metadata; Fix: normalize these coordination variables consistently for validation execution and fingerprinting, and add an offline worker-to-settle-to-queue reuse test with distinct pane identities.
- [Moderate] lanes/validation.mjs:36 - A project with package.json, a Node test directory and no scripts.test now defaults to npm test. Native entry previously fell back to node --test for this case, but the new resolver supplies a nonempty command that bypasses that fallback, so previously supported projects cannot check or promote without adding configuration; Fix: inspect whether the package actually declares a test script before choosing npm test, preserve the Node test-directory fallback, and cover this undeclared-project case through entry.
- [Moderate] discovery/runtime.mjs:202 - Declared promotion commands are routed through the existing 120-second native lifetime, 145-second wrapper and 180-second broker limits without a tier-specific bound. The newly declared repository promotion workload already exceeds the native lifetime in the supplied measurements, so native entry cannot complete that workload; the proposed follow-up leaves this integration incomplete; Fix: thread an explicit bounded promotion timeout through the native owner, wrapper and broker, preserving confinement and descendant cleanup, and add offline coverage for a longer declared promotion command.

## Re-executed
```json
[]
```

## Non-claims
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.

## Unverified
- Required captured-head offline validation remains unresolved: inherited npm test exited 1 because the lost lane-head update recovery scenario returned a null child exit status instead of 1. The zero-command budget permits no diagnosis by execution, rerun, or mutation witness to establish the missing recovery evidence.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
