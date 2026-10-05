**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: fc8a6de4a23064890025d75a77cfea441d19caca
Topic: gate-profile
Round: 3
Review ID: lr-7c382bb026573cf227ad483200f0044f
Base branch: main
Base commit: 72ed7a9eea3518c2e9551d16488db4af8393c954

## Findings
- [Moderate] test-slot/test/gate-profile.test.mjs:38 - Every fixture declares an external lock and the new suite unconditionally invokes zsh, so the mandatory test:slot gate now fails on supported Linux hosts without zsh even for projects that do not use the optional bridge; Fix: use profiles without external\_lock for general cases and explicitly skip only real kernel-lock cases when the required zsh executable or module is unavailable.
- [Minor] promote/promote.mjs:182 - A capped guard wait on a resumed batch reaches the generic interruption handler, which omits host\_receipt, so interrupted queue results and notices lose the direct host receipt link promised by the report; Fix: propagate the stable host receipt path into interrupted per-lane results and notices while preserving recovery checkpoints and notice identity.

## Re-executed
```json
[]
```

## Non-claims
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.
- The captured HEAD has no usable lane gate; promotion-tier CI is deferred to the integration batch.
- The saved real-project rehearsal records a completed gate and refused integration, not a successful real-project fast-forward.

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
