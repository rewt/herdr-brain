**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: ecea92be9abd441f7bb864668d9c1f26b83bd115
Topic: adopt-reentry
Round: 1
Review ID: lr-fad507b3fb564d7e0fc0dab59d0cefba
Base branch: main
Base commit: da141c10f07e2e447eedb8e52a0bde5ddb45dbaa

## Findings
- [Major] lib/config-home.mjs:302 - Completing a re-adoption makes every historical config.changed count as a publication again. If a rolled-back lane policy and its repo source are now absent, the new scope publishes no lane file and read-back accepts the incomplete binding, but setting adoption.completed makes the next lane read throw published home file is missing based on the old operation. Adoption returns success with broken route resolution; Fix: scope lost-file detection to publications belonging to the current binding and subsequent config writes, preserve holds for their lost files, and add a completed re-adoption regression with an audited old policy whose current source is absent.
- [Moderate] lib/adopt-command.mjs:324 - Refusal cleanup removes every preparation directory before releasing the controller lease. With a shared config and fleet root, a conflicting fleet file arriving after directory preparation makes the locked preflight refuse and leaves that root nonempty. rmdirSync then throws ENOTEMPTY and skips release(), stranding controller.lock and holding later adoption and reconciliation even after the fleet conflict is repaired. The existing arrival test stores the fleet elsewhere; Fix: preserve preparation directories that became nonempty, release the observer and controller lease through independent finally blocks, and add a shared-root arrival regression asserting external bytes survive and no lease remains.

## Re-executed
```json
[]
```

## Non-claims
- The supplied gate is inherited evidence; this review does not claim tests passed.
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.

## Unverified
- Test evidence not re-executed: test/adopt-reentry.test.mjs.
- Test evidence not re-executed: test/config-home.test.mjs.
- Test evidence not re-executed: test/adopt-worktrees.test.mjs.
- Test evidence not re-executed: test/adopt.test.mjs.
- Test evidence not re-executed: test/closeout.test.mjs.
- Test evidence not re-executed: test/fixture-lifetime.test.mjs.
- Test evidence not re-executed: test/fleet.test.mjs.
- Test evidence not re-executed: test/handoffs.test.mjs.
- Test evidence not re-executed: test/release-manifest.test.mjs.
- Test evidence not re-executed: test/release-pin-precheck.test.mjs.
- Test evidence not re-executed: test/release-pins.test.mjs.
- Test evidence not re-executed: test/retire-initial-shell.test.mjs.
- Test evidence not re-executed: test/retire-paths.test.mjs.
- Test evidence not re-executed: test/retire-status.test.mjs.
- Test evidence not re-executed: test/retire.test.mjs.
- Test evidence not re-executed: test/run-ownership.test.mjs.
- Test evidence not re-executed: test/session-lifecycle.test.mjs.
- Test evidence not re-executed: test/session-live.test.mjs.
- Test evidence not re-executed: test/session-reconciler.test.mjs.
- Test evidence not re-executed: test/sessions.test.mjs.
- Test evidence not re-executed: test/setup-apply.test.mjs.
- Test evidence not re-executed: test/setup.test.mjs.
- Test evidence not re-executed: test/formats.test.mjs.
- Test evidence not re-executed: test/compat.test.mjs.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
