---
run: R-324
outcome: done
summary: |
  Resolved all eight independent-review findings. Healthy clocks are keyed by project, tier and command fingerprint; timeout outcomes reach supervisor status, digest and guarded retry; group guards recover confirmed dead owners; nested gates preserve legacy PGID liveness; leftover groups fail distinctly after bounded cleanup; multi-lane batch timeouts no longer blame each lane; host and release limits use canonical layered validation settings.
  Focused offline tests passed across final runs and documented host reruns. Implementation and evidence are committed in 67f157a. This report is checked and committed before the required final fast lane check, after which the run stops.
headline: Gate watchdog review fixes preserve legacy locking and safe timeout recovery
blockers: []
proposals: []
learnings:
  - 'Legacy bch-cloak slot readers inspect only holder PID and PGID, so nested commands must share the holder group; a separate groups map cannot preserve interoperability.'
  - 'Narrow and full commands can share a validation tier. Duration and silence history must also match the exact command fingerprint.'
  - 'Healthy watchdog polling must avoid native process-source execution and hashing. Take the descendant snapshot when cancelling, rather than polling it during healthy gates.'
artifacts:
  - 'Implementation commit: 67f157a'
  - 'Branch: lane/gate-watchdog'
  - test-slot/test/watchdog.test.mjs
  - test-slot/test/gate-profile.test.mjs
  - docs/reports/evidence/ENG-274-R324/
  - docs/reports/ENG-274-gate-watchdog-R-324.md
  - /Users/rewt/development/rewt/.org/runs/R-324/report.md
  - '.lane/gate.json: final fast lane-check receipt, written by the final command'
decisions:
  - text: Preserve the shared legacy command group for nested gates and signal only their birth-confirmed parent-walk descendants.
    category: tooling
    why: Supervisor direction requires interoperability with activated legacy readers that understand only holder PID and PGID.
  - text: Give leftover groups a one-second post-exit grace, then stop owned processes and exit 123 with GATE_LEFTOVER_GROUP after confirmed cleanup.
    category: tooling
    why: Background leftovers are a distinct command failure and must neither wait for the wall limit nor report success.
  - text: Create group guards from complete owner bytes with an exclusive hard link and recover only a confirmed dead owner.
    category: tooling
    why: This avoids the empty-owner crash window between exclusive creation and writing and preserves fail-closed handling of live or unknown owners.
questions: []
challenges: []
---

Every finding in docs/reviews/gate-watchdog/9a7bd0f-r1.md and the supervisor
addendum is addressed:

1. Timing history uses separate files and a checked fingerprint for each tier
   and exact command argument array. Twenty narrow samples cannot evict or
   shorten a full command's history. Unseen commands and older tier-only records
   use 4500 seconds with idle checking off. The supplied full-gate maximum still
   derives 4316 seconds (71m56s); the wall/idle floors remain 600/300 seconds.
2. Supervisor status treats timeout as blocked work, and digest includes timeout
   promotion notices even after delivery.
3. Supervisor retry accepts confirmed timeout receipts with all existing lane,
   run, head and record bindings intact. A mismatched timeout head still refuses.
4. Group guards record owner PID, start and kernel birth before publication.
   Confirmed dead owners recover with TEST_SLOT_GUARD_RECOVERED naming the path;
   live or unknown owners retain the guard with TEST_SLOT_HOLDER_UNKNOWN.
5. Nested commands remain in the holder group. Tests kill both wrappers while a
   nested command survives, confirm the legacy PGID stays live, and reject a new
   slot taker. A nested watchdog test confirms a sibling in that shared group
   survives while the gate's own descendants stop.
6. The wrapper observes command exit separately from pipe closure, allowing a
   bounded grace even when background processes retain stdout/stderr. Leftovers
   stop with TERM/grace/KILL, release the slot after confirmed cleanup, exit 123,
   emit GATE_LEFTOVER_GROUP, and add no healthy sample or load retry. Tests cover
   inherited and ignored pipes. Unavailable cleanup identity retains the slot.
7. Singleton timeouts still isolate correction. Two-lane timeouts say batch
   timed out and permit re-enqueue individually, without automatic bisection,
   replay, or main changes.
8. Host and release envelopes query the lane CLI's canonical layered validation
   settings, including lane-only wall and idle declarations. Tests cover a
   5000-second promotion setting, release wall enforcement from lane config,
   and an actual host idle receipt that says no-output rather than wall-clock.

The README states the accepted limitation: descendants double-forked to init
before the pre-signal snapshot are outside the parent walk; ENG-275 provides the
reclaim backstop. No bch-cloak files or contrib/settle-watch.mjs were changed.

Focused evidence is retained as gzip logs under
`docs/reports/evidence/ENG-274-R324/`. Commands and final results:

- `node --test test-slot/test/watchdog.test.mjs`: 16 passed.
- `node --test supervisor/test/status.test.mjs test/digest.test.mjs`: 22 passed.
- `node --test --test-name-pattern='supervisor retries a confirmed timeout|refusal retry cannot authorize' supervisor/test/supervisor.test.mjs`: 2 passed, 21 intentionally skipped.
- `node --test --test-concurrency=1 test-slot/test/test-slot.test.mjs test-slot/test/conformance.test.mjs lanes/test/validation.test.mjs promote/test/conformance.test.mjs release/test/release.test.mjs`: 108 passed, 3 environment-dependent failures. The test-slot, conformance and promote conformance cases passed. Two validation cases failed with sandbox EMFILE file-watcher errors; the release CLI slot-deferral case returned exit 0 instead of 75 in the sandbox, alongside native-memory probe restrictions. Their unchanged final reruns below passed outside the sandbox.
- `node --test lanes/test/validation.test.mjs test-slot/test/gate-profile.test.mjs`: 28 passed outside the sandbox with scratch slots and local socket/PTY fixtures.
- `node --test release/test/release.test.mjs`: 26 passed outside the sandbox, including the new canonical lane-config regression.
- `node --test --test-name-pattern='host envelope honors' test-slot/test/gate-profile.test.mjs`: 1 passed, 11 intentionally skipped, outside the sandbox. This new case was added after the 28-case run above.

Earlier development failures were corrected before these final runs, including
removing native process polling that violated the existing conformance contract.
No npm test, promotion tier, release tier, live acceptance harness, model call,
or real host test slot was used. All gate fixtures used scratch slot paths.

The required sequence is implementation commit, this report, record check,
report commit, then `node lanes/lane.mjs check` as the final operation. That last
command uses the worker-default fast tier; its receipt is the final validation
evidence and is not claimed as already executed by this pre-check report.
