**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: c1ba71ba6eedc00839686ddf7e568f8429dbe183
Topic: closer-landed
Round: 1
Review ID: lr-1cda01516011f940ac9ddfb1e4e9f71b
Base branch: main
Base commit: 7174d4c7dc90c213dbdf741029ddd9aafc5e56d8

## Findings
- [Moderate] lib/closeout.mjs:40 - The new default routes \`sweep --lane\` through \`recoverLane\`, which still selects \`landed\` for an open item and requires ancestry. A clean, vacant patch-integrated lane or exact-archive-tagged superseded lane without an existing removal request is therefore refused even though status marks it releasable. Queue ownership also disables the scheduled sweep, and the new tests exercise these proofs directly through the adapter instead of this default CLI path; Fix: make named recovery and the queue consumer carry and freshly validate patch-integration or exact-tip archive proofs instead of applying the ancestry-only \`expectedTip\` requirement, and add default-policy CLI regressions for both cases.

## Re-executed
```json
[]
```

## Non-claims
- The supplied gate is inherited evidence; this review does not claim tests passed.
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.

## Unverified
- Test evidence not re-executed: housekeeping/test/auto-tidy.test.mjs.
- Test evidence not re-executed: housekeeping/test/housekeeping.test.mjs.
- Test evidence not re-executed: promote/test/promote.test.mjs.
- Test evidence not re-executed: test/closeout.test.mjs.
- Test evidence not re-executed: test/lane-removal.test.mjs.
- Test evidence not re-executed: test/retire-archive.test.mjs.
- Test evidence not re-executed: test/retire-exits.test.mjs.
- Test evidence not re-executed: test/retire-followups.test.mjs.
- Test evidence not re-executed: test/retire-initial-shell.test.mjs.
- Test evidence not re-executed: test/retire-paths.test.mjs.
- Test evidence not re-executed: test/retire-status.test.mjs.
- Test evidence not re-executed: test/retire-sweep.test.mjs.
- Test evidence not re-executed: test/retire-triggers.test.mjs.
- Test evidence not re-executed: test/retire.test.mjs.
- Test evidence not re-executed: test/session-reconciler.test.mjs.
- Test evidence not re-executed: test/session-release.test.mjs.
- Test evidence not re-executed: test/sessions.test.mjs.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
