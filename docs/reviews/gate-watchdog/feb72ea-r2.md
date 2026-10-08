**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: feb72ea138c51f579b32ff4768bda73a46a93808
Topic: gate-watchdog
Round: 2
Review ID: lr-e5e96fae7b71f72a842506b1fa2dfa2d
Base branch: main
Base commit: d95662006f8cfdb19cfda3e035a073abf1ab092a

## Findings
- [Major] test/helpers/gate-history.mjs:29 - The exit guard fails any test process whenever the shared Git common-directory gate-watchdog directory differs from its import-time snapshot, but after this lane merges that directory is legitimately written by every successful real gate sharing the common directory (lane check fast-tier validateTree via runGateSync, nested test-slot wrappers, promotion and release gates); merge-batch scratch trees and all lane worktrees share it, so a lane check finishing in any lane during a promotion or release suite flips the snapshot (new file, changed bytes, directory mtime, transient .history.lock) and every live test process exits 1 with TEST\_GATE\_HISTORY\_LEAK, turning unrelated concurrent activity into red merge batches and spurious bisections, the same failure class this correction is meant to remove; Fix: attribute leaks instead of diffing the whole shared directory, for example have isolateGateHistory export an inherited per-run origin token that recordHealthyGate stamps into each sample and fail only when real history gains a sample carrying this process tree's token (report other changes as a non-failing diagnostic), and add a regression where a concurrent non-test writer updates the real-identity history while a guarded process runs without failing it.
- [Minor] test-slot/test/watchdog.test.mjs:348 - The fixture-gate regression asserts the entire real common-directory history snapshot is unchanged across a spawned run, so it inherits the same race and fails whenever a legitimate concurrent gate records a sample during the test; Fix: assert instead that the fixture's own history key file exists only under the scratch root and that no real-history file contains this fixture's command fingerprint, leaving whole-directory equality out of the assertion.

## Re-executed
```json
[]
```

## Non-claims
- The supplied gate is inherited evidence; this review does not claim tests passed.
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.

## Unverified
- Test evidence not re-executed: test-slot/test/watchdog.test.mjs.
- Test evidence not re-executed: test-slot/test/gate-profile.test.mjs.
- Test evidence not re-executed: release/test/release.test.mjs.
- The concurrent-writer false positive in the Major finding was derived from code reading of the guard, validateTree and recordHealthyGate; it was not reproduced because the review budget authorizes zero commands.
- The real-gate numbers in the report and README (promotion 7 to 10 minutes, release adapter 20 to 30 minutes, bch-cloak up to 39 minutes) are taken from the ask and earlier recorded clocks; no fresh real promotion, release or bch-cloak gate timing was observed by this review.
- Nested test-slot wrappers inside the promotion and release commands (labels such as test:promotion, test:release, test:core) derive limits under generic tiers with a 30 second sample floor and 600 second wall floor; the report's numbers table covers only the outer promotion and release tiers, and the adequacy of 2x the recent maximum for those nested keys under load variance was not independently assessed.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
