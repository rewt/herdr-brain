**PASS**
Schema: lane-review/v1
Reviewed commit: c3f8ccb412c3a288a3ba64f7e0112457708029d4
Topic: gate-watchdog
Round: 1
Review ID: lr-d43e26d97494ab50fa63d9437e42e424
Base branch: main
Base commit: d95662006f8cfdb19cfda3e035a073abf1ab092a

## Findings
- [Minor] test/helpers/gate-history.mjs:53 - The exit guard now fails only for real-history samples carrying this process tree's origin token, but the token travels in the same environment as MONITOR\_GATE\_HISTORY\_ROOT, so the most likely leak class (a descendant launched with a rebuilt minimal environment and no fixture-policy preload, for example a plain node --test run spawning a gate with env containing only PATH) loses both the root and the origin and its leaked sample is reported only as a non-failing diagnostic, a narrower guarantee than the original ask's guard that fails when a test run creates or modifies the real history; Fix: also fail on unattributed samples that are provably test-owned, for example have isolateGateHistory record the set of real history file names and fingerprints at import and fail when a new unattributed sample's command references a scratch root under the OS temp directory or this process's history root, or have isolateGateHistory install the same root-and-origin re-injection that fixture-policy applies so plain runs cannot drop either field, and add a negative control for a stripped-environment descendant.
- [Minor] test/helpers/gate-history.mjs:57 - Every test process that imports the helper prints TEST\_GATE\_HISTORY\_DIAGNOSTIC to stderr whenever the shared real history holds any file, which after this lane merges is the normal state of the canonical common directory, so each promotion and release suite file emits a diagnostic line that carries no signal and dilutes a real leak report; Fix: emit the other-origin diagnostic only when the real history gained or changed files relative to an import-time list of file names and mtimes, or only when an opt-in debug variable is set.

## Re-executed
```json
[]
```

## Non-claims
- The supplied gate is inherited evidence; this review does not claim tests passed.
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.

## Unverified
- Test evidence not re-executed: test-slot/test/watchdog.test.mjs.
- The 309-test plain and outer-slot totals and the real-history-absent lines were read from the committed gzip evidence logs; the runs themselves were not reproduced because the review budget authorizes zero commands.
- The full-gate numbers (promotion about 10 minutes, release adapter about 30 minutes, bch-cloak about 39 minutes) remain inherited clocks from the ask and earlier evidence; no fresh real promotion, release or bch-cloak gate was timed by this review.
- Main has moved from the lane base to the current base branch head, and both sides changed promote/promote.mjs; whether the lane still rebases cleanly was not checked because a trial merge would write Git objects and is left to the promotion queue.
- The stripped-environment leak blind spot in the first finding was derived from code reading of the guard, fixture-policy containedEnv and the test spawn sites; it was not reproduced.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
