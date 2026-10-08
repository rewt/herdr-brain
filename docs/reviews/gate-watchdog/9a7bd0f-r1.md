**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: 9a7bd0f9e0242c97133c5579ea2a1650d3404f1a
Topic: gate-watchdog
Round: 1
Review ID: lr-98a0247e59d049d5a14a911efa6224f0
Base branch: main
Base commit: da07cc67d049f0bb44f02ffcf136c3b6c47b53d8

## Findings
- [Major] test-slot/limits.mjs:40 - Derived wall and idle limits use every healthy sample for the project and tier regardless of command, so narrow promotions (LANE\_VALIDATE narrows the promotion tier in resolveValidation, and the ask notes narrow promotions take under a minute) share history with full gates; after a run of narrow samples the promotion wall limit falls to the 600 s floor and the idle limit to 300 s (the new watchdog test asserts exactly this), and the next healthy 31 to 36 minute full gate is killed as GATE\_TIMEOUT and its lane isolated; Fix: key history by tier plus a command fingerprint (or filter samples to the current command) and fall back to the conservative default when the current command has no samples, with a test that narrow samples never shorten a full gate's limit
- [Major] supervisor/status.mjs:119 - The new queue outcome \`timeout\` is not recognized by consumers: status treats only refused and interrupted jobs as blocked, so a timed-out lane is shown at stage train instead of returning as a fix round, and lib/digest.mjs line 60 keeps only promoted and refused promote-queue notices, so timeout notices never reach the digest; Fix: treat \`timeout\` as blocked in supervisor status and include it in the digest promotion filter, with tests for both
- [Moderate] supervisor/supervisor.mjs:171 - Promotion retry accepts only a confirmed refused queue job, so a lane whose gate timed out (now outcome \`timeout\`) cannot be retried through the supervisor after its fix round although promote enqueue was changed to allow re-enqueue after a timeout; Fix: accept \`timeout\` alongside \`refused\` in the retry binding check and cover it with a test
- [Moderate] test-slot/test-slot.mjs:206 - The new groups-lock guard is created with an exclusive open and is never broken by age or owner liveness; a wrapper SIGKILLed inside updateHolder (plausible when an outer watchdog sends KILL one second after TERM while a nested wrapper is releasing) strands the guard, after which every later setGroup on that host slot throws EEXIST outside the identity try block, so every gate on the host fails until someone removes the file by hand, and stale-lock takeover does not clear it; Fix: write the owner pid and birth into the guard and break it only when that owner is confirmed gone (or reuse the existing takeover-guard recovery), and emit a coded diagnostic naming the guard path instead of a raw EEXIST
- [Moderate] test-slot/test-slot.mjs:395 - Nested runs are now spawned detached into their own groups and recorded only in the new holder \`groups\` map, but the shared legacy lock is also read by bch-cloak's test-slot, whose holderState checks only pid and pgid; when an outer wrapper and its group die (for example an operator group kill), a surviving nested gate group no longer keeps the slot live for bch-cloak, which can take over and overlap, whereas before this change nested commands stayed in the holder group; Fix: keep nested commands in the holder group when sharing the legacy lock (apply the watchdog to them through the parent walk) or otherwise keep the holder pgid live while nested groups run, and document the compatibility boundary
- [Moderate] test-slot/test-slot.mjs:447 - After the command closes, the wrapper now waits without bound while any member of its group survives, so a gate that exits 0 but leaves a background group member stalls until the wall limit (default 75 minutes) and is then reported as GATE\_TIMEOUT exit 124 and isolated; previously it returned within one second with the lock retained, and test-slot/README.md still states that such a command retains the lock and cannot report success; Fix: keep a short bounded post-exit grace, then stop the remaining owned group and report a distinct leftover-group failure (not a gate timeout), and update the README sentence and add a test for this case
- [Minor] promote/train.mjs:289 - A timed-out multi-lane batch marks every member as \`timeout\` with reason lane isolated for correction, sending innocent lanes back for correction although nothing isolated them; Fix: mark only singleton candidates as isolated timeouts and give multi-lane members a batch-timeout reason that allows plain re-enqueue (or requeue them singly), and test the two-lane case wording
- [Minor] promote/host-gate.mjs:89 - The lifecycle envelope resolves inner limits with resolveValidation without the canonical lane config, so a \`validation.timeout\_seconds\` declared only in lane configuration is ignored there and the envelope can be shorter than the inner configured limit; the host receipt reason also always says wall-clock even for an idle overrun; Fix: resolve the envelope from the same validation settings the train uses (and likewise in release/release.mjs) and derive the reason from gate\_timeout kind

## Re-executed
```json
[]
```

## Non-claims
- The supplied gate is inherited evidence; this review does not claim tests passed.
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.

## Unverified
- Test evidence not re-executed: test-slot/test/watchdog.test.mjs
- Test evidence not re-executed: test-slot/test/conformance.test.mjs
- Test evidence not re-executed: test-slot/test/test-slot.test.mjs
- Test evidence not re-executed: lanes/test/validation.test.mjs
- Test evidence not re-executed: promote/test/conformance.test.mjs
- The inherited fast-tier log covers 16 files and none of the new watchdog, test-slot, validation, promote conformance or release tests, so the report's focused-run counts are unsupported by supplied evidence.
- Escaped descendants whose intermediate parent exited before the pre-signal snapshot (double-fork daemons reparented to init) are outside the parent walk; whether this matches the ENG-1007 vitest topology was not established.
- Report record-check validation not independently executed.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
